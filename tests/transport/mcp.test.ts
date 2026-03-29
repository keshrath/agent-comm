import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';
import { createToolHandler } from '../../src/transport/mcp.js';

describe('MCP Tool Handler', () => {
  let ctx: AppContext;
  let handle: ReturnType<typeof createToolHandler>;

  beforeEach(() => {
    ctx = createTestContext();
    handle = createToolHandler(ctx);
  });
  afterEach(() => {
    ctx.close();
  });

  describe('registration flow', () => {
    it('registers and returns agent identity', () => {
      const result = handle('comm_register', { name: 'test-agent' }) as Record<string, unknown>;
      expect(result.id as string).toMatch(/^[a-f0-9-]+$/);
      expect(result.name).toBe('test-agent');
      expect(result.status).toBe('online');
    });

    it('comm_agents whoami returns full agent after register', () => {
      handle('comm_register', { name: 'whoami-agent', capabilities: ['a', 'b'] });
      const me = handle('comm_agents', { action: 'whoami' }) as Record<string, unknown>;
      expect(me.name).toBe('whoami-agent');
      expect(me.capabilities).toEqual(['a', 'b']);
      expect(me.status).toBe('online');
      expect(me.id as string).toMatch(/^[a-f0-9-]+$/);
      expect(new Date(me.registered_at as string).getTime()).toBeGreaterThan(0);
    });

    it('rejects tools before registration', () => {
      expect(() => handle('comm_send', { to: 'x', content: 'y' })).toThrow('Not registered');
    });
  });

  describe('messaging flow', () => {
    it('sends and receives direct messages', () => {
      const handler1 = createToolHandler(ctx);
      const handler2 = createToolHandler(ctx);

      handler1('comm_register', { name: 'sender' });
      handler2('comm_register', { name: 'receiver' });

      handler1('comm_send', { to: 'receiver', content: 'hello from sender' });

      const inbox = handler2('comm_inbox', {}) as unknown[];
      expect(inbox).toHaveLength(1);
      expect((inbox[0] as Record<string, unknown>).content).toBe('hello from sender');
    });

    it('broadcasts to all agents', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      const h3 = createToolHandler(ctx);

      h1('comm_register', { name: 'broadcaster' });
      h2('comm_register', { name: 'listener1' });
      h3('comm_register', { name: 'listener2' });

      const result = h1('comm_send', { content: 'attention!', broadcast: true }) as {
        sent: number;
      };
      expect(result.sent).toBe(2);
    });
  });

  describe('channel flow', () => {
    it('creates, joins, and posts to a channel', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);

      h1('comm_register', { name: 'alice' });
      h2('comm_register', { name: 'bob' });

      h1('comm_channel', { action: 'create', channel: 'dev', description: 'Dev chat' });
      h2('comm_channel', { action: 'join', channel: 'dev' });

      h1('comm_send', { channel: 'dev', content: 'channel message' });

      const inbox = h2('comm_inbox', {}) as unknown[];
      expect(inbox).toHaveLength(1);
    });
  });

  describe('state flow', () => {
    it('compare-and-swap works atomically', () => {
      handle('comm_register', { name: 'cas-agent' });

      handle('comm_state', { action: 'set', key: 'counter', value: '1' });

      const ok = handle('comm_state', {
        action: 'cas',
        key: 'counter',
        expected: '1',
        new_value: '2',
      }) as { swapped: boolean };
      expect(ok.swapped).toBe(true);

      const fail = handle('comm_state', {
        action: 'cas',
        key: 'counter',
        expected: '1',
        new_value: '3',
      }) as { swapped: boolean };
      expect(fail.swapped).toBe(false);
    });
  });

  describe('discovery', () => {
    it('finds agents by capability', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);

      h1('comm_register', { name: 'coder', capabilities: ['typescript', 'python'] });
      h2('comm_register', { name: 'designer', capabilities: ['figma', 'css'] });

      const found = h1('comm_agents', { action: 'list', capability: 'python' }) as unknown[];
      expect(found).toHaveLength(1);
      expect((found[0] as Record<string, unknown>).name).toBe('coder');
    });
  });

  describe('agent lifecycle', () => {
    it('heartbeat and unregister', () => {
      handle('comm_register', { name: 'lifecycle' });
      expect(handle('comm_agents', { action: 'heartbeat' })).toEqual({ success: true });
      expect(handle('comm_agents', { action: 'unregister' })).toEqual({ success: true });
      expect(() => handle('comm_agents', { action: 'whoami' })).toThrow('Not registered');
    });
  });

  describe('authorization', () => {
    it('requires registration for all reading tools', () => {
      const h = createToolHandler(ctx);
      expect(() => h('comm_message', { action: 'thread', message_id: 1 })).toThrow(
        'Not registered',
      );
      expect(() => h('comm_search', { query: 'x' })).toThrow('Not registered');
      expect(() => h('comm_channel', { action: 'list' })).toThrow('Not registered');
      expect(() => h('comm_channel', { action: 'members', channel: 'x' })).toThrow(
        'Not registered',
      );
      expect(() => h('comm_state', { action: 'get', key: 'x' })).toThrow('Not registered');
      expect(() => h('comm_state', { action: 'list' })).toThrow('Not registered');
      expect(() => h('comm_state', { action: 'delete', key: 'x' })).toThrow('Not registered');
    });
  });

  describe('channel membership enforcement', () => {
    it('requires membership to post to a channel', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);

      h1('comm_register', { name: 'ch-creator' });
      h2('comm_register', { name: 'ch-outsider' });

      h1('comm_channel', { action: 'create', channel: 'private-ch' });

      expect(() => h2('comm_send', { channel: 'private-ch', content: 'intruder' })).toThrow(
        'must join',
      );
    });
  });

  describe('input validation', () => {
    it('rejects non-string name', () => {
      expect(() => handle('comm_register', { name: 123 })).toThrow(
        '"name" must be a non-empty string',
      );
    });

    it('rejects missing content', () => {
      handle('comm_register', { name: 'validator' });
      ctx.agents.register({ name: 'target' });
      expect(() => handle('comm_send', { to: 'target', content: '' })).toThrow();
    });
  });

  describe('consolidated tools', () => {
    it('comm_channel archive works for creator', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'archiver' });
      h('comm_channel', { action: 'create', channel: 'to-archive' });
      const result = h('comm_channel', { action: 'archive', channel: 'to-archive' });
      expect(result).toEqual({ success: true, channel: 'to-archive' });
    });

    it('comm_message delete works for sender', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      h1('comm_register', { name: 'deleter' });
      h2('comm_register', { name: 'del-target' });
      const msg = h1('comm_send', { to: 'del-target', content: 'bye' }) as { id: number };
      const result = h1('comm_message', { action: 'delete', message_id: msg.id });
      expect(result).toEqual({ success: true });
    });
  });

  describe('comm_handoff', () => {
    it('sends a structured handoff message to the target agent', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      h1('comm_register', { name: 'hand-off-sender' });
      h2('comm_register', { name: 'hand-off-receiver' });

      const result = h1('comm_handoff', {
        to: 'hand-off-receiver',
        context: 'Please continue the auth implementation',
      }) as {
        handoff_message: { id: number; content: string };
        from: string;
        to: string;
        thread_included: boolean;
      };

      expect(result.from).toBe('hand-off-sender');
      expect(result.to).toBe('hand-off-receiver');
      expect(result.thread_included).toBe(false);
      expect(result.handoff_message.content).toContain('HANDOFF');
      expect(result.handoff_message.content).toContain('auth implementation');
    });

    it('includes thread history when thread_id is provided', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      h1('comm_register', { name: 'ho-sender' });
      h2('comm_register', { name: 'ho-receiver' });

      const original = h1('comm_send', { to: 'ho-receiver', content: 'Starting work on auth' }) as {
        id: number;
      };
      h2('comm_send', { reply_to: original.id, content: 'Got it, will help' });

      const result = h1('comm_handoff', {
        to: 'ho-receiver',
        thread_id: original.id,
        context: 'Take over',
      }) as { handoff_message: { content: string }; thread_included: boolean };

      expect(result.thread_included).toBe(true);
      expect(result.handoff_message.content).toContain('Thread history');
    });

    it('requires registration', () => {
      const h = createToolHandler(ctx);
      expect(() => h('comm_handoff', { to: 'someone' })).toThrow('Not registered');
    });
  });

  describe('error handling', () => {
    it('throws for unknown tools', () => {
      expect(() => handle('comm_nonexistent', {})).toThrow('Unknown tool');
    });

    it('throws for non-existent agent target', () => {
      handle('comm_register', { name: 'lonely' });
      expect(() => handle('comm_send', { to: 'nobody', content: 'hi' })).toThrow('Agent not found');
    });

    it('throws for non-existent channel', () => {
      handle('comm_register', { name: 'lost' });
      expect(() => handle('comm_send', { channel: 'nowhere', content: 'hi' })).toThrow(
        'Channel not found',
      );
    });
  });

  // -------------------------------------------------------------------------
  // comm_agents status action
  // -------------------------------------------------------------------------

  describe('comm_agents status', () => {
    it('sets and clears agent status text', () => {
      handle('comm_register', { name: 'status-user' });
      const result = handle('comm_agents', {
        action: 'status',
        status_text: 'reviewing PR #42',
      }) as {
        success: boolean;
        status_text: string | null;
      };
      expect(result.success).toBe(true);
      expect(result.status_text).toBe('reviewing PR #42');

      const me = handle('comm_agents', { action: 'whoami' }) as Record<string, unknown>;
      expect(me.status_text).toBe('reviewing PR #42');

      handle('comm_agents', { action: 'status' });
      const me2 = handle('comm_agents', { action: 'whoami' }) as Record<string, unknown>;
      expect(me2.status_text).toBeNull();
    });

    it('requires registration', () => {
      const h = createToolHandler(ctx);
      expect(() => h('comm_agents', { action: 'status', status_text: 'hello' })).toThrow(
        'Not registered',
      );
    });
  });

  describe('comm_channel update', () => {
    it('updates channel description via MCP tool', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'ch-updater' });
      h('comm_channel', { action: 'create', channel: 'updatable', description: 'original' });
      const result = h('comm_channel', {
        action: 'update',
        channel: 'updatable',
        description: 'new desc',
      }) as Record<string, unknown>;
      expect(result.description).toBe('new desc');
    });

    it('clears description when omitted', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'ch-clearer' });
      h('comm_channel', { action: 'create', channel: 'clearable', description: 'has desc' });
      const result = h('comm_channel', {
        action: 'update',
        channel: 'clearable',
      }) as Record<string, unknown>;
      expect(result.description).toBeNull();
    });

    it('throws for nonexistent channel', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'ch-nope' });
      expect(() =>
        h('comm_channel', { action: 'update', channel: 'ghost', description: 'x' }),
      ).toThrow('Channel not found');
    });
  });

  describe('comm_react', () => {
    it('full reaction lifecycle via MCP tools', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      h1('comm_register', { name: 'reactor' });
      h2('comm_register', { name: 'reactor-b' });

      const msg = h1('comm_send', { to: 'reactor-b', content: 'test msg' }) as { id: number };

      // Both agents react (action defaults to "add")
      expect(h1('comm_react', { message_id: msg.id, reaction: 'done' })).toEqual({ success: true });
      expect(h2('comm_react', { message_id: msg.id, reaction: 'done' })).toEqual({ success: true });
      expect(h2('comm_react', { message_id: msg.id, reaction: 'nice' })).toEqual({ success: true });

      // Verify reactions via domain
      const reactions = ctx.reactions.getForMessage(msg.id);
      expect(reactions).toHaveLength(3);

      // Explicit remove action
      expect(h1('comm_react', { action: 'remove', message_id: msg.id, reaction: 'done' })).toEqual({
        success: true,
      });
      expect(ctx.reactions.getForMessage(msg.id)).toHaveLength(2);
    });

    it('requires registration', () => {
      const h = createToolHandler(ctx);
      expect(() => h('comm_react', { message_id: 1, reaction: '+1' })).toThrow('Not registered');
    });

    it('validates reaction text', () => {
      handle('comm_register', { name: 'bad-reactor' });
      ctx.agents.register({ name: 'react-target' });
      const msg = handle('comm_send', { to: 'react-target', content: 'x' }) as { id: number };
      expect(() => handle('comm_react', { message_id: msg.id, reaction: '' })).toThrow();
    });
  });

  describe('rate limiting on send paths', () => {
    it('blocks after burst on comm_send direct', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'spammer' });
      ctx.agents.register({ name: 'spam-target' });

      // Exhaust the bucket (10 burst)
      for (let i = 0; i < 10; i++) {
        h('comm_send', { to: 'spam-target', content: `msg ${i}` });
      }
      expect(() => h('comm_send', { to: 'spam-target', content: 'overflow' })).toThrow(
        'Rate limit',
      );
    });

    it('blocks on comm_send channel', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'ch-spammer' });
      h('comm_channel', { action: 'create', channel: 'spam-ch' });

      for (let i = 0; i < 10; i++) {
        h('comm_send', { channel: 'spam-ch', content: `msg ${i}` });
      }
      expect(() => h('comm_send', { channel: 'spam-ch', content: 'overflow' })).toThrow(
        'Rate limit',
      );
    });

    it('blocks on comm_send broadcast', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      h1('comm_register', { name: 'bc-spammer' });
      h2('comm_register', { name: 'bc-listener' });

      for (let i = 0; i < 10; i++) {
        h1('comm_send', { content: `msg ${i}`, broadcast: true });
      }
      expect(() => h1('comm_send', { content: 'overflow', broadcast: true })).toThrow('Rate limit');
    });
  });

  describe('comm_send reply and forward with reactions', () => {
    it('reply + react flow', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      h1('comm_register', { name: 'replier' });
      h2('comm_register', { name: 'reply-target' });

      const original = h1('comm_send', { to: 'reply-target', content: 'question?' }) as {
        id: number;
      };
      const reply = h2('comm_send', { reply_to: original.id, content: 'answer!' }) as {
        id: number;
        thread_id: number;
      };
      expect(reply.thread_id).toBe(original.id);

      // React to the reply
      h1('comm_react', { message_id: reply.id, reaction: 'thanks' });
      expect(ctx.reactions.getForMessage(reply.id)).toHaveLength(1);
    });
  });

  describe('comm_send forward', () => {
    it('forwards a message with comment', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      h1('comm_register', { name: 'fwd-sender' });
      h2('comm_register', { name: 'fwd-receiver' });

      const original = h1('comm_send', { to: 'fwd-receiver', content: 'important info' }) as {
        id: number;
      };

      const h3 = createToolHandler(ctx);
      h3('comm_register', { name: 'fwd-target' });

      h2('comm_send', {
        forward: original.id,
        to: 'fwd-target',
        content: 'FYI see this',
        comment: 'Check this out',
      });

      const inbox = h3('comm_inbox', {}) as { content: string }[];
      expect(inbox).toHaveLength(1);
      expect(inbox[0].content).toContain('Forwarded from fwd-sender');
      expect(inbox[0].content).toContain('important info');
    });
  });

  describe('comm_agents invalid action', () => {
    it('throws for unknown action', () => {
      handle('comm_register', { name: 'test-invalid' });
      expect(() => handle('comm_agents', { action: 'invalid' })).toThrow('Unknown action');
    });
  });

  describe('comm_message invalid action', () => {
    it('throws for unknown action', () => {
      handle('comm_register', { name: 'test-msg-invalid' });
      expect(() => handle('comm_message', { action: 'invalid' })).toThrow('Unknown action');
    });
  });

  describe('comm_channel invalid action', () => {
    it('throws for unknown action', () => {
      handle('comm_register', { name: 'test-ch-invalid' });
      expect(() => handle('comm_channel', { action: 'invalid' })).toThrow('Unknown action');
    });
  });

  describe('comm_state invalid action', () => {
    it('throws for unknown action', () => {
      handle('comm_register', { name: 'test-state-invalid' });
      expect(() => handle('comm_state', { action: 'invalid' })).toThrow('Unknown action');
    });
  });

  describe('comm_feed invalid action', () => {
    it('throws for unknown action', () => {
      handle('comm_register', { name: 'test-feed-invalid' });
      expect(() => handle('comm_feed', { action: 'invalid' })).toThrow('Unknown action');
    });
  });

  describe('comm_react invalid action', () => {
    it('throws for unknown action', () => {
      handle('comm_register', { name: 'test-react-invalid' });
      expect(() =>
        handle('comm_react', { action: 'invalid', message_id: 1, reaction: 'x' }),
      ).toThrow('Unknown action');
    });
  });
});
