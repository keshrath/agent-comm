import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';

describe('ChannelService', () => {
  let ctx: AppContext;
  let agentId: string;

  beforeEach(() => {
    ctx = createTestContext();
    agentId = ctx.agents.register({ name: 'creator' }).id;
  });
  afterEach(() => {
    ctx.close();
  });

  describe('create', () => {
    it('creates a channel and auto-joins the creator', () => {
      const ch = ctx.channels.create('general', agentId, 'Main channel');
      expect(ch.name).toBe('general');
      expect(ch.description).toBe('Main channel');
      expect(ch.created_by).toBe(agentId);
      expect(ch.archived_at).toBeNull();

      const members = ctx.channels.members(ch.id);
      expect(members).toHaveLength(1);
      expect(members[0].agent_id).toBe(agentId);
    });

    it('forces lowercase names', () => {
      const ch = ctx.channels.create('MyChannel', agentId);
      expect(ch.name).toBe('mychannel');
    });

    it('rejects invalid names', () => {
      expect(() => ctx.channels.create('a', agentId)).toThrow('Invalid channel name');
      expect(() => ctx.channels.create('HAS SPACES', agentId)).toThrow('Invalid channel name');
    });

    it('returns existing channel on duplicate create', () => {
      const ch1 = ctx.channels.create('unique', agentId);
      const ch2 = ctx.channels.create('unique', agentId);
      expect(ch2.id).toBe(ch1.id);
    });

    it('unarchives an archived channel on re-create', () => {
      const ch = ctx.channels.create('revived', agentId);
      ctx.channels.archive(ch.id);

      const ch2 = ctx.channels.create('revived', agentId, 'new description');
      expect(ch2.id).toBe(ch.id);
      expect(ch2.archived_at).toBeNull();
      expect(ch2.description).toBe('new description');
    });
  });

  describe('join / leave', () => {
    it('adds and removes members', () => {
      const ch = ctx.channels.create('team', agentId);
      const other = ctx.agents.register({ name: 'joiner' });

      ctx.channels.join(ch.id, other.id);
      expect(ctx.channels.members(ch.id)).toHaveLength(2);

      ctx.channels.leave(ch.id, other.id);
      expect(ctx.channels.members(ch.id)).toHaveLength(1);
    });

    it('is idempotent for join', () => {
      const ch = ctx.channels.create('idempotent', agentId);
      ctx.channels.join(ch.id, agentId);
      expect(ctx.channels.members(ch.id)).toHaveLength(1);
    });

    it('rejects join on archived channel', () => {
      const ch = ctx.channels.create('archived', agentId);
      ctx.channels.archive(ch.id);
      const other = ctx.agents.register({ name: 'late' });

      expect(() => ctx.channels.join(ch.id, other.id)).toThrow('archived');
    });
  });

  describe('archive', () => {
    it('archives a channel', () => {
      const ch = ctx.channels.create('temp', agentId);
      ctx.channels.archive(ch.id);

      const archived = ctx.channels.getById(ch.id);
      expect(new Date(archived!.archived_at!).getTime()).toBeGreaterThan(0);
    });

    it('hides archived channels from default list', () => {
      ctx.channels.create('visible', agentId);
      const temp = ctx.channels.create('hidden', agentId);
      ctx.channels.archive(temp.id);

      expect(ctx.channels.list()).toHaveLength(1);
      expect(ctx.channels.list(true)).toHaveLength(2);
    });
  });

  describe('agentChannels', () => {
    it('returns channels the agent belongs to', () => {
      ctx.channels.create('alpha', agentId);
      ctx.channels.create('beta', agentId);

      const channels = ctx.channels.agentChannels(agentId);
      expect(channels).toHaveLength(2);
    });
  });

  describe('events', () => {
    it('emits channel events with correct payloads', () => {
      const created: Array<{ type: string; data: Record<string, unknown> }> = [];
      const joined: Array<{ type: string; data: Record<string, unknown> }> = [];
      const archived: Array<{ type: string; data: Record<string, unknown> }> = [];
      ctx.events.on('channel:created', (e) => created.push(e as (typeof created)[0]));
      ctx.events.on('channel:member_joined', (e) => joined.push(e as (typeof joined)[0]));
      ctx.events.on('channel:archived', (e) => archived.push(e as (typeof archived)[0]));

      const ch = ctx.channels.create('evented', agentId);
      ctx.channels.archive(ch.id);

      expect(created).toHaveLength(1);
      expect(created[0].type).toBe('channel:created');
      expect((created[0].data.channel as Record<string, unknown>).name).toBe('evented');

      expect(joined).toHaveLength(1);
      expect(joined[0].type).toBe('channel:member_joined');
      expect(joined[0].data.channelId).toBe(ch.id);
      expect(joined[0].data.agentId).toBe(agentId);

      expect(archived).toHaveLength(1);
      expect(archived[0].type).toBe('channel:archived');
      expect(archived[0].data.channelId).toBe(ch.id);
    });
  });
});
