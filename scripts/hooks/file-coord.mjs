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

// How long to poll for a lock to become free before giving up. The hook
// blocks the Claude tool call while polling, so this is also the max
// per-edit wait time. Tunable via env var.
//
// Default 10s — long enough that a typical sibling edit (read + edit + write
// + release ~1-5s) completes within one poll window, but short enough that
// agents waiting on a contended file fail fast and let the model react
// (try a different file, coordinate via comm_send, etc.) instead of burning
// the entire per-edit budget on a single lock wait.
const POLL_TIMEOUT_MS = parseInt(process.env.AGENT_COMM_POLL_TIMEOUT_MS ?? '10000', 10);
const POLL_INTERVAL_MS = parseInt(process.env.AGENT_COMM_POLL_INTERVAL_MS ?? '200', 10);

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function preToolUse(filePath) {
  // Poll the cas endpoint until either we acquire the lock, the dashboard
  // becomes unreachable (fail open), or we hit the poll timeout. This turns
  // the hook into a true blocking primitive — when there's a single shared
  // file with no alternative, sibling agents queue up rather than failing.
  //
  // Reentrancy: if the lock is currently held by US (same AGENT_ID), we
  // refresh the TTL and treat the acquisition as successful. This handles
  // the case where a prior PostToolUse failed to fire (Claude Code timeout,
  // crash, etc.) and the agent's own old lock would otherwise block its
  // next edit.
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let lastHolder = 'unknown';
  let transportFailed = false;
  while (Date.now() < deadline) {
    // First try the fresh-claim path: cas null → AGENT_ID
    const r = await call('POST', `/api/state/${urlEncode(LOCK_NS)}/${urlEncode(filePath)}/cas`, {
      expected: null,
      new_value: AGENT_ID,
      updated_by: AGENT_ID,
      ttl_seconds: TTL,
    });
    if (!r) {
      transportFailed = true;
      break;
    }
    if (r.status === 200 && r.body?.swapped === true) return { allow: true };
    if (r.status === 200 && r.body?.swapped === false) {
      lastHolder = r.body.current?.value ?? lastHolder;
      // Reentrant case: the holder is US. Refresh the TTL via a self → self
      // cas and proceed (the previous PostToolUse must have failed).
      if (lastHolder === AGENT_ID) {
        const refresh = await call(
          'POST',
          `/api/state/${urlEncode(LOCK_NS)}/${urlEncode(filePath)}/cas`,
          {
            expected: AGENT_ID,
            new_value: AGENT_ID,
            updated_by: AGENT_ID,
            ttl_seconds: TTL,
          },
        );
        if (refresh && refresh.status === 200 && refresh.body?.swapped === true) {
          return { allow: true };
        }
        // The lock was released between the two cas calls — loop again,
        // we'll grab it on the fresh-claim path next iteration.
      }
      // Held by someone else — wait and retry.
      await sleep(POLL_INTERVAL_MS);
      continue;
    }
    // Unexpected response — treat as transport failure (fail open).
    transportFailed = true;
    break;
  }
  if (transportFailed) {
    // Fail-open: agent-comm dashboard isn't reachable, never block real work.
    return { allow: true };
  }
  return {
    allow: false,
    reason: `BLOCKED: agent-comm file lock on ${basename(filePath)} still held by "${lastHolder}" after ${POLL_TIMEOUT_MS / 1000}s of waiting. The other agent may be stuck. Try again, coordinate via comm_send, or work on a different file.`,
  };
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
