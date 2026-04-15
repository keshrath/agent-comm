#!/usr/bin/env node

// =============================================================================
// agent-comm PostToolUse hook — narrow signal only
//
// After a non-agent-comm tool call, surfaces ONLY directly-addressed unread
// messages OR unread messages at importance high/urgent. Silent for everything
// else (channel chatter, broadcasts, normal-priority noise).
//
// Bench B12 measured the prior version's broad nudge ("you have N messages in
// last 10 min, you MUST call comm_inbox") at a 0/3 pivot rate even when
// peer-sent STOP messages were successfully delivered to the inbox. The model
// treats injected advisory text as ignorable noise during focused work. The
// reformed signal here is narrower (drops broadcasts and normal-priority msgs,
// drops the "agents online but you haven't communicated" generic nudge) so
// when the hook DOES fire it correlates with a real, model-relevant event.
//
// For mid-flight peer pivots, the validated mechanism is `comm_poll` invoked
// by the agent's prompt contract (B15). This hook is best-effort
// supplementary surface, not a coordination guarantee.
// =============================================================================

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir, hostname } from 'os';
import { createRequire } from 'module';
import { signalFailOpen } from './_fail-open.mjs';

const AGENT_ID =
  process.env.AGENT_COMM_ID ??
  process.env.CLAUDE_CODE_SESSION_ID ??
  `${hostname()}-${process.ppid || process.pid}`;

const require = createRequire(import.meta.url);

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    if (data.tool_name && data.tool_name.startsWith('mcp__agent-comm__')) {
      console.log(JSON.stringify({}));
      return;
    }
  } catch {}

  const dbPath = join(homedir(), '.agent-comm', 'agent-comm.db');
  if (!existsSync(dbPath)) {
    signalFailOpen('check-inbox', 'sqlite-missing', { dbPath }).catch(() => {});
    console.log(JSON.stringify({}));
    return;
  }

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });

    // Resolve self by name → id. Sessions that never registered with
    // comm_register won't have a row, so selfId stays null and the directly-
    // addressed query returns 0. The high/urgent broadcast count still works
    // even for unregistered sessions.
    const selfRow = db.prepare(`SELECT id FROM agents WHERE name = ?`).get(AGENT_ID);
    const selfId = selfRow?.id ?? null;

    // 1. Directly-addressed unread messages (any importance) where this
    //    session is the recipient and didn't send the message itself. Excludes
    //    messages this session has already read (message_reads.read_at).
    const directRow = selfId
      ? db
          .prepare(
            `SELECT COUNT(*) as cnt FROM messages m
             WHERE m.to_agent = ?
             AND m.from_agent != ?
             AND NOT EXISTS (
               SELECT 1 FROM message_reads mr
               WHERE mr.message_id = m.id AND mr.agent_id = ?
             )
             AND m.created_at > datetime('now', '-30 minutes')`,
          )
          .get(selfId, selfId, selfId)
      : { cnt: 0 };

    // 2. High/urgent unread messages in joined channels (still scoped: only
    //    those this session can actually receive — i.e. in channels it joined
    //    OR addressed to it). Bounded recency so a long-lived session doesn't
    //    keep firing on stale urgent messages.
    const importantRow = selfId
      ? db
          .prepare(
            `SELECT COUNT(*) as cnt FROM messages m
             WHERE m.importance IN ('high', 'urgent')
             AND m.from_agent != ?
             AND (
               m.to_agent = ?
               OR m.channel_id IN (
                 SELECT channel_id FROM channel_members WHERE agent_id = ?
               )
             )
             AND NOT EXISTS (
               SELECT 1 FROM message_reads mr
               WHERE mr.message_id = m.id AND mr.agent_id = ?
             )
             AND m.created_at > datetime('now', '-30 minutes')`,
          )
          .get(selfId, selfId, selfId, selfId)
      : { cnt: 0 };

    db.close();

    const direct = directRow?.cnt ?? 0;
    const important = importantRow?.cnt ?? 0;

    if (direct === 0 && important === 0) {
      console.log(JSON.stringify({}));
      return;
    }

    const parts = [];
    if (important > 0) {
      parts.push(
        `${important} unread high/urgent message${important === 1 ? '' : 's'} for you. Call comm_inbox({ importance: "urgent" }) (or comm_poll) before continuing.`,
      );
    }
    if (direct > 0 && important === 0) {
      // Only mention plain direct messages when there's no urgent signal —
      // otherwise the urgent line is enough.
      parts.push(`${direct} unread direct message${direct === 1 ? '' : 's'} addressed to you.`);
    }

    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'PostToolUse',
          additionalContext: parts.join(' '),
        },
      }),
    );
  } catch (err) {
    signalFailOpen('check-inbox', 'sqlite-error', {
      error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
    }).catch(() => {});
    console.log(JSON.stringify({}));
  }
});
