// =============================================================================
// agent-comm — Cleanup service tests (feed_events retention)
// =============================================================================

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';

describe('CleanupService — feed_events retention', () => {
  let ctx: AppContext;
  let agentId: string;

  beforeEach(() => {
    ctx = createTestContext();
    agentId = ctx.agents.register({ name: 'cleaner' }).id;
  });

  afterEach(() => {
    ctx.close();
  });

  it('cleanupFeedEvents deletes rows older than the cutoff', () => {
    // Insert one ancient event and one recent event directly
    ctx.db.run(
      `INSERT INTO feed_events (agent_id, type, target, preview, created_at)
       VALUES (?, 'commit', 't1', 'old', datetime('now', '-60 days'))`,
      [agentId],
    );
    ctx.db.run(
      `INSERT INTO feed_events (agent_id, type, target, preview, created_at)
       VALUES (?, 'commit', 't2', 'new', datetime('now', '-1 day'))`,
      [agentId],
    );

    const before = ctx.db.queryAll<{ count: number }>(`SELECT COUNT(*) as count FROM feed_events`);
    expect(before[0].count).toBeGreaterThanOrEqual(2);

    const deleted = ctx.cleanup.cleanupFeedEvents(30);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const after = ctx.db.queryAll<{ preview: string }>(
      `SELECT preview FROM feed_events ORDER BY created_at`,
    );
    const previews = after.map((r) => r.preview);
    expect(previews).toContain('new');
    expect(previews).not.toContain('old');
  });

  it('cleanupFeedEvents respects the constructor-provided default retention', () => {
    // Default in tests goes through createTestContext which uses the default ctor —
    // 30 days. Insert one boundary case at -29d and one at -31d.
    ctx.db.run(
      `INSERT INTO feed_events (agent_id, type, target, preview, created_at)
       VALUES (?, 'commit', 'a', 'fresh', datetime('now', '-29 days'))`,
      [agentId],
    );
    ctx.db.run(
      `INSERT INTO feed_events (agent_id, type, target, preview, created_at)
       VALUES (?, 'commit', 'b', 'stale', datetime('now', '-31 days'))`,
      [agentId],
    );

    ctx.cleanup.cleanupFeedEvents(); // no arg → use default

    const remaining = ctx.db
      .queryAll<{ preview: string }>(`SELECT preview FROM feed_events`)
      .map((r) => r.preview);
    expect(remaining).toContain('fresh');
    expect(remaining).not.toContain('stale');
  });

  it('run() includes feed_events in the returned CleanupStats', () => {
    ctx.db.run(
      `INSERT INTO feed_events (agent_id, type, target, preview, created_at)
       VALUES (?, 'commit', 'old', 'x', datetime('now', '-90 days'))`,
      [agentId],
    );

    const stats = ctx.cleanup.run();
    expect(stats.feed_events).toBeGreaterThanOrEqual(1);
  });
});
