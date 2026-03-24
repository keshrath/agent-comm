// =============================================================================
// agent-comm — Message reactions domain
//
// Allows agents to add emoji or text reactions to messages. Supports adding,
// removing, and querying reactions per message or in bulk.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import { ValidationError } from '../types.js';

const MAX_REACTION_LENGTH = 32;

// eslint-disable-next-line no-control-regex
const CONTROL_CHAR_RE = /[\x00-\x1f\x7f]/;

export class ReactionService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  react(messageId: number, agentId: string, reaction: string): void {
    this.validateReaction(reaction);

    this.db.run(
      `INSERT OR IGNORE INTO message_reactions (message_id, agent_id, reaction)
       VALUES (?, ?, ?)`,
      [messageId, agentId, reaction],
    );

    this.events.emit('message:reacted', { messageId, agentId, reaction });
  }

  unreact(messageId: number, agentId: string, reaction: string): void {
    const result = this.db.run(
      `DELETE FROM message_reactions
       WHERE message_id = ? AND agent_id = ? AND reaction = ?`,
      [messageId, agentId, reaction],
    );

    if (result.changes > 0) {
      this.events.emit('message:unreacted', { messageId, agentId, reaction });
    }
  }

  getForMessage(
    messageId: number,
  ): Array<{ agent_id: string; reaction: string; created_at: string }> {
    return this.db.queryAll<{ agent_id: string; reaction: string; created_at: string }>(
      `SELECT agent_id, reaction, created_at
       FROM message_reactions
       WHERE message_id = ?
       ORDER BY created_at`,
      [messageId],
    );
  }

  getForMessages(
    messageIds: number[],
  ): Record<number, Array<{ agent_id: string; reaction: string }>> {
    if (messageIds.length === 0) return {};

    const placeholders = messageIds.map(() => '?').join(', ');
    const rows = this.db.queryAll<{
      message_id: number;
      agent_id: string;
      reaction: string;
    }>(
      `SELECT message_id, agent_id, reaction
       FROM message_reactions
       WHERE message_id IN (${placeholders})
       ORDER BY created_at`,
      messageIds,
    );

    const result: Record<number, Array<{ agent_id: string; reaction: string }>> = {};
    for (const row of rows) {
      if (!result[row.message_id]) {
        result[row.message_id] = [];
      }
      result[row.message_id].push({ agent_id: row.agent_id, reaction: row.reaction });
    }
    return result;
  }

  private validateReaction(reaction: string): void {
    if (!reaction || reaction.length > MAX_REACTION_LENGTH) {
      throw new ValidationError(`Reaction must be 1-${MAX_REACTION_LENGTH} characters.`);
    }
    if (CONTROL_CHAR_RE.test(reaction)) {
      throw new ValidationError('Reaction must not contain control characters.');
    }
  }
}
