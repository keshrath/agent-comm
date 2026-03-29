// =============================================================================
// agent-comm — Branch domain
//
// Conversation branching: fork a thread at any message point, creating an
// isolated history branch. Messages in a branch share the parent_message_id
// as thread context, plus a branch_id for isolation.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { ThreadBranch, Message } from '../types.js';
import { NotFoundError, ValidationError } from '../types.js';

interface BranchRow {
  id: number;
  parent_message_id: number;
  name: string | null;
  created_by: string | null;
  created_at: string;
}

function rowToBranch(row: BranchRow): ThreadBranch {
  return {
    id: row.id,
    parent_message_id: row.parent_message_id,
    name: row.name,
    created_by: row.created_by,
    created_at: row.created_at,
  };
}

export class BranchService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  /** Create a branch from any message. Returns the new branch. */
  create(parentMessageId: number, createdBy: string, name?: string | null): ThreadBranch {
    // Verify parent message exists
    const msg = this.db.queryOne<{ id: number }>(`SELECT id FROM messages WHERE id = ?`, [
      parentMessageId,
    ]);
    if (!msg) throw new NotFoundError('Message', String(parentMessageId));

    if (name !== undefined && name !== null) {
      if (typeof name !== 'string' || name.length === 0 || name.length > 128) {
        throw new ValidationError('Branch name must be 1-128 characters.');
      }
    }

    this.db.run(
      `INSERT INTO thread_branches (parent_message_id, name, created_by) VALUES (?, ?, ?)`,
      [parentMessageId, name ?? null, createdBy],
    );

    const row = this.db.queryOne<BranchRow>(
      `SELECT * FROM thread_branches WHERE id = last_insert_rowid()`,
    );
    const branch = rowToBranch(row!);
    this.events.emit('branch:created', { branch });
    return branch;
  }

  /** Get a branch by ID. */
  getById(id: number): ThreadBranch | null {
    const row = this.db.queryOne<BranchRow>(`SELECT * FROM thread_branches WHERE id = ?`, [id]);
    return row ? rowToBranch(row) : null;
  }

  /** List branches, optionally filtered by parent message. */
  list(parentMessageId?: number): ThreadBranch[] {
    if (parentMessageId !== undefined) {
      return this.db
        .queryAll<BranchRow>(
          `SELECT * FROM thread_branches WHERE parent_message_id = ? ORDER BY created_at ASC`,
          [parentMessageId],
        )
        .map(rowToBranch);
    }
    return this.db
      .queryAll<BranchRow>(`SELECT * FROM thread_branches ORDER BY created_at DESC LIMIT 100`)
      .map(rowToBranch);
  }

  /** Get messages in a specific branch. */
  branchMessages(branchId: number): Message[] {
    const branch = this.getById(branchId);
    if (!branch) throw new NotFoundError('Branch', String(branchId));

    // Include the parent message + all messages with this branch_id
    const rows = this.db.queryAll<{
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
    }>(
      `SELECT * FROM messages
       WHERE id = ? OR branch_id = ?
       ORDER BY created_at ASC`,
      [branch.parent_message_id, branchId],
    );

    return rows.map((row) => ({
      ...row,
      branch_id: row.branch_id ?? null,
      importance: row.importance as Message['importance'],
      ack_required: row.ack_required === 1,
    }));
  }

  /** Count total branches. */
  count(): number {
    const row = this.db.queryOne<{ cnt: number }>(`SELECT COUNT(*) as cnt FROM thread_branches`);
    return row?.cnt ?? 0;
  }
}
