import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';

describe('StateService', () => {
  let ctx: AppContext;
  let agentId: string;

  beforeEach(() => {
    ctx = createTestContext();
    agentId = ctx.agents.register({ name: 'statekeeper' }).id;
  });
  afterEach(() => {
    ctx.close();
  });

  describe('set / get', () => {
    it('stores and retrieves a value', () => {
      ctx.state.set('default', 'key1', 'value1', agentId);
      const entry = ctx.state.get('default', 'key1');
      expect(entry).not.toBeNull();
      expect(entry!.value).toBe('value1');
      expect(entry!.updated_by).toBe(agentId);
    });

    it('overwrites existing values', () => {
      ctx.state.set('default', 'key1', 'old', agentId);
      ctx.state.set('default', 'key1', 'new', agentId);
      expect(ctx.state.get('default', 'key1')!.value).toBe('new');
    });

    it('returns null for non-existent keys', () => {
      expect(ctx.state.get('default', 'nope')).toBeNull();
    });

    it('validates key length', () => {
      const longKey = 'x'.repeat(300);
      expect(() => ctx.state.set('default', longKey, 'v', agentId)).toThrow();
    });
  });

  describe('namespaces', () => {
    it('keeps entries in separate namespaces', () => {
      ctx.state.set('ns1', 'key', 'val1', agentId);
      ctx.state.set('ns2', 'key', 'val2', agentId);

      expect(ctx.state.get('ns1', 'key')!.value).toBe('val1');
      expect(ctx.state.get('ns2', 'key')!.value).toBe('val2');
    });

    it('lists distinct namespaces', () => {
      ctx.state.set('alpha', 'k', 'v', agentId);
      ctx.state.set('beta', 'k', 'v', agentId);
      ctx.state.set('alpha', 'k2', 'v', agentId);

      expect(ctx.state.namespaces()).toEqual(['alpha', 'beta']);
    });
  });

  describe('list', () => {
    it('lists all entries', () => {
      ctx.state.set('default', 'a', '1', agentId);
      ctx.state.set('default', 'b', '2', agentId);
      expect(ctx.state.list()).toHaveLength(2);
    });

    it('filters by namespace', () => {
      ctx.state.set('ns1', 'a', '1', agentId);
      ctx.state.set('ns2', 'b', '2', agentId);
      expect(ctx.state.list('ns1')).toHaveLength(1);
    });

    it('filters by key prefix', () => {
      ctx.state.set('default', 'config.db', '1', agentId);
      ctx.state.set('default', 'config.cache', '2', agentId);
      ctx.state.set('default', 'other', '3', agentId);

      const filtered = ctx.state.list('default', 'config.');
      expect(filtered).toHaveLength(2);
    });
  });

  describe('delete', () => {
    it('deletes a key', () => {
      ctx.state.set('default', 'temp', 'val', agentId);
      const deleted = ctx.state.delete('default', 'temp');
      expect(deleted).toBe(true);
      expect(ctx.state.get('default', 'temp')).toBeNull();
    });

    it('returns false for non-existent keys', () => {
      expect(ctx.state.delete('default', 'nope')).toBe(false);
    });
  });

  describe('deleteNamespace', () => {
    it('removes all entries in a namespace', () => {
      ctx.state.set('temp', 'a', '1', agentId);
      ctx.state.set('temp', 'b', '2', agentId);
      ctx.state.set('keep', 'c', '3', agentId);

      const count = ctx.state.deleteNamespace('temp');
      expect(count).toBe(2);
      expect(ctx.state.list('temp')).toHaveLength(0);
      expect(ctx.state.list('keep')).toHaveLength(1);
    });
  });

  describe('compareAndSwap', () => {
    it('swaps when expected value matches', () => {
      ctx.state.set('default', 'cas', 'old', agentId);
      const ok = ctx.state.compareAndSwap('default', 'cas', 'old', 'new', agentId);
      expect(ok).toBe(true);
      expect(ctx.state.get('default', 'cas')!.value).toBe('new');
    });

    it('fails when expected value does not match', () => {
      ctx.state.set('default', 'cas', 'actual', agentId);
      const ok = ctx.state.compareAndSwap('default', 'cas', 'wrong', 'new', agentId);
      expect(ok).toBe(false);
      expect(ctx.state.get('default', 'cas')!.value).toBe('actual');
    });

    it('creates if expected is null and key does not exist', () => {
      const ok = ctx.state.compareAndSwap('default', 'fresh', null, 'created', agentId);
      expect(ok).toBe(true);
      expect(ctx.state.get('default', 'fresh')!.value).toBe('created');
    });

    it('fails create if key already exists and expected is null', () => {
      ctx.state.set('default', 'taken', 'exists', agentId);
      const ok = ctx.state.compareAndSwap('default', 'taken', null, 'nope', agentId);
      expect(ok).toBe(false);
    });

    it('deletes when new value is empty string', () => {
      ctx.state.set('default', 'deleteme', 'val', agentId);
      ctx.state.compareAndSwap('default', 'deleteme', 'val', '', agentId);
      expect(ctx.state.get('default', 'deleteme')).toBeNull();
    });
  });

  describe('events', () => {
    it('emits state:changed on set', () => {
      const events: unknown[] = [];
      ctx.events.on('state:changed', (e) => events.push(e));
      ctx.state.set('default', 'k', 'v', agentId);
      expect(events).toHaveLength(1);
    });

    it('emits state:deleted on delete', () => {
      const events: unknown[] = [];
      ctx.events.on('state:deleted', (e) => events.push(e));
      ctx.state.set('default', 'k', 'v', agentId);
      ctx.state.delete('default', 'k');
      expect(events).toHaveLength(1);
    });
  });
});
