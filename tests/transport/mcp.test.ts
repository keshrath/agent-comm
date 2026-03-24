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
      expect(result.id).toBeDefined();
      expect(result.name).toBe('test-agent');
      expect(result.status).toBe('online');
    });

    it('comm_whoami returns identity after register', () => {
      handle('comm_register', { name: 'whoami-agent' });
      const me = handle('comm_whoami', {}) as Record<string, unknown>;
      expect(me.name).toBe('whoami-agent');
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

      const result = h1('comm_broadcast', { content: 'attention!' }) as { sent: number };
      expect(result.sent).toBe(2);
    });
  });

  describe('channel flow', () => {
    it('creates, joins, and posts to a channel', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);

      h1('comm_register', { name: 'alice' });
      h2('comm_register', { name: 'bob' });

      h1('comm_channel_create', { name: 'dev', description: 'Dev chat' });
      h2('comm_channel_join', { channel: 'dev' });

      h1('comm_channel_send', { channel: 'dev', content: 'channel message' });

      const inbox = h2('comm_inbox', {}) as unknown[];
      expect(inbox).toHaveLength(1);
    });
  });

  describe('state flow', () => {
    it('sets and gets shared state', () => {
      handle('comm_register', { name: 'stater' });

      handle('comm_state_set', { key: 'config', value: '{"debug": true}' });
      const result = handle('comm_state_get', { key: 'config' }) as { value: string } | null;
      expect(result).not.toBeNull();
      expect(result!.value).toBe('{"debug": true}');
    });

    it('compare-and-swap works atomically', () => {
      handle('comm_register', { name: 'cas-agent' });

      handle('comm_state_set', { key: 'counter', value: '1' });

      const ok = handle('comm_state_cas', {
        key: 'counter',
        expected: '1',
        new_value: '2',
      }) as { swapped: boolean };
      expect(ok.swapped).toBe(true);

      const fail = handle('comm_state_cas', {
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

      const found = h1('comm_list_agents', { capability: 'python' }) as unknown[];
      expect(found).toHaveLength(1);
      expect((found[0] as Record<string, unknown>).name).toBe('coder');
    });
  });

  describe('agent lifecycle', () => {
    it('heartbeat and unregister', () => {
      handle('comm_register', { name: 'lifecycle' });
      expect(handle('comm_heartbeat', {})).toEqual({ success: true });
      expect(handle('comm_unregister', {})).toEqual({ success: true });
      expect(() => handle('comm_whoami', {})).toThrow('Not registered');
    });
  });

  describe('authorization', () => {
    it('requires registration for all reading tools', () => {
      const h = createToolHandler(ctx);
      // comm_list_agents is allowed without registration
      expect(() => h('comm_thread', { message_id: 1 })).toThrow('Not registered');
      expect(() => h('comm_search', { query: 'x' })).toThrow('Not registered');
      expect(() => h('comm_channel_list', {})).toThrow('Not registered');
      expect(() => h('comm_channel_members', { channel: 'x' })).toThrow('Not registered');
      expect(() => h('comm_state_get', { key: 'x' })).toThrow('Not registered');
      expect(() => h('comm_state_list', {})).toThrow('Not registered');
      expect(() => h('comm_state_delete', { key: 'x' })).toThrow('Not registered');
    });
  });

  describe('channel membership enforcement', () => {
    it('requires membership to post to a channel', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);

      h1('comm_register', { name: 'ch-creator' });
      h2('comm_register', { name: 'ch-outsider' });

      h1('comm_channel_create', { name: 'private-ch' });

      expect(() => h2('comm_channel_send', { channel: 'private-ch', content: 'intruder' })).toThrow(
        'must join',
      );
    });
  });

  describe('comm_whoami returns full agent', () => {
    it('returns complete agent object with capabilities', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'full-agent', capabilities: ['a', 'b'] });
      const me = h('comm_whoami', {}) as Record<string, unknown>;
      expect(me.id).toBeDefined();
      expect(me.name).toBe('full-agent');
      expect(me.capabilities).toEqual(['a', 'b']);
      expect(me.status).toBe('online');
      expect(me.registered_at).toBeDefined();
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

  describe('new tools', () => {
    it('comm_channel_archive works for creator', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'archiver' });
      h('comm_channel_create', { name: 'to-archive' });
      const result = h('comm_channel_archive', { channel: 'to-archive' });
      expect(result).toEqual({ success: true, channel: 'to-archive' });
    });

    it('comm_delete_message works for sender', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      h1('comm_register', { name: 'deleter' });
      h2('comm_register', { name: 'del-target' });
      const msg = h1('comm_send', { to: 'del-target', content: 'bye' }) as { id: number };
      const result = h1('comm_delete_message', { message_id: msg.id });
      expect(result).toEqual({ success: true });
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
      expect(() => handle('comm_channel_send', { channel: 'nowhere', content: 'hi' })).toThrow(
        'Channel not found',
      );
    });
  });

  // -------------------------------------------------------------------------
  // v0.3.0 integration tests
  // -------------------------------------------------------------------------

  describe('comm_set_status', () => {
    it('sets and clears agent status text', () => {
      handle('comm_register', { name: 'status-user' });
      const result = handle('comm_set_status', { text: 'reviewing PR #42' }) as {
        success: boolean;
        status_text: string | null;
      };
      expect(result.success).toBe(true);
      expect(result.status_text).toBe('reviewing PR #42');

      const me = handle('comm_whoami', {}) as Record<string, unknown>;
      expect(me.status_text).toBe('reviewing PR #42');

      handle('comm_set_status', {});
      const me2 = handle('comm_whoami', {}) as Record<string, unknown>;
      expect(me2.status_text).toBeNull();
    });

    it('requires registration', () => {
      const h = createToolHandler(ctx);
      expect(() => h('comm_set_status', { text: 'hello' })).toThrow('Not registered');
    });
  });

  describe('comm_channel_update', () => {
    it('updates channel description via MCP tool', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'ch-updater' });
      h('comm_channel_create', { name: 'updatable', description: 'original' });
      const result = h('comm_channel_update', {
        channel: 'updatable',
        description: 'new desc',
      }) as Record<string, unknown>;
      expect(result.description).toBe('new desc');
    });

    it('clears description when omitted', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'ch-clearer' });
      h('comm_channel_create', { name: 'clearable', description: 'has desc' });
      const result = h('comm_channel_update', { channel: 'clearable' }) as Record<string, unknown>;
      expect(result.description).toBeNull();
    });

    it('throws for nonexistent channel', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'ch-nope' });
      expect(() => h('comm_channel_update', { channel: 'ghost', description: 'x' })).toThrow(
        'Channel not found',
      );
    });
  });

  describe('comm_react / comm_unreact', () => {
    it('full reaction lifecycle via MCP tools', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      h1('comm_register', { name: 'reactor' });
      h2('comm_register', { name: 'reactor-b' });

      const msg = h1('comm_send', { to: 'reactor-b', content: 'test msg' }) as { id: number };

      // Both agents react
      expect(h1('comm_react', { message_id: msg.id, reaction: 'done' })).toEqual({ success: true });
      expect(h2('comm_react', { message_id: msg.id, reaction: 'done' })).toEqual({ success: true });
      expect(h2('comm_react', { message_id: msg.id, reaction: 'nice' })).toEqual({ success: true });

      // Verify reactions via domain
      const reactions = ctx.reactions.getForMessage(msg.id);
      expect(reactions).toHaveLength(3);

      expect(h1('comm_unreact', { message_id: msg.id, reaction: 'done' })).toEqual({
        success: true,
      });
      expect(ctx.reactions.getForMessage(msg.id)).toHaveLength(2);
    });

    it('requires registration', () => {
      const h = createToolHandler(ctx);
      expect(() => h('comm_react', { message_id: 1, reaction: '+1' })).toThrow('Not registered');
      expect(() => h('comm_unreact', { message_id: 1, reaction: '+1' })).toThrow('Not registered');
    });

    it('validates reaction text', () => {
      handle('comm_register', { name: 'bad-reactor' });
      ctx.agents.register({ name: 'react-target' });
      const msg = handle('comm_send', { to: 'react-target', content: 'x' }) as { id: number };
      expect(() => handle('comm_react', { message_id: msg.id, reaction: '' })).toThrow();
    });
  });

  describe('rate limiting on send paths', () => {
    it('blocks after burst on comm_send', () => {
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

    it('blocks on comm_channel_send', () => {
      const h = createToolHandler(ctx);
      h('comm_register', { name: 'ch-spammer' });
      h('comm_channel_create', { name: 'spam-ch' });

      for (let i = 0; i < 10; i++) {
        h('comm_channel_send', { channel: 'spam-ch', content: `msg ${i}` });
      }
      expect(() => h('comm_channel_send', { channel: 'spam-ch', content: 'overflow' })).toThrow(
        'Rate limit',
      );
    });

    it('blocks on comm_broadcast', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      h1('comm_register', { name: 'bc-spammer' });
      h2('comm_register', { name: 'bc-listener' });

      for (let i = 0; i < 10; i++) {
        h1('comm_broadcast', { content: `msg ${i}` });
      }
      expect(() => h1('comm_broadcast', { content: 'overflow' })).toThrow('Rate limit');
    });
  });

  describe('comm_reply and comm_forward with reactions', () => {
    it('reply + react flow', () => {
      const h1 = createToolHandler(ctx);
      const h2 = createToolHandler(ctx);
      h1('comm_register', { name: 'replier' });
      h2('comm_register', { name: 'reply-target' });

      const original = h1('comm_send', { to: 'reply-target', content: 'question?' }) as {
        id: number;
      };
      const reply = h2('comm_reply', { message_id: original.id, content: 'answer!' }) as {
        id: number;
        thread_id: number;
      };
      expect(reply.thread_id).toBe(original.id);

      // React to the reply
      h1('comm_react', { message_id: reply.id, reaction: 'thanks' });
      expect(ctx.reactions.getForMessage(reply.id)).toHaveLength(1);
    });
  });
});
