// =============================================================================
// agent-comm — Agent domain
//
// Handles agent registration, presence (heartbeat + stale detection),
// capability declaration, and discovery.
// =============================================================================

import { v4 as uuidv4 } from 'uuid';
import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { Agent, AgentCreateInput, AgentStatus } from '../types.js';
import { ConflictError, NotFoundError, ValidationError } from '../types.js';

const STALE_THRESHOLD_SECONDS = 90;
const OFFLINE_THRESHOLD_SECONDS = 300;
const REAP_INTERVAL_MS = 30_000;

const NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,62}[a-zA-Z0-9]$/;

interface AgentRow {
  id: string;
  name: string;
  capabilities: string;
  metadata: string;
  status: string;
  status_text: string | null;
  last_heartbeat: string;
  registered_at: string;
}

function rowToAgent(row: AgentRow): Agent {
  return {
    id: row.id,
    name: row.name,
    capabilities: JSON.parse(row.capabilities) as string[],
    metadata: JSON.parse(row.metadata) as Record<string, unknown>,
    status: row.status as AgentStatus,
    status_text: row.status_text,
    last_heartbeat: row.last_heartbeat,
    registered_at: row.registered_at,
  };
}

export class AgentService {
  private reapTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {
    this.startReaper();
  }

  register(input: AgentCreateInput): Agent {
    const name = input.name.trim();
    if (!name) throw new ValidationError('Agent name must not be empty.');
    if (!NAME_PATTERN.test(name)) {
      throw new ValidationError(
        `Invalid agent name "${name}". Must be 2-64 chars, alphanumeric with . _ - allowed (not at start/end).`,
      );
    }

    if (input.capabilities && input.capabilities.length > 20) {
      throw new ValidationError('Maximum 20 capabilities allowed.');
    }
    if (input.metadata) {
      const metaStr = JSON.stringify(input.metadata);
      if (metaStr.length > 10_000) {
        throw new ValidationError('Metadata exceeds maximum size of 10,000 characters.');
      }
    }

    const existing = this.db.queryOne<AgentRow>(`SELECT * FROM agents WHERE name = ?`, [name]);
    if (existing && existing.status !== 'offline') {
      throw new ConflictError(`Agent name "${name}" is already registered and active.`);
    }

    if (existing) {
      this.db.run(
        `UPDATE agents SET status = 'online', last_heartbeat = datetime('now'),
         capabilities = ?, metadata = ? WHERE id = ?`,
        [
          JSON.stringify(input.capabilities ?? []),
          JSON.stringify(input.metadata ?? {}),
          existing.id,
        ],
      );
      const agent = this.getById(existing.id)!;
      this.events.emit('agent:registered', { agent });
      return agent;
    }

    const id = uuidv4();
    this.db.run(`INSERT INTO agents (id, name, capabilities, metadata) VALUES (?, ?, ?, ?)`, [
      id,
      name,
      JSON.stringify(input.capabilities ?? []),
      JSON.stringify(input.metadata ?? {}),
    ]);

    const agent = this.getById(id)!;
    this.events.emit('agent:registered', { agent });
    return agent;
  }

  getById(id: string): Agent | null {
    const row = this.db.queryOne<AgentRow>(`SELECT * FROM agents WHERE id = ?`, [id]);
    return row ? rowToAgent(row) : null;
  }

  getByName(name: string): Agent | null {
    const row = this.db.queryOne<AgentRow>(`SELECT * FROM agents WHERE name = ?`, [name]);
    return row ? rowToAgent(row) : null;
  }

  list(
    options: { status?: AgentStatus; capability?: string; includeOffline?: boolean } = {},
  ): Agent[] {
    let sql = `SELECT * FROM agents WHERE 1=1`;
    const params: unknown[] = [];

    if (options.status) {
      sql += ` AND status = ?`;
      params.push(options.status);
    } else if (!options.includeOffline) {
      sql += ` AND status != 'offline'`;
    }

    sql += ` ORDER BY registered_at DESC`;
    const rows = this.db.queryAll<AgentRow>(sql, params);
    let agents = rows.map(rowToAgent);

    if (options.capability) {
      const cap = options.capability.toLowerCase();
      agents = agents.filter((a) => a.capabilities.some((c) => c.toLowerCase().includes(cap)));
    }

    return agents;
  }

  heartbeat(agentId: string, statusText?: string | null): void {
    if (statusText !== undefined && statusText !== null) {
      if (statusText.length > 256) {
        throw new ValidationError('Status text exceeds maximum length of 256 characters.');
      }
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f]/.test(statusText)) {
        throw new ValidationError('Status text must not contain control characters.');
      }
    }

    if (statusText !== undefined) {
      const result = this.db.run(
        `UPDATE agents SET last_heartbeat = datetime('now'), status = 'online', status_text = ?
         WHERE id = ? AND status != 'offline'`,
        [statusText, agentId],
      );
      if (result.changes === 0) {
        throw new NotFoundError('Agent', agentId);
      }
    } else {
      const result = this.db.run(
        `UPDATE agents SET last_heartbeat = datetime('now'), status = 'online'
         WHERE id = ? AND status != 'offline'`,
        [agentId],
      );
      if (result.changes === 0) {
        throw new NotFoundError('Agent', agentId);
      }
    }
  }

  updateStatus(agentId: string, status: AgentStatus): void {
    const result = this.db.run(
      `UPDATE agents SET status = ?, last_heartbeat = datetime('now') WHERE id = ?`,
      [status, agentId],
    );
    if (result.changes === 0) throw new NotFoundError('Agent', agentId);
    this.events.emit('agent:updated', { agentId, status });
  }

  updateCapabilities(agentId: string, capabilities: string[]): void {
    const result = this.db.run(`UPDATE agents SET capabilities = ? WHERE id = ?`, [
      JSON.stringify(capabilities),
      agentId,
    ]);
    if (result.changes === 0) throw new NotFoundError('Agent', agentId);
    this.events.emit('agent:updated', { agentId, capabilities });
  }

  updateMetadata(agentId: string, metadata: Record<string, unknown>): void {
    const result = this.db.run(`UPDATE agents SET metadata = ? WHERE id = ?`, [
      JSON.stringify(metadata),
      agentId,
    ]);
    if (result.changes === 0) throw new NotFoundError('Agent', agentId);
    this.events.emit('agent:updated', { agentId });
  }

  setStatusText(agentId: string, text: string | null): void {
    if (text !== null) {
      if (text.length > 256) {
        throw new ValidationError('Status text exceeds maximum length of 256 characters.');
      }
      // eslint-disable-next-line no-control-regex
      if (/[\x00-\x1f\x7f]/.test(text)) {
        throw new ValidationError('Status text must not contain control characters.');
      }
    }
    const result = this.db.run(`UPDATE agents SET status_text = ? WHERE id = ?`, [text, agentId]);
    if (result.changes === 0) throw new NotFoundError('Agent', agentId);
    this.events.emit('agent:updated', { agentId, status_text: text });
  }

  unregister(agentId: string): void {
    this.db.run(`UPDATE agents SET status = 'offline' WHERE id = ?`, [agentId]);
    this.events.emit('agent:offline', { agentId });
  }

  reapStale(): void {
    this.db.run(
      `UPDATE agents SET status = 'idle'
       WHERE status = 'online'
         AND last_heartbeat < datetime('now', ? || ' seconds')`,
      [`-${STALE_THRESHOLD_SECONDS}`],
    );
    this.db.run(
      `UPDATE agents SET status = 'offline'
       WHERE status IN ('online', 'idle')
         AND last_heartbeat < datetime('now', ? || ' seconds')`,
      [`-${OFFLINE_THRESHOLD_SECONDS}`],
    );
  }

  stopReaper(): void {
    if (this.reapTimer) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  private startReaper(): void {
    this.reapTimer = setInterval(() => {
      try {
        this.reapStale();
      } catch {
        /* db may be closed during shutdown */
      }
    }, REAP_INTERVAL_MS);
    this.reapTimer.unref();
  }
}
