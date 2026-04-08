// =============================================================================
// agent-comm hook helpers — shared REST + identity primitives
//
// Imported by hook scripts in this directory. Centralizes the noisy boilerplate
// (HTTP calls, identity resolution, age formatting, workspace detection) so
// individual hooks stay focused on their coordination logic.
//
// All functions fail-soft: a network error or unreachable dashboard returns
// null/empty rather than throwing. Hooks should never block real work because
// the bus is down.
// =============================================================================

import { request } from 'node:http';
import { hostname } from 'node:os';
import { createHash } from 'node:crypto';

const PORT = parseInt(process.env.AGENT_COMM_PORT ?? '3421', 10);
const HOST = process.env.AGENT_COMM_HOST ?? 'localhost';

export const AGENT_ID =
  process.env.AGENT_COMM_ID ??
  process.env.CLAUDE_CODE_SESSION_ID ??
  `${hostname()}-${process.ppid || process.pid}`;

export const FILES_NS = process.env.AGENT_COMM_FILES_NAMESPACE ?? 'files-edited';
export const LOCKS_NS = process.env.AGENT_COMM_LOCK_NAMESPACE ?? 'file-locks';
export const WORKSPACE_NS = process.env.AGENT_COMM_WORKSPACE_NAMESPACE ?? 'workspace-agents';

export function call(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = request(
      {
        host: HOST,
        port: PORT,
        path,
        method,
        // Force IPv4 — on Windows, Node's default localhost resolution can pick
        // ::1 first and fail with ECONNREFUSED if the dashboard binds only to
        // 0.0.0.0 (IPv4). curl handles this gracefully via fallback; Node's
        // http.request does not.
        family: 4,
        headers: data
          ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
          : {},
        timeout: 1500,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : null });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: null });
          }
        });
      },
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    if (data) req.write(data);
    req.end();
  });
}

export function workspaceHash(p) {
  return createHash('sha1').update(p).digest('hex').slice(0, 12);
}

export function ageString(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'recently';
  const ageMs = Date.now() - t;
  if (ageMs < 60000) return `${Math.round(ageMs / 1000)}s ago`;
  if (ageMs < 3600000) return `${Math.round(ageMs / 60000)}m ago`;
  return `${Math.round(ageMs / 3600000)}h ago`;
}

export function ageMs(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return Infinity;
  return Date.now() - t;
}

/** Read JSON payload from stdin with a deadline so the hook never hangs. */
export async function readStdinJson(timeoutMs = 500) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  await new Promise((resolve) => {
    let waited = 0;
    const id = setInterval(() => {
      waited += 50;
      if (waited >= timeoutMs) {
        clearInterval(id);
        resolve();
      }
    }, 50);
    process.stdin.on('data', (c) => (raw += c));
    process.stdin.on('end', () => {
      clearInterval(id);
      resolve();
    });
  });
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

/** List recent file-edits from comm_state and parse the file-coord encoding. */
export async function listFilesEdited() {
  const r = await call('GET', `/api/state?namespace=${encodeURIComponent(FILES_NS)}`, null);
  if (!r || r.status !== 200 || !Array.isArray(r.body)) return [];
  const out = [];
  for (const e of r.body) {
    if (!e || !e.key) continue;
    let file;
    try {
      file = decodeURIComponent(e.key);
    } catch {
      file = e.key;
    }
    let editor = e.value;
    let when = e.updated_at;
    const m = /^(.+)@(\d{4}-\d{2}-\d{2}T[^@]+)$/.exec(e.value || '');
    if (m) {
      editor = m[1];
      when = m[2];
    }
    out.push({ file, editor, when });
  }
  out.sort((a, b) => (b.when || '').localeCompare(a.when || ''));
  return out;
}

/** List active sessions in a given workspace. */
export async function listWorkspaceAgents(workspace) {
  const wsHash = workspaceHash(workspace);
  const r = await call(
    'GET',
    `/api/state?namespace=${encodeURIComponent(WORKSPACE_NS)}&prefix=${encodeURIComponent(wsHash + ':')}`,
    null,
  );
  if (!r || r.status !== 200 || !Array.isArray(r.body)) return [];
  const out = [];
  for (const e of r.body) {
    if (!e || !e.key) continue;
    let parsed = {};
    try {
      parsed = JSON.parse(e.value || '{}');
    } catch {
      /* ignore */
    }
    if (parsed.workspace && parsed.workspace !== workspace) continue;
    out.push({
      agent: parsed.agent || e.key.split(':').slice(1).join(':'),
      workspace: parsed.workspace || workspace,
      started_at: parsed.started_at,
      updated_at: e.updated_at,
    });
  }
  return out;
}

/** Normalize a path so backslashes become forward slashes and case is lowered
 * on Windows for safe comparison. */
export function normPath(p) {
  if (!p) return '';
  const slashed = p.replace(/\\/g, '/');
  return process.platform === 'win32' ? slashed.toLowerCase() : slashed;
}

/** Filter file-edits to those in or under the given workspace path. Case- and
 * separator-insensitive on Windows. */
export function filterEditsToWorkspace(edits, workspace) {
  const ws = normPath(workspace);
  return edits.filter((e) => {
    if (!e.file) return false;
    const f = normPath(e.file);
    return f.includes(ws) || f.startsWith(ws);
  });
}

/** Filter file-edits to those by agents OTHER than the given one. */
export function filterEditsByOthers(edits, selfId) {
  return edits.filter((e) => e.editor && e.editor !== selfId);
}
