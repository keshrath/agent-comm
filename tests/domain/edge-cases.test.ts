// =============================================================================
// Edge case tests — boundary values, security properties, data integrity
//
// Tests here cover non-obvious behavior that isn't already verified in the
// per-domain test files. Focuses on: boundary values, injection prevention,
// concurrent operations, and cross-domain interactions.
// =============================================================================

import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';
import { MessageService } from '../../src/domain/messages.js';
import { EventBus } from '../../src/domain/events.js';

// ---------------------------------------------------------------------------
// Agent name boundary values
// ---------------------------------------------------------------------------

describe('Agent name boundaries', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => {
    ctx.close();
  });

  it('accepts 2-char name (min) and 64-char name (max)', () => {
    expect(ctx.agents.register({ name: 'ab' }).name).toBe('ab');
    const long = 'a' + 'b'.repeat(62) + 'c';
    expect(ctx.agents.register({ name: long }).name).toBe(long);
  });

  it('rejects 1-char and 65-char names', () => {
    expect(() => ctx.agents.register({ name: 'x' })).toThrow('Invalid agent name');
    expect(() => ctx.agents.register({ name: 'a' + 'b'.repeat(63) + 'c' })).toThrow(
      'Invalid agent name',
    );
  });

  it('rejects special chars at start/end, spaces, unicode, null bytes', () => {
    for (const bad of ['.agent', 'agent.', '_agent', 'agent-', 'my agent', 'agënt', 'agent\x00']) {
      expect(() => ctx.agents.register({ name: bad })).toThrow();
    }
  });

  it('trims whitespace and rejects whitespace-only', () => {
    expect(ctx.agents.register({ name: '  trimmed  ' }).name).toBe('trimmed');
    expect(() => ctx.agents.register({ name: '   ' })).toThrow();
  });

  it('rejects >20 capabilities and metadata >10KB', () => {
    const caps = Array.from({ length: 21 }, (_, i) => `cap-${i}`);
    expect(() => ctx.agents.register({ name: 'too-many-caps', capabilities: caps })).toThrow(
      'Maximum 20',
    );
    expect(() =>
      ctx.agents.register({ name: 'big-meta', metadata: { d: 'x'.repeat(10_000) } }),
    ).toThrow('Metadata exceeds');
  });
});

// ---------------------------------------------------------------------------
// Message content injection and boundaries
// ---------------------------------------------------------------------------

describe('Message content boundaries', () => {
  let ctx: AppContext;
  let alice: { id: string };
  let bob: { id: string };

  beforeEach(() => {
    ctx = createTestContext();
    alice = ctx.agents.register({ name: 'alice' });
    bob = ctx.agents.register({ name: 'bob' });
  });
  afterEach(() => {
    ctx.close();
  });

  it('accepts content at 50KB max, rejects 50001', () => {
    expect(
      ctx.messages.send(alice.id, { to: bob.id, content: 'x'.repeat(50_000) }).content.length,
    ).toBe(50_000);
    expect(() => ctx.messages.send(alice.id, { to: bob.id, content: 'x'.repeat(50_001) })).toThrow(
      'exceeds',
    );
  });

  it('rejects null bytes, accepts unicode and whitespace-only', () => {
    expect(() => ctx.messages.send(alice.id, { to: bob.id, content: 'before\x00after' })).toThrow(
      'null bytes',
    );
    expect(ctx.messages.send(alice.id, { to: bob.id, content: '日本語 🎉' }).content).toBe(
      '日本語 🎉',
    );
    expect(ctx.messages.send(alice.id, { to: bob.id, content: '  \n\t  ' }).content).toBe(
      '  \n\t  ',
    );
  });

  it('SQL injection in content is stored safely', () => {
    const content = "'; DROP TABLE messages; --";
    expect(ctx.messages.send(alice.id, { to: bob.id, content }).content).toBe(content);
  });

  it('rejects non-string, null, undefined, empty content', () => {
    expect(() =>
      ctx.messages.send(alice.id, { to: bob.id, content: 123 as unknown as string }),
    ).toThrow();
    expect(() =>
      ctx.messages.send(alice.id, { to: bob.id, content: null as unknown as string }),
    ).toThrow();
    expect(() => ctx.messages.send(alice.id, { to: bob.id, content: '' })).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Broadcast atomicity and edge cases
// ---------------------------------------------------------------------------

describe('Broadcast edge cases', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => {
    ctx.close();
  });

  it('returns empty array when no other agents online', () => {
    const sender = ctx.agents.register({ name: 'lonely' });
    expect(ctx.messages.broadcast(sender.id, 'hello?')).toEqual([]);
  });

  it('excludes offline agents', () => {
    const sender = ctx.agents.register({ name: 'bc-sender' });
    const online = ctx.agents.register({ name: 'bc-online' });
    const offline = ctx.agents.register({ name: 'bc-offline' });
    ctx.agents.unregister(offline.id);
    const msgs = ctx.messages.broadcast(sender.id, 'test');
    expect(msgs).toHaveLength(1);
    expect(msgs[0].to_agent).toBe(online.id);
  });

  it('throws without agent lookup configured', () => {
    const svc = new MessageService(ctx.db, new EventBus());
    const sender = ctx.agents.register({ name: 'no-lookup' });
    expect(() => svc.broadcast(sender.id, 'test')).toThrow('Agent lookup not configured');
  });
});

// ---------------------------------------------------------------------------
// Threading
// ---------------------------------------------------------------------------

describe('Thread edge cases', () => {
  let ctx: AppContext;
  let alice: { id: string };
  let bob: { id: string };

  beforeEach(() => {
    ctx = createTestContext();
    alice = ctx.agents.register({ name: 'alice' });
    bob = ctx.agents.register({ name: 'bob' });
  });
  afterEach(() => {
    ctx.close();
  });

  it('deeply nested thread (50 replies) retrieves all', () => {
    const root = ctx.messages.send(alice.id, { to: bob.id, content: 'root' });
    for (let i = 0; i < 50; i++) {
      ctx.messages.send(i % 2 === 0 ? bob.id : alice.id, {
        to: i % 2 === 0 ? alice.id : bob.id,
        content: `reply-${i}`,
        thread_id: root.id,
      });
    }
    expect(ctx.messages.thread(root.id)).toHaveLength(51);
  });

  it('thread retrieval from any reply returns full thread', () => {
    const root = ctx.messages.send(alice.id, { to: bob.id, content: 'root' });
    ctx.messages.send(bob.id, { to: alice.id, content: 'r1', thread_id: root.id });
    const r2 = ctx.messages.send(alice.id, { to: bob.id, content: 'r2', thread_id: root.id });
    expect(ctx.messages.thread(r2.id)).toHaveLength(3);
  });

  it('rejects thread_id to non-existent message', () => {
    expect(() =>
      ctx.messages.send(alice.id, { to: bob.id, content: 'x', thread_id: 999999 }),
    ).toThrow('not found');
  });
});

// ---------------------------------------------------------------------------
// FTS5 injection prevention
// ---------------------------------------------------------------------------

describe('FTS5 search injection prevention', () => {
  let ctx: AppContext;
  let alice: { id: string };
  let bob: { id: string };

  beforeEach(() => {
    ctx = createTestContext();
    alice = ctx.agents.register({ name: 'alice' });
    bob = ctx.agents.register({ name: 'bob' });
    ctx.messages.send(alice.id, { to: bob.id, content: 'hello world test' });
  });
  afterEach(() => {
    ctx.close();
  });

  it('strips FTS5 operators without crashing', () => {
    expect(ctx.messages.search('^caret').length).toBeGreaterThanOrEqual(0);
    expect(ctx.messages.search('"*^{}[]:').length).toBe(0);
    expect(ctx.messages.search('hello AND NOT world OR test')).toHaveLength(1);
    expect(ctx.messages.search('backslash\\data').length).toBeGreaterThanOrEqual(0);
  });

  it('empty/whitespace-only queries return empty', () => {
    expect(ctx.messages.search('')).toEqual([]);
    expect(ctx.messages.search('   ')).toEqual([]);
    expect(ctx.messages.search('***^^^')).toEqual([]);
  });

  it('rejects queries over 1000 chars', () => {
    expect(() => ctx.messages.search('x'.repeat(1001))).toThrow('too long');
  });

  it('search respects channel and from filters', () => {
    const ch = ctx.channels.create('search-ch', alice.id);
    ctx.channels.join(ch.id, bob.id);
    ctx.messages.send(alice.id, { channel: ch.id, content: 'channel findable' });
    ctx.messages.send(bob.id, { to: alice.id, content: 'direct findable' });
    expect(ctx.messages.search('findable', { channel: ch.id })).toHaveLength(1);
    expect(ctx.messages.search('findable', { from: bob.id })).toHaveLength(1);
  });

  it('FTS index updates on edit and delete', () => {
    const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'original unique789' });
    ctx.messages.edit(msg.id, alice.id, 'updated unique789');
    expect(ctx.messages.search('updated')).toHaveLength(1);
    ctx.messages.delete(msg.id, alice.id);
    expect(ctx.messages.search('unique789')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Archived channel operations
// ---------------------------------------------------------------------------

describe('Archived channel operations', () => {
  let ctx: AppContext;
  let creator: { id: string };
  let channelId: string;

  beforeEach(() => {
    ctx = createTestContext();
    creator = ctx.agents.register({ name: 'creator' });
    const other = ctx.agents.register({ name: 'other' });
    const ch = ctx.channels.create('archived-ch', creator.id);
    channelId = ch.id;
    ctx.channels.join(channelId, other.id);
    ctx.channels.archive(channelId);
  });
  afterEach(() => {
    ctx.close();
  });

  it('cannot join, getByName returns null, list excludes by default', () => {
    const newcomer = ctx.agents.register({ name: 'newcomer' });
    expect(() => ctx.channels.join(channelId, newcomer.id)).toThrow('archived');
    expect(ctx.channels.getByName('archived-ch')).toBeNull();
    expect(ctx.channels.list().find((c) => c.id === channelId)).toBeUndefined();
    expect(ctx.channels.list(true).find((c) => c.id === channelId)).toBeDefined();
  });

  it('re-creating unarchives and preserves ID', () => {
    const ch = ctx.channels.create('archived-ch', creator.id, 'Revived');
    expect(ch.archived_at).toBeNull();
    expect(ch.id).toBe(channelId);
  });

  it('archive by non-creator throws', () => {
    const other = ctx.agents.register({ name: 'not-creator' });
    const ch = ctx.channels.create('protected', creator.id);
    expect(() => ctx.channels.archive(ch.id, other.id)).toThrow('Only the channel creator');
  });
});

// ---------------------------------------------------------------------------
// Channel name boundaries
// ---------------------------------------------------------------------------

describe('Channel name boundaries', () => {
  let ctx: AppContext;
  let agentId: string;

  beforeEach(() => {
    ctx = createTestContext();
    agentId = ctx.agents.register({ name: 'ch-tester' }).id;
  });
  afterEach(() => {
    ctx.close();
  });

  it('accepts 2-char (min) and 64-char (max), lowercases input', () => {
    expect(ctx.channels.create('ab', agentId).name).toBe('ab');
    expect(ctx.channels.create('a' + 'b'.repeat(62) + 'c', agentId).name.length).toBe(64);
    expect(ctx.channels.create('MyChannel', agentId).name).toBe('mychannel');
  });

  it('rejects 1-char, 65-char, special at start/end, spaces, unicode', () => {
    for (const bad of ['x', 'a' + 'b'.repeat(63) + 'c', '-bad', 'bad.', 'has space', 'café']) {
      expect(() => ctx.channels.create(bad, agentId)).toThrow('Invalid channel name');
    }
  });
});

// ---------------------------------------------------------------------------
// State service injection and boundaries
// ---------------------------------------------------------------------------

describe('State boundaries and injection', () => {
  let ctx: AppContext;
  let agentId: string;

  beforeEach(() => {
    ctx = createTestContext();
    agentId = ctx.agents.register({ name: 'state-tester' }).id;
  });
  afterEach(() => {
    ctx.close();
  });

  it('accepts max value (100KB) and key (256 chars), rejects over', () => {
    expect(ctx.state.set('default', 'k'.repeat(256), 'v', agentId).key.length).toBe(256);
    expect(ctx.state.set('default', 'big', 'v'.repeat(100_000), agentId).value.length).toBe(
      100_000,
    );
    expect(() => ctx.state.set('default', 'k'.repeat(257), 'v', agentId)).toThrow();
    expect(() => ctx.state.set('default', 'k', 'v'.repeat(100_001), agentId)).toThrow('exceeds');
  });

  it('rejects control characters in namespace and key', () => {
    expect(() => ctx.state.set('ns\x00', 'key', 'val', agentId)).toThrow('control characters');
    expect(() => ctx.state.set('ns', 'key\x01', 'val', agentId)).toThrow('control characters');
  });

  it('SQL injection in key is stored safely', () => {
    expect(ctx.state.set('default', "'; DROP TABLE state;--", 'safe', agentId).value).toBe('safe');
  });

  it('prefix filter escapes SQL wildcards', () => {
    ctx.state.set('default', 'test%key', 'val1', agentId);
    ctx.state.set('default', 'test_key', 'val2', agentId);
    ctx.state.set('default', 'testXkey', 'val3', agentId);
    expect(ctx.state.list('default', 'test%')).toHaveLength(1);
  });

  it('CAS maintains consistency under sequential contention', () => {
    ctx.state.set('default', 'counter', '0', agentId);
    for (let i = 0; i < 20; i++) {
      expect(
        ctx.state.compareAndSwap('default', 'counter', String(i), String(i + 1), agentId),
      ).toBe(true);
    }
    expect(ctx.state.get('default', 'counter')!.value).toBe('20');
  });

  it('CAS fails when value changed underneath', () => {
    ctx.state.set('default', 'race', 'A', agentId);
    ctx.state.set('default', 'race', 'B', agentId);
    expect(ctx.state.compareAndSwap('default', 'race', 'A', 'C', agentId)).toBe(false);
    expect(ctx.state.get('default', 'race')!.value).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// Error paths
// ---------------------------------------------------------------------------

describe('Error paths', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => {
    try {
      ctx.close();
    } catch {
      /* may already be closed */
    }
  });

  it('operations on closed database throw', () => {
    ctx.agents.register({ name: 'pre-close' });
    ctx.close();
    expect(() => ctx.agents.register({ name: 'post-close' })).toThrow();
  });

  it('edit/delete by non-sender throws', () => {
    const alice = ctx.agents.register({ name: 'alice' });
    const bob = ctx.agents.register({ name: 'bob' });
    const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'original' });
    expect(() => ctx.messages.edit(msg.id, bob.id, 'hacked')).toThrow('Only the sender');
    expect(() => ctx.messages.delete(msg.id, bob.id)).toThrow('Only the sender');
  });

  it('operations on non-existent entities throw not-found', () => {
    const agent = ctx.agents.register({ name: 'tester' });
    expect(() => ctx.agents.heartbeat('nonexistent-uuid')).toThrow('not found');
    expect(() => ctx.messages.markRead(999999, agent.id)).toThrow('not found');
    expect(() => ctx.messages.edit(999999, agent.id, 'new')).toThrow('not found');
  });
});

// ---------------------------------------------------------------------------
// Concurrent-like operations
// ---------------------------------------------------------------------------

describe('Concurrent-like operations', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => {
    ctx.close();
  });

  it('two agents CAS same key: only first wins', () => {
    const a1 = ctx.agents.register({ name: 'cas-1' });
    const a2 = ctx.agents.register({ name: 'cas-2' });
    ctx.state.set('default', 'lock', 'free', a1.id);
    expect(ctx.state.compareAndSwap('default', 'lock', 'free', 'agent1', a1.id)).toBe(true);
    expect(ctx.state.compareAndSwap('default', 'lock', 'free', 'agent2', a2.id)).toBe(false);
  });

  it('same-name registration blocked while active, allowed after unregister', () => {
    const a1 = ctx.agents.register({ name: 'race-name' });
    expect(() => ctx.agents.register({ name: 'race-name' })).toThrow('already registered');
    ctx.agents.unregister(a1.id);
    const a2 = ctx.agents.register({ name: 'race-name' });
    expect(a2.id).toBe(a1.id);
  });
});

// ---------------------------------------------------------------------------
// Read/ack edge cases
// ---------------------------------------------------------------------------

describe('Read and acknowledge edge cases', () => {
  let ctx: AppContext;
  let alice: { id: string };
  let bob: { id: string };

  beforeEach(() => {
    ctx = createTestContext();
    alice = ctx.agents.register({ name: 'alice' });
    bob = ctx.agents.register({ name: 'bob' });
  });
  afterEach(() => {
    ctx.close();
  });

  it('double markRead is idempotent', () => {
    const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'read twice' });
    ctx.messages.markRead(msg.id, bob.id);
    ctx.messages.markRead(msg.id, bob.id);
    expect(ctx.messages.readStatus(msg.id)).toHaveLength(1);
  });

  it('acknowledge sets both read and acked_at', () => {
    const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'ack me', ack_required: true });
    ctx.messages.acknowledge(msg.id, bob.id);
    const status = ctx.messages.readStatus(msg.id);
    expect(status).toHaveLength(1);
    expect(status[0].acked_at).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Channel membership
// ---------------------------------------------------------------------------

describe('Channel membership edge cases', () => {
  let ctx: AppContext;
  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => {
    ctx.close();
  });

  it('join is idempotent, leave-rejoin works', () => {
    const agent = ctx.agents.register({ name: 'joiner' });
    const other = ctx.agents.register({ name: 'other' });
    const ch = ctx.channels.create('mem-ch', agent.id);
    ctx.channels.join(ch.id, agent.id);
    expect(ctx.channels.members(ch.id)).toHaveLength(1);

    ctx.channels.join(ch.id, other.id);
    ctx.channels.leave(ch.id, other.id);
    ctx.channels.join(ch.id, other.id);
    expect(ctx.channels.members(ch.id)).toHaveLength(2);
  });

  it('agentChannels excludes archived channels', () => {
    const agent = ctx.agents.register({ name: 'ac-agent' });
    ctx.channels.create('active', agent.id);
    const arch = ctx.channels.create('archived', agent.id);
    ctx.channels.archive(arch.id);
    expect(ctx.channels.agentChannels(agent.id)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Message list options
// ---------------------------------------------------------------------------

describe('Message list options', () => {
  let ctx: AppContext;
  let alice: { id: string };
  let bob: { id: string };

  beforeEach(() => {
    ctx = createTestContext();
    alice = ctx.agents.register({ name: 'alice' });
    bob = ctx.agents.register({ name: 'bob' });
  });
  afterEach(() => {
    ctx.close();
  });

  it('limit clamped between 1 and 500', () => {
    ctx.messages.send(alice.id, { to: bob.id, content: 'msg1' });
    ctx.messages.send(alice.id, { to: bob.id, content: 'msg2' });
    expect(ctx.messages.list({ limit: 0 })).toHaveLength(1);
    expect(ctx.messages.list({ limit: -5 })).toHaveLength(1);
  });

  it('filters by importance and from agent', () => {
    ctx.messages.send(alice.id, { to: bob.id, content: 'normal' });
    ctx.messages.send(alice.id, { to: bob.id, content: 'urgent', importance: 'urgent' });
    ctx.messages.send(bob.id, { to: alice.id, content: 'from bob' });
    expect(ctx.messages.list({ importance: 'urgent' })).toHaveLength(1);
    expect(ctx.messages.list({ from: bob.id })).toHaveLength(1);
  });

  it('offset skips messages', () => {
    for (let i = 0; i < 5; i++) ctx.messages.send(alice.id, { to: bob.id, content: `msg-${i}` });
    expect(ctx.messages.list({ offset: 3, limit: 50 })).toHaveLength(2);
  });
});
