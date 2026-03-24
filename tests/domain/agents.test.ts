import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';

describe('AgentService', () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => {
    ctx.close();
  });

  describe('register', () => {
    it('creates an agent with a unique id', () => {
      const agent = ctx.agents.register({ name: 'test-agent' });
      expect(agent.id).toBeDefined();
      expect(agent.name).toBe('test-agent');
      expect(agent.status).toBe('online');
      expect(agent.capabilities).toEqual([]);
    });

    it('stores capabilities and metadata', () => {
      const agent = ctx.agents.register({
        name: 'reviewer',
        capabilities: ['code-review', 'testing'],
        metadata: { version: '1.0' },
      });
      expect(agent.capabilities).toEqual(['code-review', 'testing']);
      expect(agent.metadata).toEqual({ version: '1.0' });
    });

    it('rejects empty names', () => {
      expect(() => ctx.agents.register({ name: '' })).toThrow('must not be empty');
    });

    it('rejects invalid names', () => {
      expect(() => ctx.agents.register({ name: '-bad' })).toThrow('Invalid agent name');
      expect(() => ctx.agents.register({ name: 'a' })).toThrow('Invalid agent name');
      expect(() => ctx.agents.register({ name: 'has spaces' })).toThrow('Invalid agent name');
    });

    it('rejects duplicate active names', () => {
      ctx.agents.register({ name: 'unique' });
      expect(() => ctx.agents.register({ name: 'unique' })).toThrow('already registered');
    });

    it('allows re-registration of offline agents under the same name', () => {
      const first = ctx.agents.register({ name: 're-register' });
      ctx.agents.unregister(first.id);

      const second = ctx.agents.register({ name: 're-register' });
      expect(second.id).toBe(first.id);
      expect(second.status).toBe('online');
    });
  });

  describe('getById / getByName', () => {
    it('finds agents by id and name', () => {
      const agent = ctx.agents.register({ name: 'findme' });
      expect(ctx.agents.getById(agent.id)?.name).toBe('findme');
      expect(ctx.agents.getByName('findme')?.id).toBe(agent.id);
    });

    it('returns null for non-existent agents', () => {
      expect(ctx.agents.getById('nope')).toBeNull();
      expect(ctx.agents.getByName('nope')).toBeNull();
    });
  });

  describe('list', () => {
    it('lists active agents excluding offline ones', () => {
      ctx.agents.register({ name: 'alice' });
      const bob = ctx.agents.register({ name: 'bob' });
      ctx.agents.unregister(bob.id);

      const list = ctx.agents.list();
      expect(list).toHaveLength(1);
      expect(list[0].name).toBe('alice');
    });

    it('filters by capability', () => {
      ctx.agents.register({ name: 'dev', capabilities: ['coding', 'testing'] });
      ctx.agents.register({ name: 'reviewer', capabilities: ['code-review'] });

      const coders = ctx.agents.list({ capability: 'coding' });
      expect(coders).toHaveLength(1);
      expect(coders[0].name).toBe('dev');
    });
  });

  describe('heartbeat', () => {
    it('updates the heartbeat timestamp', () => {
      const agent = ctx.agents.register({ name: 'heartbeater' });
      ctx.agents.heartbeat(agent.id);
      const after = ctx.agents.getById(agent.id)!.last_heartbeat;
      expect(after).toBeDefined();
      expect(typeof after).toBe('string');
    });

    it('throws for unknown agents', () => {
      expect(() => ctx.agents.heartbeat('nonexistent')).toThrow('not found');
    });
  });

  describe('updateCapabilities', () => {
    it('replaces capabilities', () => {
      const agent = ctx.agents.register({ name: 'updater', capabilities: ['a'] });
      ctx.agents.updateCapabilities(agent.id, ['b', 'c']);
      expect(ctx.agents.getById(agent.id)!.capabilities).toEqual(['b', 'c']);
    });
  });

  describe('capability filtering', () => {
    it('finds agents by capability keyword', () => {
      ctx.agents.register({ name: 'coder', capabilities: ['full-stack-coding'] });
      ctx.agents.register({ name: 'tester', capabilities: ['testing'] });

      const found = ctx.agents.list({ capability: 'coding' });
      expect(found).toHaveLength(1);
      expect(found[0].name).toBe('coder');
    });
  });

  describe('events', () => {
    it('emits agent:registered on registration', () => {
      const events: unknown[] = [];
      ctx.events.on('agent:registered', (e) => events.push(e));
      ctx.agents.register({ name: 'evented' });
      expect(events).toHaveLength(1);
    });

    it('emits agent:offline on unregister', () => {
      const events: unknown[] = [];
      ctx.events.on('agent:offline', (e) => events.push(e));
      const agent = ctx.agents.register({ name: 'will-leave' });
      ctx.agents.unregister(agent.id);
      expect(events).toHaveLength(1);
    });
  });
});
