// =============================================================================
// agent-comm — Storage layer
//
// Thin wrapper around better-sqlite3 with schema management and migrations.
// Provides a simplified query interface used by domain services.
// =============================================================================

import Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

export interface DbOptions {
  /** Use ':memory:' for tests, or a file path. Defaults to ~/.agent-comm/agent-comm.db */
  path?: string;
  /** Enable verbose logging to stderr */
  verbose?: boolean;
}

export interface Db {
  readonly raw: Database.Database;
  run(sql: string, params?: unknown[]): Database.RunResult;
  queryAll<T>(sql: string, params?: unknown[]): T[];
  queryOne<T>(sql: string, params?: unknown[]): T | null;
  transaction<T>(fn: () => T): T;
  close(): void;
}

const SCHEMA_VERSION = 4;

export function createDb(options: DbOptions = {}): Db {
  const dbPath = resolveDbPath(options.path);
  const raw = new Database(dbPath, {
    verbose: options.verbose ? (msg) => process.stderr.write(`[sql] ${msg}\n`) : undefined,
  });

  raw.pragma('journal_mode = WAL');
  raw.pragma('busy_timeout = 5000');
  raw.pragma('synchronous = NORMAL');
  raw.pragma('foreign_keys = ON');

  applySchema(raw);

  return {
    raw,

    run(sql: string, params?: unknown[]): Database.RunResult {
      const stmt = raw.prepare(sql);
      return params?.length ? stmt.run(...params) : stmt.run();
    },

    queryAll<T>(sql: string, params?: unknown[]): T[] {
      const stmt = raw.prepare(sql);
      return (params?.length ? stmt.all(...params) : stmt.all()) as T[];
    },

    queryOne<T>(sql: string, params?: unknown[]): T | null {
      const stmt = raw.prepare(sql);
      const row = params?.length ? stmt.get(...params) : stmt.get();
      return (row as T) ?? null;
    },

    transaction<T>(fn: () => T): T {
      return raw.transaction(fn)();
    },

    close(): void {
      try {
        raw.close();
      } catch {
        /* ignore */
      }
    },
  };
}

function resolveDbPath(path?: string): string {
  if (path) return path;
  const dir = join(homedir(), '.agent-comm');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'agent-comm.db');
}

function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  const row = db.prepare(`SELECT value FROM _meta WHERE key = 'schema_version'`).get() as
    | { value: string }
    | undefined;
  const currentVersion = row ? parseInt(row.value, 10) : 0;

  if (currentVersion < 1) migrateV1(db);
  if (currentVersion < 2) migrateV2(db);
  if (currentVersion < 3) migrateV3(db);
  if (currentVersion < 4) migrateV4(db);

  db.prepare(`INSERT OR REPLACE INTO _meta (key, value) VALUES ('schema_version', ?)`).run(
    String(SCHEMA_VERSION),
  );
}

function migrateV1(db: Database.Database): void {
  db.exec(`
    -- Agents
    CREATE TABLE IF NOT EXISTS agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      capabilities TEXT NOT NULL DEFAULT '[]',
      metadata TEXT NOT NULL DEFAULT '{}',
      status TEXT NOT NULL DEFAULT 'online',
      last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
      registered_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
    CREATE INDEX IF NOT EXISTS idx_agents_name ON agents(name);

    -- Channels
    CREATE TABLE IF NOT EXISTS channels (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      archived_at TEXT
    );

    -- Channel membership
    CREATE TABLE IF NOT EXISTS channel_members (
      channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      joined_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (channel_id, agent_id)
    );
    CREATE INDEX IF NOT EXISTS idx_channel_members_agent ON channel_members(agent_id);

    -- Messages
    CREATE TABLE IF NOT EXISTS messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT REFERENCES channels(id) ON DELETE SET NULL,
      from_agent TEXT NOT NULL,
      to_agent TEXT,
      thread_id INTEGER REFERENCES messages(id),
      content TEXT NOT NULL,
      importance TEXT NOT NULL DEFAULT 'normal',
      ack_required INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      edited_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_messages_channel ON messages(channel_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_to ON messages(to_agent, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_from ON messages(from_agent, created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);

    -- Message read/ack tracking
    CREATE TABLE IF NOT EXISTS message_reads (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      read_at TEXT NOT NULL DEFAULT (datetime('now')),
      acked_at TEXT,
      PRIMARY KEY (message_id, agent_id)
    );

    -- Shared state
    CREATE TABLE IF NOT EXISTS state (
      namespace TEXT NOT NULL DEFAULT 'default',
      key TEXT NOT NULL,
      value TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (namespace, key)
    );
    CREATE INDEX IF NOT EXISTS idx_state_namespace ON state(namespace);

    -- Full-text search on messages
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      content,
      content=messages,
      content_rowid=id
    );

    -- FTS triggers to keep index in sync
    CREATE TRIGGER IF NOT EXISTS messages_fts_insert AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_update AFTER UPDATE OF content ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
      INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END;

    CREATE TRIGGER IF NOT EXISTS messages_fts_delete AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END;
  `);
}

function migrateV2(db: Database.Database): void {
  db.exec(`
    -- Agent status text (nullable, max 256 chars enforced in domain)
    ALTER TABLE agents ADD COLUMN status_text TEXT;

    -- Message reactions
    CREATE TABLE IF NOT EXISTS message_reactions (
      message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      agent_id TEXT NOT NULL,
      reaction TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (message_id, agent_id, reaction)
    );
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
  `);
}

function migrateV3(db: Database.Database): void {
  db.exec(`
    -- Activity feed events
    CREATE TABLE IF NOT EXISTS feed_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent_id TEXT,
      type TEXT NOT NULL,
      target TEXT,
      preview TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_feed_events_agent ON feed_events(agent_id);
    CREATE INDEX IF NOT EXISTS idx_feed_events_type ON feed_events(type);
    CREATE INDEX IF NOT EXISTS idx_feed_events_created ON feed_events(created_at);

    -- Skills JSON column on agents
    ALTER TABLE agents ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
  `);
}

function migrateV4(db: Database.Database): void {
  db.exec(`
    -- Conversation branches
    CREATE TABLE IF NOT EXISTS thread_branches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      parent_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      name TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_thread_branches_parent ON thread_branches(parent_message_id);

    -- Branch ID on messages (nullable — null means main conversation)
    ALTER TABLE messages ADD COLUMN branch_id INTEGER REFERENCES thread_branches(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_branch ON messages(branch_id);

    -- Last activity tracking for stuck detection
    ALTER TABLE agents ADD COLUMN last_activity TEXT;
  `);
}
