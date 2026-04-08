#!/usr/bin/env node
// =============================================================================
// agent-comm file coordination hook
//
// Install in your Claude Code settings.json as both PreToolUse and PostToolUse
// matcher for Edit|Write|MultiEdit. Talks to a running agent-comm dashboard
// (default http://localhost:3421) to claim file locks via the REST cas
// endpoint and broadcast edit summaries to a shared world model.
//
// PreToolUse: claim the target file. If another agent holds the lock, BLOCK the
//   tool call (exit 2) with a message telling the agent who holds it. The model
//   then sees the block and can recover (call comm_send to coordinate, wait,
//   pick a different file, etc.).
//
// PostToolUse: release the claim and update the "files-edited" world model
//   namespace with a summary of who edited what and when.
//
// Identity: each agent should set AGENT_COMM_ID in its environment (the bench
// driver does this; for a real workflow you can set it in your shell rc or per
// terminal). Falls back to hostname-pid if unset.
//
// Failure mode: if agent-comm REST is not reachable, the hook fails OPEN (exits
// 0, allows the edit). Coordination is best-effort — never block real work just
// because the bus is down.
// =============================================================================

import { request } from 'node:http';
import { hostname } from 'node:os';
import { basename } from 'node:path';

const PORT = parseInt(process.env.AGENT_COMM_PORT ?? '3421', 10);
const HOST = process.env.AGENT_COMM_HOST ?? 'localhost';
const LOCK_NS = process.env.AGENT_COMM_LOCK_NAMESPACE ?? 'file-locks';
const FILES_NS = process.env.AGENT_COMM_FILES_NAMESPACE ?? 'files-edited';
const TTL = parseInt(process.env.AGENT_COMM_LOCK_TTL ?? '300', 10);
// Identity resolution order:
//   1. AGENT_COMM_ID env var (set explicitly by the user or driver)
//   2. CLAUDE_CODE_SESSION_ID if Claude Code provides one
//   3. hostname-ppid (the parent process — Claude Code itself — has a stable
//      pid for the lifetime of the session, so PreToolUse and PostToolUse for
//      the same edit see the same ppid)
const AGENT_ID =
  process.env.AGENT_COMM_ID ??
  process.env.CLAUDE_CODE_SESSION_ID ??
  `${hostname()}-${process.ppid || process.pid}`;
// Claude Code passes the hook event name as the first arg or HOOK_EVENT env var
// depending on version. Accept either.
const EVENT = process.argv[2] ?? process.env.CLAUDE_HOOK_EVENT ?? 'PreToolUse';

function call(method, path, body) {
  return new Promise((resolve) => {
    const data = body ? JSON.stringify(body) : null;
    const req = request(
      {
        host: HOST,
        port: PORT,
        path,
        method,
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

function urlEncode(s) {
  return encodeURIComponent(s);
}

async function preToolUse(filePath) {
  const r = await call('POST', `/api/state/${urlEncode(LOCK_NS)}/${urlEncode(filePath)}/cas`, {
    expected: null,
    new_value: AGENT_ID,
    updated_by: AGENT_ID,
    ttl_seconds: TTL,
  });
  // Fail-open on transport errors so a down dashboard never blocks real work.
  if (!r) return { allow: true };
  if (r.status === 200 && r.body?.swapped === true) return { allow: true };
  if (r.status === 200 && r.body?.swapped === false) {
    const holder = r.body.current?.value ?? 'unknown';
    return {
      allow: false,
      reason: `BLOCKED: agent-comm file lock held by "${holder}" on ${basename(filePath)}. Wait, coordinate via comm_send to that agent, or pick a different file. The lock auto-expires in ${TTL}s.`,
    };
  }
  // Unexpected response → fail open.
  return { allow: true };
}

async function postToolUse(filePath) {
  // Release the lock — best effort, ignore errors.
  await call('DELETE', `/api/state/${urlEncode(LOCK_NS)}/${urlEncode(filePath)}`, null);
  // Record the edit in the shared world model so other agents can see who
  // touched what when they query files-edited.
  await call('POST', `/api/state/${urlEncode(FILES_NS)}/${urlEncode(filePath)}`, {
    value: `${AGENT_ID}@${new Date().toISOString()}`,
    updated_by: AGENT_ID,
  });
}

async function main() {
  // Read JSON payload from stdin (Claude Code hook protocol).
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;

  let payload;
  try {
    payload = JSON.parse(raw || '{}');
  } catch {
    process.exit(0);
  }

  const tool = payload.tool_name ?? payload.name ?? '';
  const filePath = payload.tool_input?.file_path ?? payload.input?.file_path ?? '';
  if (!filePath || !/^(Edit|Write|MultiEdit)$/.test(tool)) {
    // Not a file-mutating tool we care about. Allow.
    process.exit(0);
  }

  if (EVENT === 'PreToolUse') {
    const result = await preToolUse(filePath);
    if (result.allow) process.exit(0);
    process.stderr.write(result.reason + '\n');
    process.exit(2);
  } else if (EVENT === 'PostToolUse') {
    await postToolUse(filePath);
    process.exit(0);
  } else {
    process.exit(0);
  }
}

main().catch(() => process.exit(0));
