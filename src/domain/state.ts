// =============================================================================
// agent-comm — Shared state domain
//
// Namespaced key-value store shared across all agents. Supports atomic
// operations, namespace listing, and prefix-filtered queries.
// =============================================================================

import type { Db } from '../storage/database.js';
import type { EventBus } from './events.js';
import type { StateEntry } from '../types.js';
import { ValidationError } from '../types.js';

const MAX_KEY_LENGTH = 256;
const MAX_VALUE_LENGTH = 100_000;

export class StateService {
  constructor(
    private readonly db: Db,
    private readonly events: EventBus,
  ) {}

  set(
    namespace: string,
    key: string,
    value: string,
    updatedBy: string,
    ttlSeconds?: number,
  ): StateEntry {
    this.validateKey(namespace, key);
    if (value.length > MAX_VALUE_LENGTH) {
      throw new ValidationError(`Value exceeds maximum length of ${MAX_VALUE_LENGTH}.`);
    }

    let expiresAt: string | null = null;
    if (ttlSeconds !== undefined && ttlSeconds !== null) {
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
        throw new ValidationError('ttl_seconds must be a positive number.');
      }
      expiresAt = new Date(Date.now() + ttlSeconds * 1000).toISOString();
    }

    this.db.run(
      `INSERT INTO state (namespace, key, value, updated_by, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (namespace, key)
       DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by,
                     updated_at = datetime('now'), expires_at = excluded.expires_at`,
      [namespace, key, value, updatedBy, expiresAt],
    );

    const entry = this.get(namespace, key)!;
    this.events.emit('state:changed', { namespace, key, value, updated_by: updatedBy });
    return entry;
  }

  get(namespace: string, key: string): StateEntry | null {
    this.expireSweep();
    return this.db.queryOne<StateEntry>(`SELECT * FROM state WHERE namespace = ? AND key = ?`, [
      namespace,
      key,
    ]);
  }

  /** Lazy-delete expired entries. Cheap: hits the partial index on expires_at.
   * Wrap expires_at in datetime() so it works for BOTH the SQLite native format
   * (used when entries are created via raw SQL) AND the ISO format with 'T' and
   * 'Z' (used when entries are created via state.set() from JS). Without the
   * datetime() wrap, ISO-format entries never expire because string comparison
   * against "datetime('now')" fails ('T' > ' '). */
  private expireSweep(): void {
    this.db.run(
      `DELETE FROM state WHERE expires_at IS NOT NULL AND datetime(expires_at) <= datetime('now')`,
    );
  }

  list(namespace?: string, prefix?: string): StateEntry[] {
    this.expireSweep();
    let sql = `SELECT * FROM state WHERE 1=1`;
    const params: unknown[] = [];

    if (namespace) {
      sql += ` AND namespace = ?`;
      params.push(namespace);
    }
    if (prefix) {
      sql += ` AND key LIKE ? ESCAPE '\\'`;
      params.push(prefix.replace(/[\\%_]/g, '\\$&') + '%');
    }

    sql += ` ORDER BY namespace, key`;
    return this.db.queryAll<StateEntry>(sql, params);
  }

  namespaces(): string[] {
    const rows = this.db.queryAll<{ namespace: string }>(
      `SELECT DISTINCT namespace FROM state ORDER BY namespace`,
    );
    return rows.map((r) => r.namespace);
  }

  delete(namespace: string, key: string): boolean {
    const result = this.db.run(`DELETE FROM state WHERE namespace = ? AND key = ?`, [
      namespace,
      key,
    ]);
    if (result.changes > 0) {
      this.events.emit('state:deleted', { namespace, key });
      return true;
    }
    return false;
  }

  deleteNamespace(namespace: string): number {
    if (!namespace) {
      throw new ValidationError('Namespace must not be empty.');
    }
    const result = this.db.run(`DELETE FROM state WHERE namespace = ?`, [namespace]);
    if (result.changes > 0) {
      this.events.emit('state:deleted', { namespace });
    }
    return result.changes;
  }

  compareAndSwap(
    namespace: string,
    key: string,
    expected: string | null,
    newValue: string,
    updatedBy: string,
    ttlSeconds?: number,
  ): boolean {
    return this.db.transaction(() => {
      const current = this.get(namespace, key);
      const currentValue = current?.value ?? null;

      if (currentValue !== expected) return false;

      if (newValue === '') {
        this.delete(namespace, key);
      } else {
        this.set(namespace, key, newValue, updatedBy, ttlSeconds);
      }
      return true;
    });
  }

  private validateKey(namespace: string, key: string): void {
    if (!namespace || namespace.length > MAX_KEY_LENGTH) {
      throw new ValidationError(`Namespace must be 1-${MAX_KEY_LENGTH} characters.`);
    }
    if (!key || key.length > MAX_KEY_LENGTH) {
      throw new ValidationError(`Key must be 1-${MAX_KEY_LENGTH} characters.`);
    }
    // Reject control characters and null bytes in namespace/key to prevent injection
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(namespace)) {
      throw new ValidationError('Namespace must not contain control characters.');
    }
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(key)) {
      throw new ValidationError('Key must not contain control characters.');
    }
  }
}
