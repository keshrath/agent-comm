// =============================================================================
// agent-comm — Channel domain
//
// Topic-based communication rooms. Agents join channels and receive all
// messages posted to them. Channels can be archived but not deleted
// (preserves message history).
// =============================================================================

import { v4 as uuidv4 } from 'uuid';
import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { Channel, ChannelMember } from '../types.js';
import { NotFoundError, ValidationError } from '../types.js';

const CHANNEL_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}[a-z0-9]$/;

export class ChannelService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  create(name: string, createdBy: string, description?: string): Channel {
    name = name.trim().toLowerCase();
    if (!CHANNEL_NAME_PATTERN.test(name)) {
      throw new ValidationError(
        `Invalid channel name "${name}". Must be 2-64 lowercase chars, alphanumeric with . _ - allowed.`,
      );
    }
    if (description && description.length > 1000) {
      throw new ValidationError('Channel description exceeds maximum length of 1000 characters.');
    }

    const existing = this.db.queryOne<Channel>(`SELECT * FROM channels WHERE name = ?`, [name]);
    if (existing && !existing.archived_at) {
      return existing;
    }

    // Unarchive if re-creating an archived channel
    if (existing) {
      this.db.run(`UPDATE channels SET archived_at = NULL, description = ? WHERE id = ?`, [
        description ?? existing.description,
        existing.id,
      ]);
      const channel = this.getById(existing.id)!;
      this.events.emit('channel:created', { channel });
      return channel;
    }

    const id = uuidv4();
    this.db.run(`INSERT INTO channels (id, name, description, created_by) VALUES (?, ?, ?, ?)`, [
      id,
      name,
      description ?? null,
      createdBy,
    ]);

    // Auto-join the creator
    this.join(id, createdBy);

    const channel = this.getById(id)!;
    this.events.emit('channel:created', { channel });
    return channel;
  }

  getById(id: string): Channel | null {
    return this.db.queryOne<Channel>(`SELECT * FROM channels WHERE id = ?`, [id]);
  }

  getByName(name: string): Channel | null {
    return this.db.queryOne<Channel>(
      `SELECT * FROM channels WHERE name = ? AND archived_at IS NULL`,
      [name],
    );
  }

  list(includeArchived = false): Channel[] {
    const sql = includeArchived
      ? `SELECT * FROM channels ORDER BY name`
      : `SELECT * FROM channels WHERE archived_at IS NULL ORDER BY name`;
    return this.db.queryAll<Channel>(sql);
  }

  updateDescription(channelId: string, description: string | null): Channel {
    const channel = this.getById(channelId);
    if (!channel) throw new NotFoundError('Channel', channelId);
    if (channel.archived_at) throw new ValidationError('Cannot update an archived channel.');
    if (description && description.length > 1000) {
      throw new ValidationError('Channel description exceeds maximum length of 1000 characters.');
    }
    this.db.run(`UPDATE channels SET description = ? WHERE id = ?`, [description, channelId]);
    const updated = this.getById(channelId)!;
    this.events.emit('channel:created', { channel: updated });
    return updated;
  }

  archive(channelId: string, requestedBy?: string): void {
    if (requestedBy) {
      const channel = this.getById(channelId);
      if (!channel) throw new NotFoundError('Channel', channelId);
      if (channel.created_by !== requestedBy) {
        throw new ValidationError('Only the channel creator can archive it.');
      }
    }

    const result = this.db.run(
      `UPDATE channels SET archived_at = datetime('now') WHERE id = ? AND archived_at IS NULL`,
      [channelId],
    );
    if (result.changes === 0) throw new NotFoundError('Channel', channelId);
    this.events.emit('channel:archived', { channelId });
  }

  join(channelId: string, agentId: string): void {
    const channel = this.getById(channelId);
    if (!channel) throw new NotFoundError('Channel', channelId);
    if (channel.archived_at) throw new ValidationError('Cannot join an archived channel.');

    try {
      this.db.run(`INSERT INTO channel_members (channel_id, agent_id) VALUES (?, ?)`, [
        channelId,
        agentId,
      ]);
    } catch (e: unknown) {
      if (e instanceof Error && e.message.includes('UNIQUE constraint')) return;
      throw e;
    }

    this.events.emit('channel:member_joined', { channelId, agentId });
  }

  leave(channelId: string, agentId: string): void {
    this.db.run(`DELETE FROM channel_members WHERE channel_id = ? AND agent_id = ?`, [
      channelId,
      agentId,
    ]);
    this.events.emit('channel:member_left', { channelId, agentId });
  }

  members(channelId: string): ChannelMember[] {
    return this.db.queryAll<ChannelMember>(
      `SELECT * FROM channel_members WHERE channel_id = ? ORDER BY joined_at`,
      [channelId],
    );
  }

  /** Check if an agent is a member of a channel */
  isMember(channelId: string, agentId: string): boolean {
    const row = this.db.queryOne<{ x: number }>(
      `SELECT 1 AS x FROM channel_members WHERE channel_id = ? AND agent_id = ?`,
      [channelId, agentId],
    );
    return row !== null;
  }

  /** Get all channels an agent belongs to */
  agentChannels(agentId: string): Channel[] {
    return this.db.queryAll<Channel>(
      `SELECT c.* FROM channels c
       JOIN channel_members cm ON cm.channel_id = c.id
       WHERE cm.agent_id = ? AND c.archived_at IS NULL
       ORDER BY c.name`,
      [agentId],
    );
  }
}
