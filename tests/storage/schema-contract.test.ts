// =============================================================================
// agent-comm — Schema contract test
//
// Locks down columns that external consumers (outside this repo) read directly.
// Renaming any of these is a breaking change and requires a major version bump.
//
// Current external consumer:
//   ~/.claude/statusline-command.js
//   `SELECT name FROM agents WHERE status = 'online' ORDER BY last_heartbeat DESC LIMIT 1`
//
// See the "Schema contract" section in CHANGELOG.md.
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';

const STATUSLINE_QUERY = `SELECT name FROM agents WHERE status = 'online' ORDER BY last_heartbeat DESC LIMIT 1`;

describe('Schema contract — agents table (statusline consumer)', () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.close();
  });

  it('the exact statusline query parses and runs without SQL errors', () => {
    // If any of agents.name / agents.status / agents.last_heartbeat is renamed,
    // this prepare()/get() will throw with "no such column: ..." and fail loudly.
    expect(() => {
      ctx.db.queryAll(STATUSLINE_QUERY);
    }).not.toThrow();
  });

  it('returns the expected { name } shape for an online agent', () => {
    ctx.agents.register({ name: 'statusline-canary' });
    const rows = ctx.db.queryAll<{ name: string }>(STATUSLINE_QUERY);
    expect(rows.length).toBe(1);
    expect(rows[0].name).toBe('statusline-canary');
  });

  it('all three contracted columns exist on agents (PRAGMA table_info)', () => {
    const cols = ctx.db.queryAll<{ name: string }>(`PRAGMA table_info(agents)`);
    const names = new Set(cols.map((c) => c.name));
    // Renaming ANY of these breaks the statusline. If you must rename, bump
    // agent-comm's MAJOR version and update ~/.claude/statusline-command.js.
    expect(names.has('name')).toBe(true);
    expect(names.has('status')).toBe(true);
    expect(names.has('last_heartbeat')).toBe(true);
  });
});
