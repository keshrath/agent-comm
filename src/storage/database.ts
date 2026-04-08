// =============================================================================
// agent-comm — Storage layer
//
// Thin wrapper around agent-common's createDb. Resolves the default DB path
// under ~/.agent-comm and supplies the schema as an ordered Migration[] so
// the runner in agent-common handles version bookkeeping.
// =============================================================================

import type Database from 'better-sqlite3';
import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';
import { createDb as createKitDb, type Db, type Migration } from 'agent-common';

export type { Db } from 'agent-common';

export interface DbOptions {
  /** Use ':memory:' for tests, or a file path. Defaults to ~/.agent-comm/agent-comm.db */
  path?: string;
  /** Enable verbose logging to stderr */
  verbose?: boolean;
}

export function createDb(options: DbOptions = {}): Db {
  return createKitDb({
    path: resolveDbPath(options.path),
    migrations,
    verbose: options.verbose,
  });
}

function resolveDbPath(path?: string): string {
  if (path) return path;
  const dir = join(homedir(), '.agent-comm');
  mkdirSync(dir, { recursive: true });
  return join(dir, 'agent-comm.db');
}

// ---------------------------------------------------------------------------
// Migrations — version-ordered, applied by agent-common's runner
// ---------------------------------------------------------------------------

const migrations: Migration[] = [
  {
    version: 1,
    up: (db: Database.Database) => {
      db.exec(`
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

        CREATE TABLE IF NOT EXISTS channels (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          description TEXT,
          created_by TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          archived_at TEXT
        );

        CREATE TABLE IF NOT EXISTS channel_members (
          channel_id TEXT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
          joined_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (channel_id, agent_id)
        );
        CREATE INDEX IF NOT EXISTS idx_channel_members_agent ON channel_members(agent_id);

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

        CREATE TABLE IF NOT EXISTS message_reads (
          message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          read_at TEXT NOT NULL DEFAULT (datetime('now')),
          acked_at TEXT,
          PRIMARY KEY (message_id, agent_id)
        );

        CREATE TABLE IF NOT EXISTS state (
          namespace TEXT NOT NULL DEFAULT 'default',
          key TEXT NOT NULL,
          value TEXT NOT NULL,
          updated_by TEXT NOT NULL,
          updated_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (namespace, key)
        );
        CREATE INDEX IF NOT EXISTS idx_state_namespace ON state(namespace);

        CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
          content,
          content=messages,
          content_rowid=id
        );

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
    },
  },
  {
    version: 2,
    up: (db: Database.Database) => {
      db.exec(`
        ALTER TABLE agents ADD COLUMN status_text TEXT;

        CREATE TABLE IF NOT EXISTS message_reactions (
          message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          reaction TEXT NOT NULL,
          created_at TEXT NOT NULL DEFAULT (datetime('now')),
          PRIMARY KEY (message_id, agent_id, reaction)
        );
        CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
      `);
    },
  },
  {
    version: 3,
    up: (db: Database.Database) => {
      db.exec(`
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

        ALTER TABLE agents ADD COLUMN skills TEXT NOT NULL DEFAULT '[]';
      `);
    },
  },
  {
    version: 4,
    up: (db: Database.Database) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS thread_branches (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
          name TEXT,
          created_by TEXT,
          created_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE INDEX IF NOT EXISTS idx_thread_branches_parent ON thread_branches(parent_message_id);

        ALTER TABLE messages ADD COLUMN branch_id INTEGER REFERENCES thread_branches(id) ON DELETE SET NULL;
        CREATE INDEX IF NOT EXISTS idx_messages_branch ON messages(branch_id);

        ALTER TABLE agents ADD COLUMN last_activity TEXT;
      `);
    },
  },
  {
    version: 5,
    up: (db: Database.Database) => {
      const cols = db.prepare(`PRAGMA table_info(state)`).all() as Array<{ name: string }>;
      if (!cols.some((c) => c.name === 'expires_at')) {
        db.exec(`ALTER TABLE state ADD COLUMN expires_at TEXT`);
      }
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_state_expires ON state(expires_at) WHERE expires_at IS NOT NULL`,
      );
    },
  },
];
