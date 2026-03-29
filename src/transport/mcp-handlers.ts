// =============================================================================
// agent-comm — MCP tool handler dispatch table
//
// Each handler is extracted from the former switch statement in mcp.ts.
// Signature: (ctx, args, agent) => result
// Where `agent` is a helper object providing access to the current agent
// state and common resolution utilities.
//
// Consolidated from 38 handlers to 12 in v1.3.0.
// =============================================================================

import type { AppContext } from '../context.js';
import type { Skill } from '../types.js';
import { NotFoundError, ValidationError } from '../types.js';
import {
  requireString,
  optString,
  requireNumber,
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
  // =========================================================================
  // 1. comm_register — keep as-is
  // =========================================================================
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
      for (const s of rawSkills) {
        if (
          typeof s !== 'object' ||
          !s ||
          typeof (s as Record<string, unknown>).id !== 'string' ||
          typeof (s as Record<string, unknown>).name !== 'string'
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
        return existing;
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
    return registered;
  },

  // =========================================================================
  // 2. comm_agents — merged list_agents, discover, whoami, heartbeat, status, unregister
  // =========================================================================
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

  // =========================================================================
  // 3. comm_send — merged send, broadcast, channel_send, reply, forward
  // =========================================================================
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
      const msgs = ctx.messages.broadcast(self.id, content, optImportance(args, 'importance'));
      ctx.agents.touchActivity(self.id);
      return { sent: msgs.length, messages: msgs };
    }

    // --- Channel mode ---
    if (channel) {
      const channelId = agent.resolveChannel(channel);
      agent.requireChannelMember(channelId, self.id);
      const chanMsg = ctx.messages.send(self.id, {
        channel: channelId,
        content,
        thread_id: optNumber(args, 'thread_id'),
        importance: optImportance(args, 'importance'),
      });
      ctx.agents.touchActivity(self.id);
      return chanMsg;
    }

    // --- Direct message mode ---
    if (to) {
      const target = agent.resolve(to);
      const msg = ctx.messages.send(self.id, {
        to: target.id,
        content,
        thread_id: optNumber(args, 'thread_id'),
        importance: optImportance(args, 'importance'),
        ack_required: optBoolean(args, 'ack_required'),
      });
      ctx.agents.touchActivity(self.id);
      ctx.feed.logInternal(self.id, 'message', target.name, (msg.content || '').substring(0, 100));
      return msg;
    }

    throw new ValidationError(
      'Specify "to" (direct), "channel", "broadcast":true, "reply_to", or "forward".',
    );
  },

  // =========================================================================
  // 4. comm_inbox — keep as-is
  // =========================================================================
  comm_inbox(ctx, args, agent) {
    const self = agent.require();
    return ctx.messages.inbox(self.id, {
      unreadOnly: optBoolean(args, 'unread_only') ?? true,
      limit: optNumber(args, 'limit'),
    });
  },

  // =========================================================================
  // 5. comm_message — merged thread, mark_read, ack, edit, delete
  // =========================================================================
  comm_message(ctx, args, agent) {
    const action = requireString(args, 'action');

    switch (action) {
      case 'thread': {
        agent.require();
        return ctx.messages.thread(requireNumber(args, 'message_id'));
      }

      case 'read': {
        const self = agent.require();
        const messageId = optNumber(args, 'message_id');
        if (messageId !== undefined) {
          ctx.messages.markRead(messageId, self.id);
          return { marked: 1 };
        }
        const count = ctx.messages.markAllRead(self.id);
        return { marked: count };
      }

      case 'ack': {
        const self = agent.require();
        ctx.messages.acknowledge(requireNumber(args, 'message_id'), self.id);
        return { success: true };
      }

      case 'edit': {
        const self = agent.require();
        return ctx.messages.edit(
          requireNumber(args, 'message_id'),
          self.id,
          requireString(args, 'content'),
        );
      }

      case 'delete': {
        const self = agent.require();
        ctx.messages.delete(requireNumber(args, 'message_id'), self.id);
        return { success: true };
      }

      default:
        throw new ValidationError(
          `Unknown action "${action}". Valid: thread, read, ack, edit, delete`,
        );
    }
  },

  // =========================================================================
  // 6. comm_channel — merged all channel tools (except send, which is in comm_send)
  // =========================================================================
  comm_channel(ctx, args, agent) {
    const action = requireString(args, 'action');

    switch (action) {
      case 'create': {
        const self = agent.require();
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
        const channelId = agent.resolveChannel(requireString(args, 'channel'));
        ctx.channels.join(channelId, self.id);
        return { success: true, channel: requireString(args, 'channel') };
      }

      case 'leave': {
        const self = agent.require();
        const channelId = agent.resolveChannel(requireString(args, 'channel'));
        ctx.channels.leave(channelId, self.id);
        return { success: true, channel: requireString(args, 'channel') };
      }

      case 'archive': {
        const self = agent.require();
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

  // =========================================================================
  // 7. comm_state — merged all state tools
  // =========================================================================
  comm_state(ctx, args, agent) {
    const action = requireString(args, 'action');

    switch (action) {
      case 'set': {
        const self = agent.require();
        const entry = ctx.state.set(
          optString(args, 'namespace') ?? 'default',
          requireString(args, 'key'),
          requireString(args, 'value'),
          self.id,
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
        agent.require();
        const ns = optString(args, 'namespace') ?? 'default';
        return { deleted: ctx.state.delete(ns, requireString(args, 'key')) };
      }

      case 'cas': {
        const self = agent.require();
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

  // =========================================================================
  // 8. comm_react — merged react + unreact
  // =========================================================================
  comm_react(ctx, args, agent) {
    const self = agent.require();
    const action = optString(args, 'action') ?? 'add';

    if (action === 'add') {
      ctx.reactions.react(
        requireNumber(args, 'message_id'),
        self.id,
        requireString(args, 'reaction'),
      );
      return { success: true };
    }

    if (action === 'remove') {
      ctx.reactions.unreact(
        requireNumber(args, 'message_id'),
        self.id,
        requireString(args, 'reaction'),
      );
      return { success: true };
    }

    throw new ValidationError(`Unknown action "${action}". Valid: add, remove`);
  },

  // =========================================================================
  // 9. comm_feed — merged log_activity + feed query
  // =========================================================================
  comm_feed(ctx, args, agent) {
    const action = requireString(args, 'action');

    switch (action) {
      case 'log': {
        const self = agent.require();
        ctx.agents.touchActivity(self.id);
        return ctx.feed.log(
          self.id,
          requireString(args, 'type'),
          optString(args, 'target'),
          optString(args, 'preview'),
        );
      }

      case 'query': {
        agent.require();
        const feedAgent = optString(args, 'agent');
        let feedAgentId: string | undefined;
        if (feedAgent) {
          const resolved = ctx.agents.getByName(feedAgent) ?? ctx.agents.getById(feedAgent);
          feedAgentId = resolved?.id;
        }
        return ctx.feed.query({
          agent: feedAgentId,
          type: optString(args, 'type'),
          limit: optNumber(args, 'limit'),
          since: optString(args, 'since'),
        });
      }

      default:
        throw new ValidationError(`Unknown action "${action}". Valid: log, query`);
    }
  },

  // =========================================================================
  // 10. comm_branch — keep as-is (already consolidated)
  // =========================================================================
  comm_branch(ctx, args, agent) {
    const messageId = optNumber(args, 'message_id');
    // Without message_id: list branches
    if (messageId === undefined) {
      agent.require();
      return ctx.branches.list();
    }
    // With message_id: create a branch
    const self = agent.require();
    const branch = ctx.branches.create(messageId, self.id, optString(args, 'name'));
    ctx.agents.touchActivity(self.id);
    ctx.feed.logInternal(
      self.id,
      'branch',
      branch.name ?? `branch-${branch.id}`,
      `Branched from message #${branch.parent_message_id}`,
    );
    return branch;
  },

  // =========================================================================
  // 11. comm_handoff — keep as-is
  // =========================================================================
  comm_handoff(ctx, args, agent) {
    const self = agent.require();
    ctx.rateLimiter.check(self.id);
    const target = agent.resolve(requireString(args, 'to'));
    const threadId = optNumber(args, 'thread_id');
    const context = optString(args, 'context') ?? '';
    const channelName = optString(args, 'channel');

    let handoffContent = `--- HANDOFF from ${self.name} to ${target.name} ---\n\n`;

    if (context) {
      handoffContent += `**Context:** ${context}\n\n`;
    }

    if (threadId) {
      const threadMessages = ctx.messages.thread(threadId);
      if (threadMessages.length > 0) {
        handoffContent += `**Thread history** (${threadMessages.length} messages):\n\n`;
        for (const tm of threadMessages.slice(-20)) {
          const fromName = ctx.agents.getById(tm.from_agent)?.name ?? tm.from_agent;
          const preview = tm.content.substring(0, 200);
          handoffContent += `> **${fromName}**: ${preview}${tm.content.length > 200 ? '...' : ''}\n>\n`;
        }
      }
    }

    handoffContent += `\n--- End of handoff ---`;

    const channelId = channelName ? agent.resolveChannel(channelName) : undefined;
    if (channelId) {
      agent.requireChannelMember(channelId, self.id);
    }

    const handoffMsg = ctx.messages.send(self.id, {
      to: channelId ? undefined : target.id,
      channel: channelId,
      content: handoffContent,
      importance: 'high',
      thread_id: threadId,
    });

    ctx.agents.touchActivity(self.id);
    ctx.feed.logInternal(
      self.id,
      'handoff',
      target.name,
      `Handoff to ${target.name}` + (context ? `: ${context.substring(0, 80)}` : ''),
    );

    return {
      handoff_message: handoffMsg,
      from: self.name,
      to: target.name,
      thread_included: !!threadId,
    };
  },

  // =========================================================================
  // 12. comm_search — keep as-is
  // =========================================================================
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
