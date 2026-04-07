// =============================================================================
// agent-comm — MCP tool handler dispatch table
//
// Signature: (ctx, args, agent) => result
// =============================================================================

import type { AppContext } from '../context.js';
import type { Skill } from '../types.js';
import { NotFoundError, ValidationError } from '../types.js';
import {
  requireString,
  optString,
  optNumber,
  optImportance,
  optStatus,
  optStringOrNull,
  optBoolean,
} from './mcp-validation.js';

// ---------------------------------------------------------------------------
// Agent context passed to each handler
// ---------------------------------------------------------------------------

export interface HandlerAgent {
  /** Current agent or null if not registered */
  current: { id: string; name: string } | null;
  /** Set the current agent (used by register) */
  setCurrent(agent: { id: string; name: string } | null): void;
  /** Get current agent or throw if not registered */
  require(): { id: string; name: string };
  /** Resolve agent by name or ID, throw NotFoundError if missing */
  resolve(nameOrId: string): { id: string; name: string };
  /** Resolve channel by name, throw NotFoundError if missing */
  resolveChannel(name: string): string;
  /** Assert agent is a member of the channel */
  requireChannelMember(channelId: string, agentId: string): void;
  /** Start auto-heartbeat timer */
  startHeartbeat(): void;
  /** Stop auto-heartbeat timer */
  stopHeartbeat(): void;
}

// ---------------------------------------------------------------------------
// Handler type and dispatch table
// ---------------------------------------------------------------------------

export type ToolHandlerFn = (
  ctx: AppContext,
  args: Record<string, unknown>,
  agent: HandlerAgent,
) => unknown;

export const toolHandlers: Record<string, ToolHandlerFn> = {
  comm_register(ctx, args, agent) {
    const rawCaps = args.capabilities;
    if (rawCaps !== undefined && rawCaps !== null) {
      if (!Array.isArray(rawCaps) || !rawCaps.every((c) => typeof c === 'string')) {
        throw new ValidationError('"capabilities" must be an array of strings.');
      }
    }
    const rawMeta = args.metadata;
    if (rawMeta !== undefined && rawMeta !== null) {
      if (typeof rawMeta !== 'object' || Array.isArray(rawMeta)) {
        throw new ValidationError('"metadata" must be a plain object.');
      }
    }
    const rawSkills = args.skills;
    if (rawSkills !== undefined && rawSkills !== null) {
      if (!Array.isArray(rawSkills)) {
        throw new ValidationError('"skills" must be an array.');
      }
      for (const rawSkill of rawSkills) {
        if (
          typeof rawSkill !== 'object' ||
          !rawSkill ||
          typeof (rawSkill as Record<string, unknown>).id !== 'string' ||
          typeof (rawSkill as Record<string, unknown>).name !== 'string'
        ) {
          throw new ValidationError('Each skill must have "id" (string) and "name" (string).');
        }
      }
    }
    // If this MCP process already has a registered agent, return it without
    // overwriting. This prevents subagents sharing the same MCP stdio process
    // from stealing each other's identity (Claude Code architecture constraint).
    if (agent.current) {
      const existing = ctx.agents.getById(agent.current.id);
      if (existing && existing.status !== 'offline') {
        // Still join requested channels even for existing agents
        const rawCh = args.channels;
        const joined: string[] = [];
        if (Array.isArray(rawCh) && rawCh.every((c) => typeof c === 'string')) {
          for (const channelName of rawCh as string[]) {
            const createdChannel = ctx.channels.create(channelName, existing.id);
            ctx.channels.join(createdChannel.id, existing.id);
            joined.push(channelName);
          }
        }
        return joined.length > 0 ? { ...existing, joined_channels: joined } : existing;
      }
    }

    const registered = ctx.agents.register({
      name: requireString(args, 'name'),
      capabilities: rawCaps as string[] | undefined,
      metadata: rawMeta as Record<string, unknown> | undefined,
      skills: rawSkills as Skill[] | undefined,
    });
    agent.setCurrent({ id: registered.id, name: registered.name });
    agent.startHeartbeat();
    ctx.feed.logInternal(
      registered.id,
      'register',
      registered.name,
      registered.name + ' registered',
    );

    // Auto-join channels if requested
    const rawChannels = args.channels;
    const joinedChannels: string[] = [];
    if (rawChannels !== undefined && rawChannels !== null) {
      if (!Array.isArray(rawChannels) || !rawChannels.every((c) => typeof c === 'string')) {
        throw new ValidationError('"channels" must be an array of strings.');
      }
      for (const channelName of rawChannels as string[]) {
        const createdChannel = ctx.channels.create(channelName, registered.id);
        ctx.channels.join(createdChannel.id, registered.id);
        ctx.feed.logInternal(
          registered.id,
          'channel_join',
          channelName,
          registered.name + ' joined #' + channelName,
        );
        joinedChannels.push(channelName);
      }
    }

    return joinedChannels.length > 0
      ? { ...registered, joined_channels: joinedChannels }
      : registered;
  },

  comm_agents(ctx, args, agent) {
    const action = requireString(args, 'action');

    switch (action) {
      case 'list': {
        const stuckThreshold = optNumber(args, 'stuck_threshold_minutes');
        if (stuckThreshold !== undefined) {
          agent.require();
          if (stuckThreshold < 1 || stuckThreshold > 1440) {
            throw new ValidationError('stuck_threshold_minutes must be between 1 and 1440.');
          }
          return ctx.agents.stuckAgents(stuckThreshold);
        }
        return ctx.agents.list({
          status: optStatus(args, 'status'),
          capability: optString(args, 'capability'),
          includeOffline: optBoolean(args, 'include_offline'),
        });
      }

      case 'discover': {
        agent.require();
        return ctx.agents.discover({
          skill: optString(args, 'skill'),
          tag: optString(args, 'tag'),
        });
      }

      case 'whoami': {
        const self = agent.require();
        return ctx.agents.getById(self.id);
      }

      case 'heartbeat': {
        const self = agent.require();
        const statusText = optStringOrNull(args, 'status_text');
        const statusArg = args.status_text === undefined ? undefined : statusText;
        ctx.agents.heartbeat(self.id, statusArg);
        return { success: true };
      }

      case 'status': {
        const self = agent.require();
        const text = optString(args, 'status_text') ?? null;
        ctx.agents.setStatusText(self.id, text);
        return { success: true, status_text: text };
      }

      case 'unregister': {
        const self = agent.require();
        ctx.feed.logInternal(self.id, 'unregister', self.name, self.name + ' went offline');
        ctx.agents.unregister(self.id);
        agent.setCurrent(null);
        agent.stopHeartbeat();
        return { success: true };
      }

      default:
        throw new ValidationError(
          `Unknown action "${action}". Valid: list, discover, whoami, heartbeat, status, unregister`,
        );
    }
  },

  comm_send(ctx, args, agent) {
    const self = agent.require();
    ctx.rateLimiter.check(self.id);

    const broadcast = optBoolean(args, 'broadcast');
    const channel = optString(args, 'channel');
    const to = optString(args, 'to');
    const replyTo = optNumber(args, 'reply_to');
    const forwardId = optNumber(args, 'forward');
    const content = requireString(args, 'content');

    // --- Forward mode ---
    if (forwardId !== undefined) {
      const fwdMsg = ctx.messages.getById(forwardId);
      if (!fwdMsg) throw new NotFoundError('Message', String(forwardId));

      if (!to && !channel) throw new ValidationError('Forward requires "to" (agent) or "channel".');

      const fwdFromName = ctx.agents.getById(fwdMsg.from_agent)?.name ?? fwdMsg.from_agent;
      const comment = optString(args, 'comment') ?? '';
      const fwdContent =
        (comment ? comment + '\n\n' : '') +
        `--- Forwarded from ${fwdFromName} ---\n${fwdMsg.content}`;

      const result = ctx.messages.send(self.id, {
        to: to ? agent.resolve(to).id : undefined,
        channel: channel ? agent.resolveChannel(channel) : undefined,
        content: fwdContent,
      });
      ctx.agents.touchActivity(self.id);
      return result;
    }

    // --- Reply mode ---
    if (replyTo !== undefined) {
      const originalMsg = ctx.messages.getById(replyTo);
      if (!originalMsg) throw new NotFoundError('Message', String(replyTo));

      const replyTarget = originalMsg.channel_id
        ? { channel: originalMsg.channel_id }
        : {
            to: originalMsg.from_agent === self.id ? originalMsg.to_agent! : originalMsg.from_agent,
          };

      const result = ctx.messages.send(self.id, {
        ...replyTarget,
        content,
        thread_id: originalMsg.thread_id ?? originalMsg.id,
      });
      ctx.agents.touchActivity(self.id);
      return result;
    }

    // --- Broadcast mode ---
    if (broadcast) {
      const broadcastMessages = ctx.messages.broadcast(
        self.id,
        content,
        optImportance(args, 'importance'),
      );
      ctx.agents.touchActivity(self.id);
      ctx.feed.logInternal(self.id, 'message', 'broadcast', content.substring(0, 100));
      return { sent: broadcastMessages.length, messages: broadcastMessages };
    }

    // --- Channel mode ---
    if (channel) {
      const channelId = agent.resolveChannel(channel);
      agent.requireChannelMember(channelId, self.id);
      const channelMessage = ctx.messages.send(self.id, {
        channel: channelId,
        content,
        thread_id: optNumber(args, 'thread_id'),
        importance: optImportance(args, 'importance'),
      });
      ctx.agents.touchActivity(self.id);
      ctx.feed.logInternal(self.id, 'message', channel, content.substring(0, 100));
      return channelMessage;
    }

    // --- Direct message mode ---
    if (to) {
      const target = agent.resolve(to);
      const sentMessage = ctx.messages.send(self.id, {
        to: target.id,
        content,
        thread_id: optNumber(args, 'thread_id'),
        importance: optImportance(args, 'importance'),
        ack_required: optBoolean(args, 'ack_required'),
      });
      ctx.agents.touchActivity(self.id);
      ctx.feed.logInternal(
        self.id,
        'message',
        target.name,
        (sentMessage.content || '').substring(0, 100),
      );
      return sentMessage;
    }

    throw new ValidationError(
      'Specify "to" (direct), "channel", "broadcast":true, "reply_to", or "forward".',
    );
  },

  comm_inbox(ctx, args, agent) {
    const self = agent.require();
    const threadId = optNumber(args, 'thread_id');
    if (threadId !== undefined) {
      return ctx.messages.thread(threadId);
    }
    return ctx.messages.inbox(self.id, {
      unreadOnly: optBoolean(args, 'unread_only') ?? true,
      limit: optNumber(args, 'limit'),
    });
  },

  comm_channel(ctx, args, agent) {
    const action = requireString(args, 'action');

    switch (action) {
      case 'create': {
        const self = agent.require();
        ctx.rateLimiter.check(self.id);
        return ctx.channels.create(
          requireString(args, 'channel'),
          self.id,
          optString(args, 'description'),
        );
      }

      case 'list': {
        agent.require();
        return ctx.channels.list(optBoolean(args, 'include_archived'));
      }

      case 'join': {
        const self = agent.require();
        ctx.rateLimiter.check(self.id);
        const channelName = requireString(args, 'channel');
        const channelId = agent.resolveChannel(channelName);
        ctx.channels.join(channelId, self.id);
        ctx.feed.logInternal(
          self.id,
          'channel_join',
          channelName,
          self.name + ' joined #' + channelName,
        );
        return { success: true, channel: channelName };
      }

      case 'leave': {
        const self = agent.require();
        const channelName = requireString(args, 'channel');
        const channelId = agent.resolveChannel(channelName);
        ctx.channels.leave(channelId, self.id);
        ctx.feed.logInternal(
          self.id,
          'channel_leave',
          channelName,
          self.name + ' left #' + channelName,
        );
        return { success: true, channel: channelName };
      }

      case 'archive': {
        const self = agent.require();
        ctx.rateLimiter.check(self.id);
        const channelId = agent.resolveChannel(requireString(args, 'channel'));
        ctx.channels.archive(channelId, self.id);
        return { success: true, channel: requireString(args, 'channel') };
      }

      case 'update': {
        agent.require();
        const channelId = agent.resolveChannel(requireString(args, 'channel'));
        const description = optString(args, 'description') ?? null;
        return ctx.channels.updateDescription(channelId, description);
      }

      case 'members': {
        agent.require();
        const channelId = agent.resolveChannel(requireString(args, 'channel'));
        return ctx.channels.members(channelId);
      }

      case 'history': {
        agent.require();
        const channelId = agent.resolveChannel(requireString(args, 'channel'));
        const limit = optNumber(args, 'limit');
        return ctx.messages.list({ channel: channelId, limit: limit ?? 50 });
      }

      default:
        throw new ValidationError(
          `Unknown action "${action}". Valid: create, list, join, leave, archive, update, members, history`,
        );
    }
  },

  comm_state(ctx, args, agent) {
    const action = requireString(args, 'action');

    switch (action) {
      case 'set': {
        const self = agent.require();
        ctx.rateLimiter.check(self.id);
        const ttlRaw = args.ttl_seconds;
        const ttl =
          typeof ttlRaw === 'number' && Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : undefined;
        const entry = ctx.state.set(
          optString(args, 'namespace') ?? 'default',
          requireString(args, 'key'),
          requireString(args, 'value'),
          self.id,
          ttl,
        );
        ctx.agents.touchActivity(self.id);
        ctx.feed.logInternal(
          self.id,
          'state_change',
          entry.namespace + '/' + entry.key,
          entry.value.substring(0, 100),
        );
        return entry;
      }

      case 'get': {
        agent.require();
        return ctx.state.get(optString(args, 'namespace') ?? 'default', requireString(args, 'key'));
      }

      case 'list': {
        agent.require();
        return ctx.state.list(optString(args, 'namespace'), optString(args, 'prefix'));
      }

      case 'delete': {
        const self = agent.require();
        ctx.rateLimiter.check(self.id);
        const ns = optString(args, 'namespace') ?? 'default';
        return { deleted: ctx.state.delete(ns, requireString(args, 'key')) };
      }

      case 'cas': {
        const self = agent.require();
        ctx.rateLimiter.check(self.id);
        const ns = optString(args, 'namespace') ?? 'default';
        const swapped = ctx.state.compareAndSwap(
          ns,
          requireString(args, 'key'),
          optStringOrNull(args, 'expected'),
          requireString(args, 'new_value'),
          self.id,
        );
        return { swapped };
      }

      default:
        throw new ValidationError(`Unknown action "${action}". Valid: set, get, list, delete, cas`);
    }
  },

  comm_search(ctx, args, agent) {
    agent.require();
    const fromAgent = optString(args, 'from');
    return ctx.messages.search(requireString(args, 'query'), {
      channel: args.channel ? agent.resolveChannel(requireString(args, 'channel')) : undefined,
      from: fromAgent ? agent.resolve(fromAgent).id : undefined,
      limit: optNumber(args, 'limit'),
    });
  },
};
