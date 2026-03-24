#!/usr/bin/env node

// =============================================================================
// agent-comm UserPromptSubmit hook
//
// Two checks:
// 1. If no agents online → nudge registration
// 2. If agents online → check for recent messages and nudge inbox check
//
// Silent (empty JSON) when registered and no recent activity.
// =============================================================================

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

function check() {
  const dbPath = join(homedir(), '.agent-comm', 'agent-comm.db');
  if (!existsSync(dbPath)) return { registered: false, recentMessages: 0, onlineAgents: 0 };

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const agentRow = db
      .prepare(`SELECT COUNT(*) as cnt FROM agents WHERE status IN ('online', 'idle')`)
      .get();

    const msgRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM messages WHERE created_at > datetime('now', '-5 minutes')`,
      )
      .get();

    db.close();
    return {
      registered: agentRow.cnt > 0,
      onlineAgents: agentRow.cnt,
      recentMessages: msgRow.cnt,
    };
  } catch (err) {
    process.stderr.write(`[agent-comm hook] ${err.message}\n`);
    return null;
  }
}

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', () => {
  const result = check();
  if (!result) {
    console.log(JSON.stringify({}));
    return;
  }
  const { registered, onlineAgents, recentMessages } = result;

  if (!registered) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          additionalContext: `No agent-comm session. Call comm_register first, then comm_channel_join "general".`,
        },
      }),
    );
  } else if (recentMessages > 0) {
    console.log(
      JSON.stringify({
        hookSpecificOutput: {
          additionalContext: `${onlineAgents} agent(s) online, ${recentMessages} message(s) in last 5 min. Call comm_inbox to check for updates.`,
        },
      }),
    );
  } else {
    console.log(JSON.stringify({}));
  }
});
