import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';
import { NotFoundError } from '../../src/types.js';
import { CleanupService } from '../../src/domain/cleanup.js';

// ---------------------------------------------------------------------------
// ReactionService
// ---------------------------------------------------------------------------

describe('ReactionService', () => {
  let ctx: AppContext;
  let alice: { id: string; name: string };
  let bob: { id: string; name: string };
  let messageId: number;

  beforeEach(() => {
    ctx = createTestContext();
    alice = ctx.agents.register({ name: 'alice' });
    bob = ctx.agents.register({ name: 'bob' });
    const msg = ctx.messages.send(alice.id, { to: bob.id, content: 'hello' });
    messageId = msg.id;
  });
  afterEach(() => {
    ctx.close();
  });

  it('adds a reaction and retrieves it via getForMessage', () => {
    ctx.reactions.react(messageId, alice.id, 'thumbsup');
    const reactions = ctx.reactions.getForMessage(messageId);
    expect(reactions).toHaveLength(1);
    expect(reactions[0].agent_id).toBe(alice.id);
    expect(reactions[0].reaction).toBe('thumbsup');
    expect(new Date(reactions[0].created_at).getTime()).toBeGreaterThan(0);
  });

  it('removes a reaction with unreact', () => {
    ctx.reactions.react(messageId, alice.id, 'thumbsup');
    ctx.reactions.unreact(messageId, alice.id, 'thumbsup');
    const reactions = ctx.reactions.getForMessage(messageId);
    expect(reactions).toHaveLength(0);
  });

  it('ignores duplicate reactions (INSERT OR IGNORE)', () => {
    ctx.reactions.react(messageId, alice.id, 'thumbsup');
    ctx.reactions.react(messageId, alice.id, 'thumbsup');
    const reactions = ctx.reactions.getForMessage(messageId);
    expect(reactions).toHaveLength(1);
  });

  it('rejects empty reaction', () => {
    expect(() => ctx.reactions.react(messageId, alice.id, '')).toThrow('1-32 characters');
  });

  it('rejects reaction longer than 32 characters', () => {
    const long = 'x'.repeat(33);
    expect(() => ctx.reactions.react(messageId, alice.id, long)).toThrow('1-32 characters');
  });

  it('rejects reaction with control characters', () => {
    expect(() => ctx.reactions.react(messageId, alice.id, 'bad\x00')).toThrow('control characters');
    expect(() => ctx.reactions.react(messageId, alice.id, 'bad\n')).toThrow('control characters');
  });

  it('getForMessages returns reactions grouped by message ID', () => {
    const msg2 = ctx.messages.send(bob.id, { to: alice.id, content: 'world' });
    ctx.reactions.react(messageId, alice.id, 'heart');
    ctx.reactions.react(msg2.id, bob.id, 'fire');

    const result = ctx.reactions.getForMessages([messageId, msg2.id]);
    expect(result[messageId]).toHaveLength(1);
    expect(result[messageId][0].reaction).toBe('heart');
    expect(result[msg2.id]).toHaveLength(1);
    expect(result[msg2.id][0].reaction).toBe('fire');
  });

  it('getForMessages with empty array returns empty object', () => {
    const result = ctx.reactions.getForMessages([]);
    expect(result).toEqual({});
  });

  it('emits message:reacted event on react', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    ctx.events.on('message:reacted', (e) => events.push(e as (typeof events)[0]));
    ctx.reactions.react(messageId, alice.id, 'check');
    expect(events).toHaveLength(1);
    expect(events[0].data.reaction).toBe('check');
    expect(events[0].data.agentId).toBe(alice.id);
  });

  it('emits message:unreacted event on unreact', () => {
    ctx.reactions.react(messageId, alice.id, 'check');
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    ctx.events.on('message:unreacted', (e) => events.push(e as (typeof events)[0]));
    ctx.reactions.unreact(messageId, alice.id, 'check');
    expect(events).toHaveLength(1);
    expect(events[0].data.reaction).toBe('check');
  });

  it('does not emit message:unreacted when nothing was removed', () => {
    const events: unknown[] = [];
    ctx.events.on('message:unreacted', (e) => events.push(e));
    ctx.reactions.unreact(messageId, alice.id, 'nonexistent');
    expect(events).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Agent status text
// ---------------------------------------------------------------------------

describe('AgentService — setStatusText', () => {
  let ctx: AppContext;
  let agentId: string;

  beforeEach(() => {
    ctx = createTestContext();
    agentId = ctx.agents.register({ name: 'status-agent' }).id;
  });
  afterEach(() => {
    ctx.close();
  });

  it('sets status text and returns it via getById', () => {
    ctx.agents.setStatusText(agentId, 'working on task #42');
    const agent = ctx.agents.getById(agentId);
    expect(agent).not.toBeNull();
    expect(agent!.status_text).toBe('working on task #42');
  });

  it('clears status text when set to null', () => {
    ctx.agents.setStatusText(agentId, 'busy');
    ctx.agents.setStatusText(agentId, null);
    const agent = ctx.agents.getById(agentId);
    expect(agent!.status_text).toBeNull();
  });

  it('rejects text longer than 256 characters', () => {
    const longText = 'x'.repeat(257);
    expect(() => ctx.agents.setStatusText(agentId, longText)).toThrow(
      'exceeds maximum length of 256',
    );
  });

  it('rejects text with control characters', () => {
    expect(() => ctx.agents.setStatusText(agentId, 'hello\x00world')).toThrow('control characters');
    expect(() => ctx.agents.setStatusText(agentId, 'tab\there')).toThrow('control characters');
  });

  it('emits agent:updated event with status_text', () => {
    const events: Array<{ type: string; data: Record<string, unknown> }> = [];
    ctx.events.on('agent:updated', (e) => events.push(e as (typeof events)[0]));
    ctx.agents.setStatusText(agentId, 'deploying');
    expect(events).toHaveLength(1);
    expect(events[0].data.status_text).toBe('deploying');
    expect(events[0].data.agentId).toBe(agentId);
  });
});

// ---------------------------------------------------------------------------
// Channel description update
// ---------------------------------------------------------------------------

describe('ChannelService — updateDescription', () => {
  let ctx: AppContext;
  let agentId: string;

  beforeEach(() => {
    ctx = createTestContext();
    agentId = ctx.agents.register({ name: 'chan-admin' }).id;
  });
  afterEach(() => {
    ctx.close();
  });

  it('updates description and verifies', () => {
    const channel = ctx.channels.create('test-chan', agentId, 'original desc');
    const updated = ctx.channels.updateDescription(channel.id, 'new desc');
    expect(updated.description).toBe('new desc');
  });

  it('clears description by setting to null', () => {
    const channel = ctx.channels.create('test-chan', agentId, 'some desc');
    const updated = ctx.channels.updateDescription(channel.id, null);
    expect(updated.description).toBeNull();
  });

  it('rejects updating an archived channel', () => {
    const channel = ctx.channels.create('archivable', agentId);
    ctx.channels.archive(channel.id);
    expect(() => ctx.channels.updateDescription(channel.id, 'nope')).toThrow('archived channel');
  });

  it('rejects description longer than 1000 characters', () => {
    const channel = ctx.channels.create('test-chan', agentId);
    const longDesc = 'x'.repeat(1001);
    expect(() => ctx.channels.updateDescription(channel.id, longDesc)).toThrow(
      'exceeds maximum length of 1000',
    );
  });

  it('throws NotFoundError for non-existent channel', () => {
    expect(() => ctx.channels.updateDescription('nonexistent-id', 'desc')).toThrow(NotFoundError);
  });
});

// ---------------------------------------------------------------------------
// Message count
// ---------------------------------------------------------------------------

describe('MessageService — count', () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => {
    ctx.close();
  });

  it('returns 0 for empty database', () => {
    expect(ctx.messages.count()).toBe(0);
  });

  it('returns correct count after sending messages', () => {
    const alice = ctx.agents.register({ name: 'alice' });
    const bob = ctx.agents.register({ name: 'bob' });

    ctx.messages.send(alice.id, { to: bob.id, content: 'msg1' });
    ctx.messages.send(alice.id, { to: bob.id, content: 'msg2' });
    ctx.messages.send(bob.id, { to: alice.id, content: 'msg3' });

    expect(ctx.messages.count()).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Configurable retention
// ---------------------------------------------------------------------------

describe('CleanupService — configurable retention', () => {
  let ctx: AppContext;

  beforeEach(() => {
    ctx = createTestContext();
  });
  afterEach(() => {
    ctx.close();
  });

  it('accepts custom retention and runs successfully', () => {
    const customCleanup = new CleanupService(ctx.db, 30);
    const stats = customCleanup.run();
    expect(stats.agents).toBe(0);
    expect(stats.messages).toBe(0);
    expect(stats.reads).toBe(0);
    expect(stats.channels).toBe(0);
    expect(stats.state).toBe(0);
    customCleanup.stopTimer();
  });

  it('default retention returns zero counts on fresh db', () => {
    const stats = ctx.cleanup.run();
    expect(stats.agents).toBe(0);
    expect(stats.messages).toBe(0);
  });
});
