import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';

describe('MessageService', () => {
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

  describe('send', () => {
    it('sends a direct message', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'hello' });
      expect(msg.id).toBeGreaterThan(0);
      expect(msg.from_agent).toBe(alice.id);
      expect(msg.to_agent).toBe(bob.id);
      expect(msg.content).toBe('hello');
      expect(msg.importance).toBe('normal');
      expect(msg.ack_required).toBe(false);
      expect(new Date(msg.created_at).getTime()).toBeGreaterThan(0);
    });

    it('sends with importance and ack_required', () => {
      const msg = ctx.messages.send(alice.id, {
        to: bob.id,
        content: 'urgent!',
        importance: 'urgent',
        ack_required: true,
      });
      expect(msg.importance).toBe('urgent');
      expect(msg.ack_required).toBe(true);
    });

    it('rejects empty content', () => {
      expect(() => ctx.messages.send(alice.id, { to: bob.id, content: '' })).toThrow(
        'non-empty string',
      );
    });

    it('rejects when neither to nor channel specified', () => {
      expect(() => ctx.messages.send(alice.id, { content: 'lost' })).toThrow('Either "to"');
    });

    it('rejects when both to and channel specified', () => {
      expect(() =>
        ctx.messages.send(alice.id, { to: bob.id, channel: 'ch', content: 'x' }),
      ).toThrow('Cannot specify both');
    });
  });

  describe('inbox', () => {
    it('returns messages addressed to the agent', () => {
      ctx.messages.send(alice.id, { to: bob.id, content: 'msg1' });
      ctx.messages.send(alice.id, { to: bob.id, content: 'msg2' });

      const inbox = ctx.messages.inbox(bob.id);
      expect(inbox).toHaveLength(2);
    });

    it('excludes own messages', () => {
      ctx.messages.send(alice.id, { to: bob.id, content: 'from alice' });
      ctx.messages.send(bob.id, { to: alice.id, content: 'from bob' });

      const aliceInbox = ctx.messages.inbox(alice.id);
      expect(aliceInbox).toHaveLength(1);
      expect(aliceInbox[0].content).toBe('from bob');
    });

    it('includes channel messages for joined channels', () => {
      const channel = ctx.channels.create('general', alice.id);
      ctx.channels.join(channel.id, bob.id);

      ctx.messages.send(alice.id, { channel: channel.id, content: 'channel msg' });

      const inbox = ctx.messages.inbox(bob.id);
      expect(inbox).toHaveLength(1);
      expect(inbox[0].content).toBe('channel msg');
    });

    it('filters unread only', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'read me' });
      ctx.messages.markRead(msg.id, bob.id);

      ctx.messages.send(alice.id, { to: bob.id, content: 'still unread' });

      const unread = ctx.messages.inbox(bob.id, { unreadOnly: true });
      expect(unread).toHaveLength(1);
      expect(unread[0].content).toBe('still unread');
    });
  });

  describe('threading', () => {
    it('creates a thread with replies', () => {
      const root = ctx.messages.send(alice.id, { to: bob.id, content: 'root' });
      ctx.messages.send(bob.id, { to: alice.id, content: 'reply 1', thread_id: root.id });
      ctx.messages.send(alice.id, { to: bob.id, content: 'reply 2', thread_id: root.id });

      const thread = ctx.messages.thread(root.id);
      expect(thread).toHaveLength(3);
      expect(thread[0].content).toBe('root');
      expect(thread[1].content).toBe('reply 1');
      expect(thread[2].content).toBe('reply 2');
    });

    it('resolves thread from a reply id', () => {
      const root = ctx.messages.send(alice.id, { to: bob.id, content: 'root' });
      const reply = ctx.messages.send(bob.id, {
        to: alice.id,
        content: 'reply',
        thread_id: root.id,
      });

      const thread = ctx.messages.thread(reply.id);
      expect(thread).toHaveLength(2);
    });

    it('rejects invalid thread_id', () => {
      expect(() =>
        ctx.messages.send(alice.id, { to: bob.id, content: 'x', thread_id: 99999 }),
      ).toThrow('not found');
    });
  });

  describe('read / acknowledge', () => {
    it('marks a message as read', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'hi' });
      ctx.messages.markRead(msg.id, bob.id);

      const status = ctx.messages.readStatus(msg.id);
      expect(status).toHaveLength(1);
      expect(status[0].agent_id).toBe(bob.id);
      expect(new Date(status[0].read_at).getTime()).toBeGreaterThan(0);
    });

    it('marks all as read', () => {
      ctx.messages.send(alice.id, { to: bob.id, content: 'one' });
      ctx.messages.send(alice.id, { to: bob.id, content: 'two' });

      const count = ctx.messages.markAllRead(bob.id);
      expect(count).toBe(2);

      const unread = ctx.messages.inbox(bob.id, { unreadOnly: true });
      expect(unread).toHaveLength(0);
    });

    it('acknowledges a message', () => {
      const msg = ctx.messages.send(alice.id, {
        to: bob.id,
        content: 'ack me',
        ack_required: true,
      });
      ctx.messages.acknowledge(msg.id, bob.id);

      const status = ctx.messages.readStatus(msg.id);
      expect(status[0].agent_id).toBe(bob.id);
      expect(new Date(status[0].acked_at).getTime()).toBeGreaterThan(0);
    });

    it('rejects ack on non-ack messages', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'no ack' });
      expect(() => ctx.messages.acknowledge(msg.id, bob.id)).toThrow('does not require');
    });
  });

  describe('broadcast', () => {
    it('sends to all online agents except sender', () => {
      const charlie = ctx.agents.register({ name: 'charlie' });
      const msgs = ctx.messages.broadcast(alice.id, 'hey everyone');

      expect(msgs).toHaveLength(2);
      const recipients = msgs.map((m) => m.to_agent);
      expect(recipients).toContain(bob.id);
      expect(recipients).toContain(charlie.id);
      expect(recipients).not.toContain(alice.id);
    });
  });

  describe('search', () => {
    it('finds messages by content', () => {
      ctx.messages.send(alice.id, { to: bob.id, content: 'the quick brown fox' });
      ctx.messages.send(alice.id, { to: bob.id, content: 'lazy dog' });

      const results = ctx.messages.search('fox');
      expect(results).toHaveLength(1);
      expect(results[0].message.content).toContain('fox');
    });
  });

  describe('edit / delete', () => {
    it('edits a message', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'typo' });
      const edited = ctx.messages.edit(msg.id, alice.id, 'fixed');
      expect(edited.content).toBe('fixed');
      expect(new Date(edited.edited_at!).getTime()).toBeGreaterThan(0);
    });

    it('rejects edit by non-sender', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'mine' });
      expect(() => ctx.messages.edit(msg.id, bob.id, 'not mine')).toThrow('Only the sender');
    });

    it('deletes a message', () => {
      const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'gone' });
      ctx.messages.delete(msg.id, alice.id);
      expect(ctx.messages.getById(msg.id)).toBeNull();
    });
  });

  describe('events', () => {
    it('emits message:sent with full payload', () => {
      const events: Array<{ type: string; data: Record<string, unknown> }> = [];
      ctx.events.on('message:sent', (e) => events.push(e as (typeof events)[0]));
      ctx.messages.send(alice.id, { to: bob.id, content: 'evented' });
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe('message:sent');
      const message = events[0].data.message as Record<string, unknown>;
      expect(message.from_agent).toBe(alice.id);
      expect(message.to_agent).toBe(bob.id);
      expect(message.content).toBe('evented');
    });
  });
});
