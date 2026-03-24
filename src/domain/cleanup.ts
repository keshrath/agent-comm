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
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;

export interface CleanupStats {
  agents: number;
  messages: number;
  reads: number;
  channels: number;
  state: number;
}

export class CleanupService {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly retentionDays: number = DEFAULT_RETENTION_DAYS,
  ) {
    this.resetOnStartup();
    this.startTimer();
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

    if (agents + messages + reads + channels + state > 0) {
      process.stderr.write(
        `[agent-comm] Cleanup: ${agents} agents, ${messages} messages, ${reads} reads, ${channels} channels, ${state} state entries purged\n`,
      );
    }

    return { agents, messages, reads, channels, state };
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
      } catch {
        /* db may be closed */
      }
    }, CLEANUP_INTERVAL_MS);
    this.timer.unref();
  }
}
