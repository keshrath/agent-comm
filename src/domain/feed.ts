// =============================================================================
// agent-comm — Activity feed domain
//
// Structured activity log for agent actions. Supports manual logging and
// auto-emission from existing actions (register, message, state changes).
// =============================================================================

import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { FeedEvent } from '../types.js';
import { ValidationError } from '../types.js';

const VALID_TYPES = new Set([
  'commit',
  'test_pass',
  'test_fail',
  'file_edit',
  'task_complete',
  'error',
  'custom',
  'register',
  'message',
  'state_change',
]);

const MAX_PREVIEW_LENGTH = 500;
const MAX_TARGET_LENGTH = 256;

interface FeedRow {
  id: number;
  agent_id: string | null;
  type: string;
  target: string | null;
  preview: string | null;
  created_at: string;
}

function rowToFeedEvent(row: FeedRow): FeedEvent {
  return {
    id: row.id,
    agent_id: row.agent_id,
    type: row.type,
    target: row.target,
    preview: row.preview,
    created_at: row.created_at,
  };
}

export class FeedService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  log(agentId: string, type: string, target?: string | null, preview?: string | null): FeedEvent {
    if (!VALID_TYPES.has(type)) {
      throw new ValidationError(
        `Invalid feed event type "${type}". Must be one of: ${[...VALID_TYPES].join(', ')}`,
      );
    }
    if (target && target.length > MAX_TARGET_LENGTH) {
      throw new ValidationError(`Target exceeds maximum length of ${MAX_TARGET_LENGTH}.`);
    }
    if (preview && preview.length > MAX_PREVIEW_LENGTH) {
      preview = preview.substring(0, MAX_PREVIEW_LENGTH);
    }

    this.db.run(`INSERT INTO feed_events (agent_id, type, target, preview) VALUES (?, ?, ?, ?)`, [
      agentId,
      type,
      target ?? null,
      preview ?? null,
    ]);

    const row = this.db.queryOne<FeedRow>(
      `SELECT * FROM feed_events WHERE id = last_insert_rowid()`,
    );
    const event = rowToFeedEvent(row!);
    this.events.emit('state:changed', { feed_event: event });
    return event;
  }

  /** Internal log that doesn't throw on invalid types (for auto-emit). */
  logInternal(
    agentId: string | null,
    type: string,
    target?: string | null,
    preview?: string | null,
  ): void {
    try {
      const safePreview =
        preview && preview.length > MAX_PREVIEW_LENGTH
          ? preview.substring(0, MAX_PREVIEW_LENGTH)
          : preview;
      this.db.run(`INSERT INTO feed_events (agent_id, type, target, preview) VALUES (?, ?, ?, ?)`, [
        agentId,
        type,
        target ?? null,
        safePreview ?? null,
      ]);
    } catch {
      /* ignore errors in auto-emit — don't break the original action */
    }
  }

  query(
    options: {
      agent?: string;
      type?: string;
      limit?: number;
      since?: string;
    } = {},
  ): FeedEvent[] {
    let sql = `SELECT * FROM feed_events WHERE 1=1`;
    const params: unknown[] = [];

    if (options.agent) {
      sql += ` AND agent_id = ?`;
      params.push(options.agent);
    }
    if (options.type) {
      sql += ` AND type = ?`;
      params.push(options.type);
    }
    if (options.since) {
      sql += ` AND created_at >= ?`;
      params.push(options.since);
    }

    sql += ` ORDER BY created_at DESC`;
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
    sql += ` LIMIT ?`;
    params.push(limit);

    return this.db.queryAll<FeedRow>(sql, params).map(rowToFeedEvent);
  }

  count(): number {
    const row = this.db.queryOne<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM feed_events`);
    return row?.cnt ?? 0;
  }

  recent(limit: number = 20): FeedEvent[] {
    return this.query({ limit });
  }
}
