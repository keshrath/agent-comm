#!/usr/bin/env node

// =============================================================================
// agent-comm PostToolUse hook
//
// After every tool call (except agent-comm's own tools), checks for unread
// messages and nudges the agent to call comm_inbox.
// Also periodically reminds agents to communicate (status updates, state).
// Silent when nothing to report.
// =============================================================================

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    // Skip nudge for agent-comm tools — agent is already interacting with comm
    if (data.tool_name && data.tool_name.startsWith('mcp__agent-comm__')) {
      console.log(JSON.stringify({}));
      return;
    }
  } catch {}

  const dbPath = join(homedir(), '.agent-comm', 'agent-comm.db');
  if (!existsSync(dbPath)) {
    console.log(JSON.stringify({}));
    return;
  }

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const msgRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM messages WHERE created_at > datetime('now', '-10 minutes')`,
      )
      .get();

    const agentRow = db
      .prepare(`SELECT COUNT(*) as cnt FROM agents WHERE status IN ('online', 'idle')`)
      .get();

    const pid = process.ppid || process.pid;
    const lastSent = db
      .prepare(
        `SELECT MAX(created_at) as last_msg FROM messages
         WHERE created_at > datetime('now', '-15 minutes')
         AND sender_id IN (SELECT id FROM agents WHERE pid = ?)`,
      )
      .get(pid);

    db.close();

    const parts = [];

    if (msgRow.cnt > 0) {
      parts.push(
        `You have unread messages (${msgRow.cnt} in last 10 min). You MUST call comm_inbox now.`,
      );
    }

    // If other agents are online and this agent hasn't communicated in 15 min, nudge
    if (agentRow.cnt > 1 && !lastSent?.last_msg) {
      parts.push(
        `${agentRow.cnt} agents online but you haven't communicated recently. Post a status update to "general" or set your status with comm_agents({ action: "status" }).`,
      );
    }

    if (parts.length > 0) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PostToolUse',
            additionalContext: parts.join(' '),
          },
        }),
      );
    } else {
      console.log(JSON.stringify({}));
    }
  } catch {
    console.log(JSON.stringify({}));
  }
});
