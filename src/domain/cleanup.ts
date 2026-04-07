// =============================================================================
// agent-comm — Cleanup service
//
// Purges stale data to prevent unbounded growth:
// - Offline agents older than retention period
// - Messages older than retention period
// - Read receipts for deleted messages
// - Archived channels older than retention period
//
// Also handles startup reset: marks all agents offline and purges stale
// session data so the dashboard never shows ghosts from previous runs.
// =============================================================================

import type { Db } from '../storage/database.js';

const DEFAULT_RETENTION_DAYS = 7;
const DEFAULT_FEED_RETENTION_DAYS = 30;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface CleanupStats {
  agents: number;
  messages: number;
  reads: number;
  channels: number;
  state: number;
  feed_events: number;
}

export interface StaleCleanupStats extends CleanupStats {
  memberships: number;
}

export class CleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly retentionDays: number = DEFAULT_RETENTION_DAYS,
    private readonly feedRetentionDays: number = DEFAULT_FEED_RETENTION_DAYS,
  ) {
    this.resetOnStartup();
    this.startTimer();
  }

  /**
   * Delete feed_events older than `maxAgeDays` (default: this.feedRetentionDays).
   * The activity feed is written on every MCP call and would otherwise grow
   * unbounded — this is the dedicated retention method for it.
   * Returns the number of rows deleted.
   */
  cleanupFeedEvents(maxAgeDays: number = this.feedRetentionDays): number {
    return this.db.run(`DELETE FROM feed_events WHERE created_at < datetime('now', ?)`, [
      `-${maxAgeDays} days`,
    ]).changes;
  }

  /** Mark stale agents offline on server start.
   *  Only affects agents whose heartbeat is older than 2 minutes —
   *  avoids clobbering agents registered by other processes (MCP). */
  resetOnStartup(): void {
    const marked = this.db.run(
      `UPDATE agents SET status = 'offline'
       WHERE status != 'offline'
         AND last_heartbeat < datetime('now', '-2 minutes')`,
    ).changes;
    if (marked > 0) {
      process.stderr.write(`[agent-comm] Startup: marked ${marked} stale agent(s) offline\n`);
    }
  }

  run(): CleanupStats {
    const cutoff = `-${this.retentionDays} days`;

    const agents = this.db.run(
      `DELETE FROM agents WHERE status = 'offline' AND last_heartbeat < datetime('now', ?)`,
      [cutoff],
    ).changes;

    const messages = this.db.run(`DELETE FROM messages WHERE created_at < datetime('now', ?)`, [
      cutoff,
    ]).changes;

    const reads = this.db.run(
      `DELETE FROM message_reads WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = message_reads.message_id)`,
    ).changes;

    const channels = this.db.run(
      `DELETE FROM channels WHERE archived_at IS NOT NULL AND archived_at < datetime('now', ?)`,
      [cutoff],
    ).changes;

    const state = this.db.run(`DELETE FROM state WHERE updated_at < datetime('now', ?)`, [
      cutoff,
    ]).changes;

    const feed_events = this.cleanupFeedEvents();

    if (agents + messages + reads + channels + state + feed_events > 0) {
      process.stderr.write(
        `[agent-comm] Cleanup: ${agents} agents, ${messages} messages, ${reads} reads, ${channels} channels, ${state} state, ${feed_events} feed events purged\n`,
      );
    }

    return { agents, messages, reads, channels, state, feed_events };
  }

  /** Purge all messages and reads immediately (manual wipe). */
  purgeMessages(): number {
    const messages = this.db.run(`DELETE FROM messages`).changes;
    this.db.run(`DELETE FROM message_reads`);
    if (messages > 0) {
      process.stderr.write(`[agent-comm] Purged ${messages} message(s)\n`);
    }
    return messages;
  }

  /** Purge offline agents older than 1 hour (keeps recent ones for name resolution). */
  purgeOfflineAgents(): number {
    const agents = this.db.run(
      `DELETE FROM agents WHERE status = 'offline' AND last_heartbeat < datetime('now', '-1 hour')`,
    ).changes;
    if (agents > 0) {
      process.stderr.write(`[agent-comm] Purged ${agents} offline agent(s)\n`);
    }
    return agents;
  }

  /** Purge stale (offline) agents and all their associated data. */
  purgeStaleAssociated(): StaleCleanupStats {
    const staleAgents = this.db.queryAll<{ id: string }>(
      `SELECT id FROM agents WHERE status = 'offline' AND last_heartbeat < datetime('now', '-1 hour')`,
    );

    if (staleAgents.length === 0) {
      return {
        agents: 0,
        messages: 0,
        reads: 0,
        channels: 0,
        state: 0,
        feed_events: 0,
        memberships: 0,
      };
    }

    const ids = staleAgents.map((a: { id: string }) => a.id);
    const placeholders = ids.map(() => '?').join(',');

    const messages = this.db.run(
      `DELETE FROM messages WHERE from_agent IN (${placeholders}) OR to_agent IN (${placeholders})`,
      [...ids, ...ids],
    ).changes;

    const reads = this.db.run(
      `DELETE FROM message_reads WHERE NOT EXISTS (SELECT 1 FROM messages WHERE messages.id = message_reads.message_id)`,
    ).changes;

    const memberships = this.db.run(
      `DELETE FROM channel_members WHERE agent_id IN (${placeholders})`,
      ids,
    ).changes;

    const channels = this.db.run(
      `DELETE FROM channels WHERE created_by IN (${placeholders})
         AND NOT EXISTS (SELECT 1 FROM channel_members WHERE channel_members.channel_id = channels.id)`,
      ids,
    ).changes;

    const state = this.db.run(
      `DELETE FROM state WHERE updated_by IN (${placeholders})`,
      ids,
    ).changes;

    const agents = this.db.run(`DELETE FROM agents WHERE id IN (${placeholders})`, ids).changes;

    if (agents + messages + channels + state > 0) {
      process.stderr.write(
        `[agent-comm] Stale cleanup: ${agents} agents, ${messages} messages, ${channels} channels, ${state} state, ${memberships} memberships purged\n`,
      );
    }

    return { agents, messages, reads, channels, state, feed_events: 0, memberships };
  }

  /** Purge everything: all agents, messages, channels, state, feed. */
  purgeEverything(): CleanupStats {
    this.db.run(`DELETE FROM message_reactions`);
    this.db.run(`DELETE FROM message_reads`);
    this.db.run(`DELETE FROM channel_members`);
    const feed_events = this.db.run(`DELETE FROM feed_events`).changes;
    const messages = this.db.run(`DELETE FROM messages`).changes;
    const channels = this.db.run(`DELETE FROM channels`).changes;
    const agents = this.db.run(`DELETE FROM agents`).changes;
    const reads = 0;
    const state = this.db.run(`DELETE FROM state`).changes;

    process.stderr.write(
      `[agent-comm] Full purge: ${agents} agents, ${messages} messages, ${channels} channels, ${state} state entries\n`,
    );

    return { agents, messages, reads, channels, state, feed_events };
  }

  /** Run full cleanup immediately and return stats. */
  purgeAll(): CleanupStats {
    return this.run();
  }

  stopTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private startTimer(): void {
    this.run();
    this.timer = setInterval(() => {
      try {
        this.run();
      } catch (err) {
        process.stderr.write(
          '[agent-comm] Cleanup timer error: ' +
            (err instanceof Error ? err.message : String(err)) +
            '\n',
        );
      }
    }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }
}
