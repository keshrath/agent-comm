#!/usr/bin/env node

// =============================================================================
// agent-comm UserPromptSubmit hook
//
// Checks registration status and nudges communication.
// =============================================================================

import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import { createRequire } from 'module';
import { signalFailOpen } from './_fail-open.mjs';

const require = createRequire(import.meta.url);

process.on('uncaughtException', (err) => {
  process.stderr.write(`[agent-comm hook] fatal: ${err.message}\n`);
  process.exit(0);
});

function check() {
  const dbPath = join(homedir(), '.agent-comm', 'agent-comm.db');
  if (!existsSync(dbPath)) {
    signalFailOpen('check-registration', 'sqlite-missing', { dbPath }).catch(() => {});
    return { registered: false, recentMessages: 0, onlineAgents: 0 };
  }

  try {
    const Database = require('better-sqlite3');
    const db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const agentRow = db
      .prepare(`SELECT COUNT(*) as cnt FROM agents WHERE status IN ('online', 'idle')`)
      .get();

    const msgRow = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM messages WHERE created_at > datetime('now', '-10 minutes')`,
      )
      .get();

    const stateRow = db.prepare(`SELECT COUNT(*) as cnt FROM state`).get();

    db.close();
    return {
      registered: agentRow.cnt > 0,
      onlineAgents: agentRow.cnt,
      recentMessages: msgRow.cnt,
      stateEntries: stateRow.cnt,
    };
  } catch (err) {
    process.stderr.write(`[agent-comm hook] ${err.message}\n`);
    signalFailOpen('check-registration', 'sqlite-error', {
      error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
    }).catch(() => {});
    return null;
  }
}

function run() {
  try {
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
            hookEventName: 'UserPromptSubmit',
            additionalContext: `No agent-comm session. Call comm_register first, then comm_channel({ action: "join", channel: "general" }).`,
          },
        }),
      );
    } else if (recentMessages > 0) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: `${onlineAgents} agent(s) online, ${recentMessages} message(s) in last 10 min. Call comm_inbox NOW before starting this work.`,
          },
        }),
      );
    } else if (onlineAgents > 1) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'UserPromptSubmit',
            additionalContext: `${onlineAgents} agents online. Consider posting a status update to "general" or using comm_state({ action: "set" }) to share your progress.`,
          },
        }),
      );
    } else {
      console.log(JSON.stringify({}));
    }
  } catch (err) {
    process.stderr.write(`[agent-comm hook] uncaught: ${err.message}\n`);
    console.log(JSON.stringify({}));
  }
}

let input = '';
process.stdin.on('data', (chunk) => {
  input += chunk;
});
process.stdin.on('end', run);
