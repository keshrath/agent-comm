import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';
import { createToolHandler } from '../../src/transport/mcp.js';

describe('FeedService', () => {
  let ctx: AppContext;
  let alice: { id: string; name: string };

  beforeEach(() => {
    ctx = createTestContext();
    alice = ctx.agents.register({ name: 'alice' });
  });
  afterEach(() => {
    ctx.close();
  });

  describe('log', () => {
    it('logs an event with valid type and returns event with id and timestamp', () => {
      const event = ctx.feed.log(alice.id, 'commit', 'main', 'Fixed login bug');

      expect(event.id).toBeGreaterThan(0);
      expect(event.agent_id).toBe(alice.id);
      expect(event.type).toBe('commit');
      expect(event.target).toBe('main');
      expect(event.preview).toBe('Fixed login bug');
      expect(new Date(event.created_at).getTime()).toBeGreaterThan(0);
    });

    it('accepts all valid event types', () => {
      const validTypes = [
        'commit',
        'test_pass',
        'test_fail',
        'file_edit',
        'task_complete',
        'error',
        'custom',
        'register',
        'message',
        'state_change',
        'handoff',
        'branch',
      ];

      for (const type of validTypes) {
        const event = ctx.feed.log(alice.id, type);
        expect(event.type).toBe(type);
      }
    });

    it('throws ValidationError for invalid event type', () => {
      expect(() => ctx.feed.log(alice.id, 'nonexistent_type')).toThrow('Invalid feed event type');
    });

    it('logs event with null target and preview', () => {
      const event = ctx.feed.log(alice.id, 'custom');
      expect(event.target).toBeNull();
      expect(event.preview).toBeNull();
    });

    it('truncates preview exceeding 500 characters', () => {
      const longPreview = 'x'.repeat(600);
      const event = ctx.feed.log(alice.id, 'custom', null, longPreview);
      expect(event.preview!.length).toBe(500);
    });

    it('throws ValidationError when target exceeds 256 characters', () => {
      const longTarget = 'x'.repeat(257);
      expect(() => ctx.feed.log(alice.id, 'commit', longTarget)).toThrow(
        'Target exceeds maximum length',
      );
    });

    it('emits state:changed event on log', () => {
      const events: unknown[] = [];
      ctx.events.on('state:changed', (e) => events.push(e));

      ctx.feed.log(alice.id, 'commit', 'main', 'test');

      expect(events).toHaveLength(1);
      const evt = events[0] as { data: { feed_event: { type: string } } };
      expect(evt.data.feed_event.type).toBe('commit');
    });
  });

  describe('query', () => {
    beforeEach(() => {
      const bob = ctx.agents.register({ name: 'bob' });
      ctx.feed.log(alice.id, 'commit', 'main', 'First commit');
      ctx.feed.log(alice.id, 'test_pass', 'suite-a', 'All green');
      ctx.feed.log(bob.id, 'error', 'server', 'Crash');
    });

    it('returns all events when no filter is specified', () => {
      const events = ctx.feed.query();
      expect(events).toHaveLength(3);
    });

    it('filters by agent', () => {
      const events = ctx.feed.query({ agent: alice.id });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.agent_id === alice.id)).toBe(true);
    });

    it('filters by type', () => {
      const events = ctx.feed.query({ type: 'error' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('error');
      expect(events[0].target).toBe('server');
    });

    it('respects limit parameter', () => {
      const events = ctx.feed.query({ limit: 1 });
      expect(events).toHaveLength(1);
    });

    it('clamps limit between 1 and 500', () => {
      // Requesting 0 should clamp to 1
      const minimal = ctx.feed.query({ limit: 0 });
      expect(minimal).toHaveLength(1);

      // Requesting 999 should clamp to 500 (but we only have 3 events)
      const maxed = ctx.feed.query({ limit: 999 });
      expect(maxed).toHaveLength(3);
    });
  });

  describe('recent', () => {
    it('returns latest events in descending order', () => {
      ctx.feed.log(alice.id, 'commit', null, 'first');
      ctx.feed.log(alice.id, 'commit', null, 'second');
      ctx.feed.log(alice.id, 'commit', null, 'third');

      const recent = ctx.feed.recent(2);
      expect(recent).toHaveLength(2);
      // Most recent first
      expect(recent[0].preview).toBe('third');
      expect(recent[1].preview).toBe('second');
    });
  });

  describe('count', () => {
    it('returns 0 when no events exist', () => {
      expect(ctx.feed.count()).toBe(0);
    });

    it('returns correct count after logging', () => {
      ctx.feed.log(alice.id, 'commit');
      ctx.feed.log(alice.id, 'test_pass');
      expect(ctx.feed.count()).toBe(2);
    });
  });

  describe('auto-emission via MCP handlers', () => {
    it('creates feed event on agent registration', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'feed-agent' });

      // Registration should have auto-logged a 'register' feed event
      const events = ctx.feed.query({ type: 'register' });
      expect(events.length).toBeGreaterThanOrEqual(1);
      expect(events.some((e) => e.type === 'register')).toBe(true);
    });

    it('creates feed event on message send', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      h1('comm_register', { name: 'sender-feed' });
      h2('comm_register', { name: 'receiver-feed' });

      h1('comm_send', { to: 'receiver-feed', content: 'hello feed' });

      const events = ctx.feed.query({ type: 'message' });
      expect(events.length).toBeGreaterThanOrEqual(1);
    });

    it('creates feed event on state change', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'state-feed' });

      h('comm_state', { action: 'set', key: 'test-key', value: 'test-value' });

      const events = ctx.feed.query({ type: 'state_change' });
      expect(events.length).toBeGreaterThanOrEqual(1);
    });
  });
});
