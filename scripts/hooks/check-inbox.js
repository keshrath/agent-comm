#!/usr/bin/env node

// =============================================================================
// agent-comm PostToolUse hook
//
// After every tool call (except agent-comm's own tools), checks if there are
// recent messages and nudges the agent to call comm_inbox.
// Silent when no recent messages (~0 tokens per tool call).
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

    const row = db
      .prepare(
        `SELECT COUNT(*) as cnt FROM messages WHERE created_at > datetime('now', '-2 minutes')`,
      )
      .get();

    db.close();

    if (row.cnt > 0) {
      console.log(
        JSON.stringify({
          hookSpecificOutput: {
            additionalContext: `${row.cnt} new message(s) in last 2 min. Call comm_inbox.`,
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
