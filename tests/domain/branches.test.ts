import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';

describe('BranchService', () => {
  let ctx: AppContext;
  let alice: { id: string; name: string };
  let bob: { id: string; name: string };

  beforeEach(() => {
    ctx = createTestContext();
    alice = ctx.agents.register({ name: 'alice' });
    bob = ctx.agents.register({ name: 'bob' });
  });
  afterEach(() => {
    ctx.close();
  });

  describe('create', () => {
    it('creates a branch from a valid message', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'fork me' });
      const branch = ctx.branches.create(msg.id, alice.id, 'my-branch');

      expect(branch.id).toBeGreaterThan(0);
      expect(branch.parent_message_id).toBe(msg.id);
      expect(branch.name).toBe('my-branch');
      expect(branch.created_by).toBe(alice.id);
      expect(new Date(branch.created_at).getTime()).toBeGreaterThan(0);
    });

    it('creates a branch without a name', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'fork me' });
      const branch = ctx.branches.create(msg.id, alice.id);

      expect(branch.id).toBeGreaterThan(0);
      expect(branch.parent_message_id).toBe(msg.id);
      expect(branch.name).toBeNull();
    });

    it('throws NotFoundError for non-existent message', () => {
      expect(() => ctx.branches.create(99999, alice.id, 'bad')).toThrow('not found');
    });

    it('throws ValidationError for empty branch name', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'fork me' });
      expect(() => ctx.branches.create(msg.id, alice.id, '')).toThrow('1-128 characters');
    });

    it('throws ValidationError for branch name exceeding 128 characters', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'fork me' });
      const longName = 'x'.repeat(129);
      expect(() => ctx.branches.create(msg.id, alice.id, longName)).toThrow('1-128 characters');
    });

    it('accepts branch name at max length (128 characters)', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'fork me' });
      const maxName = 'a'.repeat(128);
      const branch = ctx.branches.create(msg.id, alice.id, maxName);
      expect(branch.name).toBe(maxName);
    });

    it('emits branch:created event', () => {
      const events: unknown[] = [];
      ctx.events.on('branch:created', (e) => events.push(e));

      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'fork me' });
      ctx.branches.create(msg.id, alice.id, 'event-test');

      expect(events).toHaveLength(1);
      const evt = events[0] as { data: { branch: { name: string } } };
      expect(evt.data.branch.name).toBe('event-test');
    });
  });

  describe('list', () => {
    it('returns all branches when no filter specified', () => {
      const msg1 = ctx.messages.send(alice.id, { to: bob.id, content: 'msg1' });
      const msg2 = ctx.messages.send(alice.id, { to: bob.id, content: 'msg2' });

      ctx.branches.create(msg1.id, alice.id, 'branch-a');
      ctx.branches.create(msg2.id, alice.id, 'branch-b');

      const all = ctx.branches.list();
      expect(all).toHaveLength(2);
    });

    it('filters branches by parent message_id', () => {
      const msg1 = ctx.messages.send(alice.id, { to: bob.id, content: 'msg1' });
      const msg2 = ctx.messages.send(alice.id, { to: bob.id, content: 'msg2' });

      ctx.branches.create(msg1.id, alice.id, 'branch-a');
      ctx.branches.create(msg1.id, bob.id, 'branch-b');
      ctx.branches.create(msg2.id, alice.id, 'branch-c');

      const filtered = ctx.branches.list(msg1.id);
      expect(filtered).toHaveLength(2);
      expect(filtered.every((b) => b.parent_message_id === msg1.id)).toBe(true);
    });

    it('returns empty array when no branches exist for message', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'no branches' });
      expect(ctx.branches.list(msg.id)).toEqual([]);
    });
  });

  describe('multiple branches from same parent', () => {
    it('allows creating multiple branches from the same message', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'multi-fork' });

      const b1 = ctx.branches.create(msg.id, alice.id, 'fork-1');
      const b2 = ctx.branches.create(msg.id, bob.id, 'fork-2');
      const b3 = ctx.branches.create(msg.id, alice.id, 'fork-3');

      expect(b1.id).not.toBe(b2.id);
      expect(b2.id).not.toBe(b3.id);

      const branches = ctx.branches.list(msg.id);
      expect(branches).toHaveLength(3);
    });
  });

  describe('branchMessages', () => {
    it('returns parent message for a branch with no additional messages', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'parent' });
      const branch = ctx.branches.create(msg.id, alice.id, 'msgs-test');

      const messages = ctx.branches.branchMessages(branch.id);
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe(msg.id);
      expect(messages[0].content).toBe('parent');
    });

    it('throws NotFoundError for non-existent branch', () => {
      expect(() => ctx.branches.branchMessages(99999)).toThrow('not found');
    });
  });

  describe('count', () => {
    it('returns 0 when no branches exist', () => {
      expect(ctx.branches.count()).toBe(0);
    });

    it('returns correct count after creating branches', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'count-test' });
      ctx.branches.create(msg.id, alice.id, 'one');
      ctx.branches.create(msg.id, alice.id, 'two');

      expect(ctx.branches.count()).toBe(2);
    });
  });
});
