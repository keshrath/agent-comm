// =============================================================================
// agent-comm — Message domain
//
// Handles direct messages, channel messages, threading, read tracking,
// acknowledgment, search (FTS5), and broadcast.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { Message, MessageSendInput, MessageRead, MessageImportance } from '../types.js';
import { NotFoundError, ValidationError } from '../types.js';

const MAX_CONTENT_LENGTH = 50_000;
const VALID_IMPORTANCE = new Set<MessageImportance>(['low', 'normal', 'high', 'urgent']);

interface MessageRow {
  id: number;
  channel_id: string | null;
  from_agent: string;
  to_agent: string | null;
  thread_id: number | null;
  branch_id: number | null;
  content: string;
  importance: string;
  ack_required: number;
  created_at: string;
  edited_at: string | null;
}

function rowToMessage(row: MessageRow): Message {
  return {
    ...row,
    branch_id: row.branch_id ?? null,
    importance: row.importance as MessageImportance,
    ack_required: row.ack_required === 1,
  };
}

export interface MessageListOptions {
  channel?: string;
  from?: string;
  to?: string;
  thread?: number;
  importance?: MessageImportance;
  since?: string;
  limit?: number;
  offset?: number;
  unreadBy?: string;
}

export interface SearchResult {
  message: Message;
  snippet: string;
  rank: number;
}

/** Interface for agent queries needed by MessageService (avoids circular dependency) */
export interface AgentLookup {
  list(options?: { status?: string; includeOffline?: boolean }): { id: string }[];
}

export class MessageService {
  private agentLookup: AgentLookup | null = null;

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  /** Inject agent lookup to avoid circular dependency */
  setAgentLookup(lookup: AgentLookup): void {
    this.agentLookup = lookup;
  }

  send(fromAgentId: string, input: MessageSendInput): Message {
    if (!input.content || typeof input.content !== 'string') {
      throw new ValidationError('Message content must be a non-empty string.');
    }
    if (input.content.length > MAX_CONTENT_LENGTH) {
      throw new ValidationError(`Message content exceeds ${MAX_CONTENT_LENGTH} characters.`);
    }
    // Reject null bytes which can cause truncation issues in SQLite and downstream
    if (input.content.includes('\0')) {
      throw new ValidationError('Message content must not contain null bytes.');
    }
    if (input.importance && !VALID_IMPORTANCE.has(input.importance)) {
      throw new ValidationError(`Invalid importance: ${input.importance}`);
    }
    if (!input.to && !input.channel) {
      throw new ValidationError('Either "to" (agent) or "channel" must be specified.');
    }
    if (input.to && input.channel) {
      throw new ValidationError('Cannot specify both "to" and "channel".');
    }

    if (input.thread_id) {
      const parent = this.db.queryOne<MessageRow>(`SELECT id FROM messages WHERE id = ?`, [
        input.thread_id,
      ]);
      if (!parent) throw new NotFoundError('Thread parent message', String(input.thread_id));
    }

    const result = this.db.run(
      `INSERT INTO messages (channel_id, from_agent, to_agent, thread_id, branch_id, content, importance, ack_required)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        input.channel ?? null,
        fromAgentId,
        input.to ?? null,
        input.thread_id ?? null,
        input.branch_id ?? null,
        input.content,
        input.importance ?? 'normal',
        input.ack_required ? 1 : 0,
      ],
    );

    const id = Number(result.lastInsertRowid);
    const message = this.getById(id)!;
    this.events.emit('message:sent', { message });
    return message;
  }

  /** Send a direct message to all online agents (excluding sender) */
  broadcast(
    fromAgentId: string,
    content: string,
    importance: MessageImportance = 'normal',
  ): Message[] {
    if (!content || typeof content !== 'string') {
      throw new ValidationError('Broadcast content must be a non-empty string.');
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      throw new ValidationError(`Broadcast content exceeds ${MAX_CONTENT_LENGTH} characters.`);
    }

    if (!this.agentLookup) {
      throw new ValidationError('Agent lookup not configured — cannot broadcast.');
    }

    const agents = this.agentLookup.list().filter((a) => a.id !== fromAgentId);

    return this.db.transaction(() =>
      agents.map((agent) => this.send(fromAgentId, { to: agent.id, content, importance })),
    );
  }

  /** Total message count (for dashboard stats) */
  count(): number {
    const row = this.db.queryOne<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM messages`);
    return row?.cnt ?? 0;
  }

  getById(id: number): Message | null {
    const row = this.db.queryOne<MessageRow>(`SELECT * FROM messages WHERE id = ?`, [id]);
    return row ? rowToMessage(row) : null;
  }

  list(options: MessageListOptions = {}): Message[] {
    let sql = `SELECT m.* FROM messages m WHERE 1=1`;
    const params: unknown[] = [];

    if (options.channel) {
      sql += ` AND m.channel_id = ?`;
      params.push(options.channel);
    }
    if (options.from) {
      sql += ` AND m.from_agent = ?`;
      params.push(options.from);
    }
    if (options.to) {
      sql += ` AND m.to_agent = ?`;
      params.push(options.to);
    }
    if (options.thread !== undefined) {
      sql += ` AND m.thread_id = ?`;
      params.push(options.thread);
    }
    if (options.importance) {
      sql += ` AND m.importance = ?`;
      params.push(options.importance);
    }
    if (options.since) {
      sql += ` AND m.created_at > ?`;
      params.push(options.since);
    }
    if (options.unreadBy) {
      sql += ` AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.agent_id = ?)`;
      params.push(options.unreadBy);
    }

    sql += ` ORDER BY m.created_at DESC`;

    const limit = Math.min(Math.max(1, options.limit ?? 50), 500);
    sql += ` LIMIT ?`;
    params.push(limit);

    if (options.offset && options.offset > 0) {
      sql += ` OFFSET ?`;
      params.push(options.offset);
    }

    return this.db.queryAll<MessageRow>(sql, params).map(rowToMessage);
  }

  /** Get the inbox for an agent: direct messages + messages from joined channels */
  inbox(agentId: string, options: { unreadOnly?: boolean; limit?: number } = {}): Message[] {
    const limit = Math.min(Math.max(1, options.limit ?? 50), 500);

    let sql = `
      SELECT m.* FROM messages m
      WHERE (
        m.to_agent = ?
        OR m.channel_id IN (SELECT channel_id FROM channel_members WHERE agent_id = ?)
      )
      AND m.from_agent != ?
    `;
    const params: unknown[] = [agentId, agentId, agentId];

    if (options.unreadOnly) {
      sql += ` AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.agent_id = ?)`;
      params.push(agentId);
    }

    sql += ` ORDER BY m.created_at DESC LIMIT ?`;
    params.push(limit);

    return this.db.queryAll<MessageRow>(sql, params).map(rowToMessage);
  }

  /** Get full thread starting from a root message */
  thread(messageId: number): Message[] {
    const msg = this.getById(messageId);
    if (!msg) throw new NotFoundError('Message', String(messageId));

    const rootId = msg.thread_id ?? msg.id;
    const rows = this.db.queryAll<MessageRow>(
      `SELECT * FROM messages WHERE id = ? OR thread_id = ? ORDER BY created_at ASC`,
      [rootId, rootId],
    );
    return rows.map(rowToMessage);
  }

  markRead(messageId: number, agentId: string): void {
    const msg = this.getById(messageId);
    if (!msg) throw new NotFoundError('Message', String(messageId));

    this.db.run(`INSERT OR IGNORE INTO message_reads (message_id, agent_id) VALUES (?, ?)`, [
      messageId,
      agentId,
    ]);
    this.events.emit('message:read', { messageId, agentId });
  }

  /** Mark all unread messages in agent's inbox as read */
  markAllRead(agentId: string): number {
    const result = this.db.run(
      `INSERT OR IGNORE INTO message_reads (message_id, agent_id)
       SELECT m.id, ?
       FROM messages m
       WHERE (
         m.to_agent = ?
         OR m.channel_id IN (SELECT channel_id FROM channel_members WHERE agent_id = ?)
       )
       AND m.from_agent != ?
       AND NOT EXISTS (SELECT 1 FROM message_reads mr WHERE mr.message_id = m.id AND mr.agent_id = ?)`,
      [agentId, agentId, agentId, agentId, agentId],
    );
    return result.changes;
  }

  acknowledge(messageId: number, agentId: string): void {
    const msg = this.getById(messageId);
    if (!msg) throw new NotFoundError('Message', String(messageId));
    if (!msg.ack_required)
      throw new ValidationError('This message does not require acknowledgment.');

    this.db.run(
      `INSERT INTO message_reads (message_id, agent_id, acked_at)
       VALUES (?, ?, datetime('now'))
       ON CONFLICT (message_id, agent_id)
       DO UPDATE SET acked_at = datetime('now')`,
      [messageId, agentId],
    );
    this.events.emit('message:acked', { messageId, agentId });
  }

  /** Get read/ack status for a message */
  readStatus(messageId: number): MessageRead[] {
    return this.db.queryAll<MessageRead>(`SELECT * FROM message_reads WHERE message_id = ?`, [
      messageId,
    ]);
  }

  /** Full-text search across messages */
  search(
    query: string,
    options: { limit?: number; channel?: string; from?: string } = {},
  ): SearchResult[] {
    if (!query.trim()) return [];
    if (query.length > 1000) {
      throw new ValidationError('Search query too long (max 1000 characters).');
    }

    // Strip ALL FTS5 special syntax: operators, column filters, grouping, prefix,
    // NEAR/N, backslash escapes, and any non-alphanumeric/space/dash characters
    // that could be interpreted as FTS5 syntax.
    const cleaned = query
      .replace(/["*^{}[\]:()\\/]/g, ' ') // FTS5 special chars including backslash
      .replace(/\b(AND|OR|NOT|NEAR)\b/gi, ' ') // FTS5 boolean operators
      .replace(/\b(NEAR\/\d+)\b/gi, ' ') // NEAR/N operator
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return [];
    // Wrap each word individually in quotes to prevent any FTS5 operator interpretation
    const words = cleaned.split(' ').filter(Boolean);
    const sanitized = words.map((w) => '"' + w.replace(/"/g, '""') + '"').join(' ');

    const limit = Math.min(Math.max(1, options.limit ?? 20), 100);
    let sql = `
      SELECT m.*, snippet(messages_fts, 0, '<mark>', '</mark>', '...', 32) AS snippet,
             rank
      FROM messages_fts
      JOIN messages m ON m.id = messages_fts.rowid
      WHERE messages_fts MATCH ?
    `;
    const params: unknown[] = [sanitized];

    if (options.channel) {
      sql += ` AND m.channel_id = ?`;
      params.push(options.channel);
    }

    if (options.from) {
      sql += ` AND m.from_agent = ?`;
      params.push(options.from);
    }

    sql += ` ORDER BY rank LIMIT ?`;
    params.push(limit);

    const rows = this.db.queryAll<MessageRow & { snippet: string; rank: number }>(sql, params);
    return rows.map((row) => ({
      message: rowToMessage(row),
      snippet: row.snippet,
      rank: row.rank,
    }));
  }

  /** Edit a message (only the sender can edit) */
  edit(messageId: number, agentId: string, newContent: string): Message {
    const msg = this.getById(messageId);
    if (!msg) throw new NotFoundError('Message', String(messageId));
    if (msg.from_agent !== agentId)
      throw new ValidationError('Only the sender can edit a message.');
    if (!newContent) {
      throw new ValidationError('Message content must be a non-empty string.');
    }
    if (newContent.includes('\0')) {
      throw new ValidationError('Message content must not contain null bytes.');
    }
    if (newContent.length > MAX_CONTENT_LENGTH) {
      throw new ValidationError(`Message content exceeds ${MAX_CONTENT_LENGTH} characters.`);
    }

    this.db.run(`UPDATE messages SET content = ?, edited_at = datetime('now') WHERE id = ?`, [
      newContent,
      messageId,
    ]);
    return this.getById(messageId)!;
  }

  /** Delete a message (only the sender can delete) */
  delete(messageId: number, agentId: string): void {
    const msg = this.getById(messageId);
    if (!msg) throw new NotFoundError('Message', String(messageId));
    if (msg.from_agent !== agentId)
      throw new ValidationError('Only the sender can delete a message.');
    this.db.run(`DELETE FROM messages WHERE id = ?`, [messageId]);
  }
}
