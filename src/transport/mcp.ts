// =============================================================================
// agent-comm — MCP transport
//
// Maps MCP tool calls to domain services. Each tool is a thin adapter —
// validation lives in the domain layer, not here.
// =============================================================================

import type { AppContext } from '../context.js';
import type { AgentStatus, MessageImportance, Skill, ToolDefinition } from '../types.js';
import { NotFoundError, ValidationError } from '../types.js';

// Shared schema fragments for consistency
// ---------------------------------------------------------------------------

const IMPORTANCE_SCHEMA = {
  type: 'string',
  enum: ['low', 'normal', 'high', 'urgent'],
  description: 'Message importance level (default: "normal")',
} as const;

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

export const tools: ToolDefinition[] = [
  {
    name: 'comm_register',
    description: 'Register this agent with the communication hub. Returns the agent identity.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Human-readable agent name (2-64 chars, alphanumeric with . _ -)',
        },
        capabilities: {
          type: 'array',
          items: { type: 'string' },
          description: 'Capability tags (e.g. "code-review", "testing")',
        },
        metadata: { type: 'object', description: 'Arbitrary metadata (JSON object)' },
        skills: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: 'Unique skill identifier' },
              name: { type: 'string', description: 'Human-readable skill name' },
              tags: { type: 'array', items: { type: 'string' }, description: 'Tags for discovery' },
            },
            required: ['id', 'name'],
          },
          description: 'Skills this agent provides (for skill-based discovery)',
        },
      },
      required: ['name'],
    },
  },
  {
    name: 'comm_list_agents',
    description: 'List all registered agents, optionally filtered by status or capability.',
    inputSchema: {
      type: 'object',
      properties: {
        status: {
          type: 'string',
          enum: ['online', 'idle', 'offline'],
          description: 'Filter by status',
        },
        capability: { type: 'string', description: 'Filter by capability keyword' },
        include_offline: {
          type: 'boolean',
          description: 'Include offline agents (default: false)',
        },
      },
    },
  },
  {
    name: 'comm_whoami',
    description: "Return this agent's identity (id, name, capabilities).",
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'comm_heartbeat',
    description: 'Send a heartbeat to keep this agent marked as online.',
    inputSchema: {
      type: 'object',
      properties: {
        status_text: {
          type: 'string',
          description: 'Optional status text to set with heartbeat (max 256 chars)',
        },
      },
    },
  },
  {
    name: 'comm_unregister',
    description: 'Unregister this agent (mark as offline).',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'comm_send',
    description: 'Send a direct message to another agent by name or ID.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient agent name or ID' },
        content: { type: 'string', description: 'Message content' },
        thread_id: {
          type: 'number',
          description: 'Reply to this message (creates/continues a thread)',
        },
        importance: IMPORTANCE_SCHEMA,
        ack_required: { type: 'boolean', description: 'Whether the recipient must acknowledge' },
      },
      required: ['to', 'content'],
    },
  },
  {
    name: 'comm_broadcast',
    description: 'Send a message to all online agents.',
    inputSchema: {
      type: 'object',
      properties: {
        content: { type: 'string', description: 'Message content' },
        importance: IMPORTANCE_SCHEMA,
      },
      required: ['content'],
    },
  },
  {
    name: 'comm_channel_send',
    description: 'Post a message to a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name' },
        content: { type: 'string', description: 'Message content' },
        thread_id: { type: 'number', description: 'Reply to this message' },
        importance: IMPORTANCE_SCHEMA,
      },
      required: ['channel', 'content'],
    },
  },
  {
    name: 'comm_inbox',
    description: 'Read messages in your inbox (direct + channel messages).',
    inputSchema: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', description: 'Only unread messages (default: true)' },
        limit: { type: 'number', description: 'Max messages (default: 50, max: 500)' },
      },
    },
  },
  {
    name: 'comm_thread',
    description: 'Get all messages in a thread.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'Any message ID in the thread' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'comm_mark_read',
    description:
      'Mark messages as read. Pass message_id for a single message, or omit to mark all.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'number',
          description: 'Message ID to mark as read (omit to mark all)',
        },
      },
    },
  },
  // comm_mark_all_read removed: comm_mark_read without message_id now handles this
  {
    name: 'comm_ack',
    description: 'Acknowledge a message that requires acknowledgment.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'Message ID' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'comm_reply',
    description:
      'Reply to a message (creates a thread). The reply is sent to the same channel or agent as the original.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'Message ID to reply to' },
        content: { type: 'string', description: 'Reply content' },
      },
      required: ['message_id', 'content'],
    },
  },
  {
    name: 'comm_forward',
    description: 'Forward a message to another agent or channel, optionally adding a comment.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'Message ID to forward' },
        to: { type: 'string', description: 'Agent name or ID to forward to' },
        channel: { type: 'string', description: 'Channel name to forward to' },
        comment: { type: 'string', description: 'Optional comment to add' },
      },
      required: ['message_id'],
    },
  },
  {
    name: 'comm_search',
    description: 'Full-text search across all messages.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        channel: { type: 'string', description: 'Limit to a channel name' },
        from: { type: 'string', description: 'Filter by sender agent name or ID' },
        limit: { type: 'number', description: 'Max results (default: 20)' },
      },
      required: ['query'],
    },
  },
  {
    name: 'comm_channel_create',
    description: 'Create a channel (topic-based communication room).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Channel name (lowercase, 2-64 chars)' },
        description: { type: 'string', description: 'Channel description' },
      },
      required: ['name'],
    },
  },
  {
    name: 'comm_channel_list',
    description: 'List all active channels.',
    inputSchema: {
      type: 'object',
      properties: {
        include_archived: { type: 'boolean', description: 'Include archived channels' },
      },
    },
  },
  {
    name: 'comm_channel_join',
    description: 'Join a channel to receive its messages.',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string', description: 'Channel name' } },
      required: ['channel'],
    },
  },
  {
    name: 'comm_channel_leave',
    description: 'Leave a channel.',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string', description: 'Channel name' } },
      required: ['channel'],
    },
  },
  {
    name: 'comm_channel_archive',
    description: 'Archive a channel (only the creator can archive).',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string', description: 'Channel name' } },
      required: ['channel'],
    },
  },
  {
    name: 'comm_channel_members',
    description: 'List members of a channel.',
    inputSchema: {
      type: 'object',
      properties: { channel: { type: 'string', description: 'Channel name' } },
      required: ['channel'],
    },
  },
  {
    name: 'comm_channel_history',
    description: 'Get recent messages from a channel.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name' },
        limit: { type: 'number', description: 'Max messages (default: 50, max: 500)' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'comm_edit_message',
    description: 'Edit a message you sent (updates content, marks as edited).',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'Message ID to edit' },
        content: { type: 'string', description: 'New message content' },
      },
      required: ['message_id', 'content'],
    },
  },
  {
    name: 'comm_delete_message',
    description: 'Delete a message you sent.',
    inputSchema: {
      type: 'object',
      properties: { message_id: { type: 'number', description: 'Message ID' } },
      required: ['message_id'],
    },
  },
  {
    name: 'comm_set_status',
    description: 'Set a short status text visible to other agents (e.g. "working on X").',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Status text (max 256 chars, omit or null to clear)' },
      },
    },
  },
  {
    name: 'comm_channel_update',
    description: 'Update a channel description.',
    inputSchema: {
      type: 'object',
      properties: {
        channel: { type: 'string', description: 'Channel name' },
        description: { type: 'string', description: 'New channel description (null to clear)' },
      },
      required: ['channel'],
    },
  },
  {
    name: 'comm_react',
    description: 'Add a reaction to a message (e.g. "done", "blocked", "+1").',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'Message ID' },
        reaction: { type: 'string', description: 'Reaction text (1-32 chars)' },
      },
      required: ['message_id', 'reaction'],
    },
  },
  {
    name: 'comm_unreact',
    description: 'Remove a reaction from a message.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: { type: 'number', description: 'Message ID' },
        reaction: { type: 'string', description: 'Reaction to remove' },
      },
      required: ['message_id', 'reaction'],
    },
  },
  {
    name: 'comm_state_set',
    description: 'Set a shared key-value pair visible to all agents.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name' },
        value: { type: 'string', description: 'Value (JSON as string if needed)' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
      required: ['key', 'value'],
    },
  },
  {
    name: 'comm_state_get',
    description: 'Get a shared value by key.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
      required: ['key'],
    },
  },
  {
    name: 'comm_state_list',
    description: 'List shared state entries, optionally filtered.',
    inputSchema: {
      type: 'object',
      properties: {
        namespace: { type: 'string', description: 'Filter by namespace' },
        prefix: { type: 'string', description: 'Filter by key prefix' },
      },
    },
  },
  {
    name: 'comm_state_delete',
    description: 'Delete a shared state entry.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key to delete' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
      required: ['key'],
    },
  },
  {
    name: 'comm_state_cas',
    description: 'Atomic compare-and-swap: update only if current value matches expected.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name' },
        expected: {
          type: ['string', 'null'],
          description: 'Expected current value (null if key should not exist)',
        },
        new_value: { type: 'string', description: 'New value (empty string to delete)' },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
      },
      required: ['key', 'expected', 'new_value'],
    },
  },
  {
    name: 'comm_log_activity',
    description: 'Log a structured activity event to the feed (e.g. commit, test_pass, file_edit).',
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          enum: [
            'commit',
            'test_pass',
            'test_fail',
            'file_edit',
            'task_complete',
            'error',
            'custom',
          ],
          description: 'Event type',
        },
        target: { type: 'string', description: 'Target of the action (e.g. file path, test name)' },
        preview: { type: 'string', description: 'Short preview text (max 500 chars)' },
      },
      required: ['type'],
    },
  },
  {
    name: 'comm_feed',
    description: 'Query the activity feed with optional filters.',
    inputSchema: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Filter by agent name or ID' },
        type: { type: 'string', description: 'Filter by event type' },
        limit: { type: 'number', description: 'Max events to return (default: 50, max: 500)' },
        since: { type: 'string', description: 'Only events after this ISO timestamp' },
      },
    },
  },
  {
    name: 'comm_discover',
    description: 'Find agents by skill ID or tag. Returns ranked list of matching agents.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string', description: 'Skill ID or name to search for' },
        tag: { type: 'string', description: 'Tag to search for across all agent skills' },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Input validation helpers
// ---------------------------------------------------------------------------

function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string' || !val.trim()) {
    throw new ValidationError(`"${key}" must be a non-empty string.`);
  }
  return val;
}

function optString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') throw new ValidationError(`"${key}" must be a string.`);
  return val;
}

function requireNumber(args: Record<string, unknown>, key: string): number {
  const val = args[key];
  if (typeof val !== 'number') {
    throw new ValidationError(`"${key}" is required and must be a number.`);
  }
  return val;
}

function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number') throw new ValidationError(`"${key}" must be a number.`);
  return val;
}

const VALID_IMPORTANCE = new Set<string>(['low', 'normal', 'high', 'urgent']);

function optImportance(args: Record<string, unknown>, key: string): MessageImportance | undefined {
  const val = optString(args, key);
  if (val === undefined) return undefined;
  if (!VALID_IMPORTANCE.has(val)) {
    throw new ValidationError(`"${key}" must be one of: low, normal, high, urgent.`);
  }
  return val as MessageImportance;
}

const VALID_STATUS = new Set<string>(['online', 'idle', 'offline']);

function optStatus(args: Record<string, unknown>, key: string): AgentStatus | undefined {
  const val = optString(args, key);
  if (val === undefined) return undefined;
  if (!VALID_STATUS.has(val)) {
    throw new ValidationError(`"${key}" must be one of: online, idle, offline.`);
  }
  return val as AgentStatus;
}

function optStringOrNull(args: Record<string, unknown>, key: string): string | null {
  const val = args[key];
  if (val === null || val === undefined) return null;
  if (typeof val !== 'string') throw new ValidationError(`"${key}" must be a string or null.`);
  return val;
}

function optBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') throw new ValidationError(`"${key}" must be a boolean.`);
  return val;
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export type ToolHandler = (name: string, args: Record<string, unknown>) => unknown;

const HEARTBEAT_INTERVAL_MS = 60_000;

export function createToolHandler(ctx: AppContext): ToolHandler {
  let currentAgent: { id: string; name: string } | null = null;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  function startHeartbeat(): void {
    stopHeartbeat();
    heartbeatTimer = setInterval(() => {
      if (currentAgent) {
        try {
          ctx.agents.heartbeat(currentAgent.id);
        } catch {
          /* agent may have been purged */
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
    heartbeatTimer.unref();
  }

  function stopHeartbeat(): void {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
  }

  function requireAgent(): { id: string; name: string } {
    if (!currentAgent) throw new ValidationError('Not registered. Call comm_register first.');
    return currentAgent;
  }

  function resolveAgent(nameOrId: string): { id: string; name: string } {
    const byName = ctx.agents.getByName(nameOrId);
    if (byName) return { id: byName.id, name: byName.name };
    const byId = ctx.agents.getById(nameOrId);
    if (byId) return { id: byId.id, name: byId.name };
    throw new NotFoundError('Agent', nameOrId);
  }

  function resolveChannel(name: string): string {
    const ch = ctx.channels.getByName(name);
    if (!ch) throw new NotFoundError('Channel', name);
    return ch.id;
  }

  function requireChannelMember(channelId: string, agentId: string): void {
    if (!ctx.channels.isMember(channelId, agentId)) {
      throw new ValidationError('You must join this channel before posting.');
    }
  }

  return function handleTool(name: string, args: Record<string, unknown>): unknown {
    // Auto-heartbeat on every tool call to keep MCP agents alive
    if (currentAgent && name !== 'comm_register' && name !== 'comm_unregister') {
      try {
        ctx.agents.heartbeat(currentAgent.id);
      } catch {
        /* ignore if agent was purged */
      }
    }

    switch (name) {
      case 'comm_register': {
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
        const agent = ctx.agents.register({
          name: requireString(args, 'name'),
          capabilities: rawCaps as string[] | undefined,
          metadata: rawMeta as Record<string, unknown> | undefined,
          skills: rawSkills as Skill[] | undefined,
        });
        currentAgent = { id: agent.id, name: agent.name };
        startHeartbeat();
        ctx.feed.logInternal(agent.id, 'register', agent.name, agent.name + ' registered');
        return agent;
      }

      case 'comm_list_agents': {
        // Allow listing agents without registration (needed for startup name selection)
        return ctx.agents.list({
          status: optStatus(args, 'status'),
          capability: optString(args, 'capability'),
          includeOffline: optBoolean(args, 'include_offline'),
        });
      }

      case 'comm_whoami': {
        const self = requireAgent();
        return ctx.agents.getById(self.id);
      }

      case 'comm_heartbeat': {
        const self = requireAgent();
        const statusText = optStringOrNull(args, 'status_text');
        // undefined means not provided (leave unchanged), null means clear, string means set
        const statusArg = args.status_text === undefined ? undefined : statusText;
        ctx.agents.heartbeat(self.id, statusArg);
        return { success: true };
      }

      case 'comm_unregister': {
        const self = requireAgent();
        ctx.agents.unregister(self.id);
        currentAgent = null;
        stopHeartbeat();
        return { success: true };
      }

      case 'comm_send': {
        const self = requireAgent();
        ctx.rateLimiter.check(self.id);
        const target = resolveAgent(requireString(args, 'to'));
        const msg = ctx.messages.send(self.id, {
          to: target.id,
          content: requireString(args, 'content'),
          thread_id: optNumber(args, 'thread_id'),
          importance: optImportance(args, 'importance'),
          ack_required: optBoolean(args, 'ack_required'),
        });
        ctx.feed.logInternal(
          self.id,
          'message',
          target.name,
          (msg.content || '').substring(0, 100),
        );
        return msg;
      }

      case 'comm_broadcast': {
        const self = requireAgent();
        ctx.rateLimiter.check(self.id);
        const msgs = ctx.messages.broadcast(
          self.id,
          requireString(args, 'content'),
          optImportance(args, 'importance'),
        );
        return { sent: msgs.length, messages: msgs };
      }

      case 'comm_channel_send': {
        const self = requireAgent();
        ctx.rateLimiter.check(self.id);
        const channelId = resolveChannel(requireString(args, 'channel'));
        requireChannelMember(channelId, self.id);
        return ctx.messages.send(self.id, {
          channel: channelId,
          content: requireString(args, 'content'),
          thread_id: optNumber(args, 'thread_id'),
          importance: optImportance(args, 'importance'),
        });
      }

      case 'comm_inbox': {
        const self = requireAgent();
        return ctx.messages.inbox(self.id, {
          unreadOnly: optBoolean(args, 'unread_only') ?? true,
          limit: optNumber(args, 'limit'),
        });
      }

      case 'comm_thread': {
        requireAgent();
        return ctx.messages.thread(requireNumber(args, 'message_id'));
      }

      case 'comm_mark_read': {
        const self = requireAgent();
        const messageId = optNumber(args, 'message_id');
        if (messageId !== undefined) {
          ctx.messages.markRead(messageId, self.id);
          return { marked: 1 };
        }
        const count = ctx.messages.markAllRead(self.id);
        return { marked: count };
      }

      case 'comm_mark_all_read': {
        // Hidden alias for backwards compatibility
        const self = requireAgent();
        const count = ctx.messages.markAllRead(self.id);
        return { marked: count };
      }

      case 'comm_ack': {
        const self = requireAgent();
        ctx.messages.acknowledge(requireNumber(args, 'message_id'), self.id);
        return { success: true };
      }

      case 'comm_reply': {
        const self = requireAgent();
        const originalMsg = ctx.messages.getById(requireNumber(args, 'message_id'));
        if (!originalMsg) throw new NotFoundError('Message', String(args.message_id));

        const replyTo = originalMsg.channel_id
          ? { channel: originalMsg.channel_id }
          : {
              to:
                originalMsg.from_agent === self.id ? originalMsg.to_agent! : originalMsg.from_agent,
            };

        return ctx.messages.send(self.id, {
          ...replyTo,
          content: requireString(args, 'content'),
          thread_id: originalMsg.thread_id ?? originalMsg.id,
        });
      }

      case 'comm_forward': {
        const self = requireAgent();
        const fwdMsg = ctx.messages.getById(requireNumber(args, 'message_id'));
        if (!fwdMsg) throw new NotFoundError('Message', String(args.message_id));

        const fwdTo = optString(args, 'to');
        const fwdChannel = optString(args, 'channel');
        if (!fwdTo && !fwdChannel)
          throw new ValidationError('Specify "to" (agent) or "channel" to forward to.');

        const fwdFromName = ctx.agents.getById(fwdMsg.from_agent)?.name ?? fwdMsg.from_agent;
        const comment = optString(args, 'comment') ?? '';
        const fwdContent =
          (comment ? comment + '\n\n' : '') +
          `--- Forwarded from ${fwdFromName} ---\n${fwdMsg.content}`;

        return ctx.messages.send(self.id, {
          to: fwdTo ? resolveAgent(fwdTo).id : undefined,
          channel: fwdChannel ? resolveChannel(fwdChannel) : undefined,
          content: fwdContent,
        });
      }

      case 'comm_search': {
        requireAgent();
        const fromAgent = optString(args, 'from');
        return ctx.messages.search(requireString(args, 'query'), {
          channel: args.channel ? resolveChannel(requireString(args, 'channel')) : undefined,
          from: fromAgent ? resolveAgent(fromAgent).id : undefined,
          limit: optNumber(args, 'limit'),
        });
      }

      case 'comm_channel_create': {
        const self = requireAgent();
        return ctx.channels.create(
          requireString(args, 'name'),
          self.id,
          optString(args, 'description'),
        );
      }

      case 'comm_channel_list': {
        requireAgent();
        return ctx.channels.list(optBoolean(args, 'include_archived'));
      }

      case 'comm_channel_join': {
        const self = requireAgent();
        const channelId = resolveChannel(requireString(args, 'channel'));
        ctx.channels.join(channelId, self.id);
        return { success: true, channel: requireString(args, 'channel') };
      }

      case 'comm_channel_leave': {
        const self = requireAgent();
        const channelId = resolveChannel(requireString(args, 'channel'));
        ctx.channels.leave(channelId, self.id);
        return { success: true, channel: requireString(args, 'channel') };
      }

      case 'comm_channel_archive': {
        const self = requireAgent();
        const channelId = resolveChannel(requireString(args, 'channel'));
        ctx.channels.archive(channelId, self.id);
        return { success: true, channel: requireString(args, 'channel') };
      }

      case 'comm_channel_members': {
        requireAgent();
        const channelId = resolveChannel(requireString(args, 'channel'));
        return ctx.channels.members(channelId);
      }

      case 'comm_edit_message': {
        const self = requireAgent();
        return ctx.messages.edit(
          requireNumber(args, 'message_id'),
          self.id,
          requireString(args, 'content'),
        );
      }

      case 'comm_delete_message': {
        const self = requireAgent();
        ctx.messages.delete(requireNumber(args, 'message_id'), self.id);
        return { success: true };
      }

      case 'comm_channel_history': {
        requireAgent();
        const channelId = resolveChannel(requireString(args, 'channel'));
        const limit = optNumber(args, 'limit');
        return ctx.messages.list({ channel: channelId, limit: limit ?? 50 });
      }

      case 'comm_set_status': {
        const self = requireAgent();
        const text = optString(args, 'text') ?? null;
        ctx.agents.setStatusText(self.id, text);
        return { success: true, status_text: text };
      }

      case 'comm_channel_update': {
        requireAgent();
        const channelId = resolveChannel(requireString(args, 'channel'));
        const description = optString(args, 'description') ?? null;
        return ctx.channels.updateDescription(channelId, description);
      }

      case 'comm_react': {
        const self = requireAgent();
        ctx.reactions.react(
          requireNumber(args, 'message_id'),
          self.id,
          requireString(args, 'reaction'),
        );
        return { success: true };
      }

      case 'comm_unreact': {
        const self = requireAgent();
        ctx.reactions.unreact(
          requireNumber(args, 'message_id'),
          self.id,
          requireString(args, 'reaction'),
        );
        return { success: true };
      }

      // --- Shared state ---

      case 'comm_state_set': {
        const self = requireAgent();
        const entry = ctx.state.set(
          optString(args, 'namespace') ?? 'default',
          requireString(args, 'key'),
          requireString(args, 'value'),
          self.id,
        );
        ctx.feed.logInternal(
          self.id,
          'state_change',
          entry.namespace + '/' + entry.key,
          entry.value.substring(0, 100),
        );
        return entry;
      }

      case 'comm_state_get': {
        requireAgent();
        return ctx.state.get(optString(args, 'namespace') ?? 'default', requireString(args, 'key'));
      }

      case 'comm_state_list': {
        requireAgent();
        return ctx.state.list(optString(args, 'namespace'), optString(args, 'prefix'));
      }

      case 'comm_state_delete': {
        requireAgent();
        const ns = optString(args, 'namespace') ?? 'default';
        return { deleted: ctx.state.delete(ns, requireString(args, 'key')) };
      }

      case 'comm_state_cas': {
        const self = requireAgent();
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

      case 'comm_log_activity': {
        const self = requireAgent();
        return ctx.feed.log(
          self.id,
          requireString(args, 'type'),
          optString(args, 'target'),
          optString(args, 'preview'),
        );
      }

      case 'comm_feed': {
        requireAgent();
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

      case 'comm_discover': {
        requireAgent();
        return ctx.agents.discover({
          skill: optString(args, 'skill'),
          tag: optString(args, 'tag'),
        });
      }

      default:
        throw new ValidationError(`Unknown tool: ${name}`);
    }
  };
}
