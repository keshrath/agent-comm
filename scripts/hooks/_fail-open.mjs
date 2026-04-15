// =============================================================================
// agent-comm hook signals helper
//
// Every hook in this directory is intentionally fail-open: if it can't reach
// the dashboard/DB/etc. it exits 0 so user work is never blocked. The downside
// is that a hook which never fires is indistinguishable from a hook that
// silently fell open. This module adds an EXPLICIT signal to every hook
// without changing the fail-open / block behavior itself.
//
// Exports:
//   signalFailOpen(hook, reason, extra?) — when a hook gives up and allows the
//     tool call because the bus/dashboard is unreachable. Three signals:
//       1. stderr line AGENT_COMM_HOOK_FAIL_OPEN: {...}
//       2. comm_state counter POST /api/state/hook-fail-open/<hook>/cas
//       3. Optional JSONL trace file (AGENT_COMM_HOOK_TRACE[_FILE])
//
//   signalBlock(hook, payload) — when a hook ACTIVELY blocks a real conflict
//     (exit 2). This is the "prevented disaster" moment we want visible.
//     Three signals:
//       1. stderr line AGENT_COMM_HOOK_BLOCK: {...} (parallels fail-open line)
//       2. Activity feed entry via POST /api/feed (type:"hook-block")
//       3. Optional JSONL trace file (AGENT_COMM_HOOK_TRACE[_FILE], outcome
//          "block") so bench runs can aggregate blocks across agents.
//
// This module MUST NEVER throw — a failed signal cannot block the edit.
// =============================================================================

import { appendFileSync } from 'node:fs';
import { request } from 'node:http';
import { hostname } from 'node:os';

const PORT = parseInt(process.env.AGENT_COMM_PORT ?? '3421', 10);
const HOST = process.env.AGENT_COMM_HOST ?? 'localhost';

const AGENT_ID =
  process.env.AGENT_COMM_ID ??
  process.env.CLAUDE_CODE_SESSION_ID ??
  `${hostname()}-${process.ppid || process.pid}`;

const TRACE_FILE =
  process.env.AGENT_COMM_HOOK_TRACE_FILE ??
  (process.env.AGENT_COMM_HOOK_TRACE === '1'
    ? `${process.env.TEMP ?? process.env.TMPDIR ?? '.'}/agent-comm-hook-trace.log`
    : null);

// Short, best-effort REST call. Resolves null on any error.
function postJson(path, body, timeoutMs = 500) {
  return new Promise((resolve) => {
    try {
      const data = JSON.stringify(body);
      const req = request(
        {
          host: HOST,
          port: PORT,
          path,
          method: 'POST',
          family: 4,
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
          timeout: timeoutMs,
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      req.write(data);
      req.end();
    } catch {
      resolve(null);
    }
  });
}

/**
 * Emit an explicit fail-open signal for a hook.
 *
 * @param {string} hook   short hook name (e.g. "file-coord", "bash-guard")
 * @param {string} reason short machine-readable reason
 *                        (e.g. "dashboard-unreachable", "sqlite-missing")
 * @param {object} extra  optional additional fields merged into the JSON line
 *                        and trace entry
 * @returns {Promise<void>}
 */
export async function signalFailOpen(hook, reason, extra = {}) {
  const payload = { hook, reason, agent: AGENT_ID, ...extra };

  // 1. stderr — visible in Claude Code's notification surface. Claude Code
  //    surfaces hook stderr even when the hook exits 0, so this is the
  //    primary operator-visible signal.
  try {
    process.stderr.write(`AGENT_COMM_HOOK_FAIL_OPEN: ${JSON.stringify(payload)}\n`);
  } catch {
    // noop
  }

  // 2. Trace file — JSONL, machine-parseable.
  if (TRACE_FILE) {
    try {
      appendFileSync(
        TRACE_FILE,
        JSON.stringify({ ts: new Date().toISOString(), outcome: 'fail-open', ...payload }) + '\n',
      );
    } catch {
      // noop — trace is diagnostic, never blocks.
    }
  }

  // 3. comm_state counter — best-effort CAS loop. If the REST endpoint that
  //    we failed to reach earlier is still down, this will also return null
  //    and we silently skip. Counter lives in namespace "hook-fail-open",
  //    key = hook name, value = integer-as-string.
  try {
    const getPath = `/api/state/hook-fail-open/${encodeURIComponent(hook)}`;
    const getRes = await new Promise((resolve) => {
      const req = request(
        { host: HOST, port: PORT, path: getPath, method: 'GET', family: 4, timeout: 500 },
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
      req.end();
    });

    if (!getRes) return; // REST also down — acceptable fallback.

    // On a 404, treat current as null and swap with "1". On 200, parse current
    // and increment. We only make one CAS attempt — if it fails due to a race
    // another concurrent fail-open recorded the increment and we can drop ours.
    let expected = null;
    let next = '1';
    if (getRes.status === 200 && getRes.body) {
      const cur = getRes.body.value;
      expected = cur ?? null;
      const n = parseInt(cur ?? '0', 10);
      next = String(Number.isFinite(n) ? n + 1 : 1);
    }

    await postJson(
      `/api/state/hook-fail-open/${encodeURIComponent(hook)}/cas`,
      { expected, new_value: next, updated_by: AGENT_ID, ttl_seconds: 86400 },
      500,
    );
  } catch {
    // noop
  }
}

/**
 * Emit a block signal: a hook actively blocked a real conflict (exit 2).
 *
 * Three best-effort signals — if REST is down, the stderr line and trace
 * file still fire so the block is not silently swallowed.
 *
 * @param {string} hook    short hook name ("file-coord", "bash-guard")
 * @param {object} payload block metadata — at minimum { tool, target, reason };
 *                         file-coord adds holder_agent, bash-guard adds rule.
 *                         A timestamp and blocked_agent are filled in here.
 * @returns {Promise<void>}
 */
export async function signalBlock(hook, payload = {}) {
  const ts = new Date().toISOString();
  const full = {
    ts,
    hook,
    blocked_agent: AGENT_ID,
    ...payload,
  };

  // 1. stderr — parallels the AGENT_COMM_HOOK_FAIL_OPEN line format so one
  //    grep surfaces both fail-open and block events.
  try {
    process.stderr.write(`AGENT_COMM_HOOK_BLOCK: ${JSON.stringify(full)}\n`);
  } catch {
    // noop
  }

  // 2. Trace file — JSONL, same shape as file-coord trace.
  if (TRACE_FILE) {
    try {
      appendFileSync(TRACE_FILE, JSON.stringify({ outcome: 'block', ...full }) + '\n');
    } catch {
      // noop
    }
  }

  // 3. Activity feed entry. Use type "hook-block" and agent_id = blocked
  //    agent so the dashboard can render "prevented <tool> conflict on
  //    <target>, held by <holder>". Preview carries the JSON payload for
  //    machine parsing.
  try {
    // Serialize a compact preview (stays within feed preview length).
    const preview = JSON.stringify(full);
    const target = typeof payload.target === 'string' ? payload.target.slice(0, 240) : null;
    await postJson(
      '/api/feed',
      {
        agent: AGENT_ID,
        type: 'hook-block',
        target,
        preview,
      },
      500,
    );
  } catch {
    // noop — stderr + trace remain as fallback
  }
}
