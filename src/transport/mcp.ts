// =============================================================================
// agent-comm — MCP transport
//
// Maps MCP tool calls to domain services. Each tool is a thin adapter —
// validation lives in the domain layer, not here.
//
// Consolidated from 38 tools to 12 tools in v1.3.0.
// =============================================================================

import type { AppContext } from '../context.js';
import type { ToolDefinition } from '../types.js';
import { NotFoundError, ValidationError } from '../types.js';
import { toolHandlers } from './mcp-handlers.js';
import type { HandlerAgent } from './mcp-handlers.js';

// Shared schema fragments for consistency
// ---------------------------------------------------------------------------

const IMPORTANCE_SCHEMA = {
  type: 'string',
  enum: ['low', 'normal', 'high', 'urgent'],
  description: 'Message importance level (default: "normal")',
} as const;

const ACTION_REQUIRED = {
  type: 'string',
  description: 'Action to perform (see enum for options)',
} as const;

// ---------------------------------------------------------------------------
// Tool definitions (12 consolidated tools)
// ---------------------------------------------------------------------------

export const tools: ToolDefinition[] = [
  // 1. comm_register — keep as-is
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

  // 2. comm_agents — merged list_agents, discover, whoami, heartbeat, set_status, unregister
  {
    name: 'comm_agents',
    description:
      'Agent management. Actions: "list" (list agents, filter by status/capability/stuck), "discover" (find by skill/tag), "whoami" (return identity), "heartbeat" (keep alive + optional status), "status" (set status text), "unregister" (go offline).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          ...ACTION_REQUIRED,
          enum: ['list', 'discover', 'whoami', 'heartbeat', 'status', 'unregister'],
        },
        // list
        status: {
          type: 'string',
          enum: ['online', 'idle', 'offline'],
          description: '[list] Filter by status',
        },
        capability: { type: 'string', description: '[list] Filter by capability keyword' },
        include_offline: {
          type: 'boolean',
          description: '[list] Include offline agents (default: false)',
        },
        stuck_threshold_minutes: {
          type: 'number',
          description:
            '[list] When provided, only returns agents alive but inactive for this many minutes (1-1440)',
        },
        // discover
        skill: { type: 'string', description: '[discover] Skill ID or name to search for' },
        tag: {
          type: 'string',
          description: '[discover] Tag to search for across all agent skills',
        },
        // heartbeat + status
        status_text: {
          type: 'string',
          description: '[heartbeat/status] Status text (max 256 chars, omit or null to clear)',
        },
      },
      required: ['action'],
    },
  },

  // 3. comm_send — merged send, broadcast, channel_send, reply, forward
  {
    name: 'comm_send',
    description:
      'Send a message. Modes: direct (set "to"), channel (set "channel"), broadcast (set "broadcast":true), reply (set "reply_to"), forward (set "forward"). Only one mode at a time.',
    inputSchema: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Recipient agent name or ID (direct message)' },
        channel: { type: 'string', description: 'Channel name to post to' },
        broadcast: { type: 'boolean', description: 'Send to all online agents' },
        reply_to: {
          type: 'number',
          description: 'Reply to this message ID (auto-threads, auto-routes to same target)',
        },
        forward: {
          type: 'number',
          description: 'Forward this message ID (must also set "to" or "channel")',
        },
        content: { type: 'string', description: 'Message content' },
        thread_id: {
          type: 'number',
          description: 'Reply to this thread (for direct/channel sends)',
        },
        importance: IMPORTANCE_SCHEMA,
        ack_required: {
          type: 'boolean',
          description: 'Whether the recipient must acknowledge (direct only)',
        },
        comment: {
          type: 'string',
          description: 'Optional comment to add when forwarding',
        },
      },
      required: ['content'],
    },
  },

  // 4. comm_inbox — with optional thread_id for thread retrieval
  {
    name: 'comm_inbox',
    description:
      'Read messages in your inbox (direct + channel messages). Set thread_id to get a specific thread instead.',
    inputSchema: {
      type: 'object',
      properties: {
        unread_only: { type: 'boolean', description: 'Only unread messages (default: true)' },
        limit: { type: 'number', description: 'Max messages (default: 50, max: 500)' },
        thread_id: {
          type: 'number',
          description:
            'When provided, returns the full thread for this message ID instead of the inbox',
        },
      },
    },
  },

  // 5. comm_channel — merged all channel tools except channel_send (in comm_send)
  {
    name: 'comm_channel',
    description:
      'Channel management. Actions: "create", "list", "join", "leave", "archive", "update", "members", "history".',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          ...ACTION_REQUIRED,
          enum: ['create', 'list', 'join', 'leave', 'archive', 'update', 'members', 'history'],
        },
        channel: {
          type: 'string',
          description: 'Channel name (required for all actions except "list")',
        },
        description: {
          type: 'string',
          description: '[create/update] Channel description',
        },
        include_archived: {
          type: 'boolean',
          description: '[list] Include archived channels',
        },
        limit: {
          type: 'number',
          description: '[history] Max messages (default: 50, max: 500)',
        },
      },
      required: ['action'],
    },
  },

  // 7. comm_state — merged all state tools
  {
    name: 'comm_state',
    description:
      'Shared key-value state. Actions: "set", "get", "list", "delete", "cas" (atomic compare-and-swap).',
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          ...ACTION_REQUIRED,
          enum: ['set', 'get', 'list', 'delete', 'cas'],
        },
        namespace: { type: 'string', description: 'Namespace (default: "default")' },
        key: { type: 'string', description: 'Key name (required for set/get/delete/cas)' },
        value: { type: 'string', description: '[set] Value (JSON as string if needed)' },
        expected: {
          type: ['string', 'null'],
          description: '[cas] Expected current value (null if key should not exist)',
        },
        new_value: { type: 'string', description: '[cas] New value (empty string to delete)' },
        prefix: { type: 'string', description: '[list] Filter by key prefix' },
      },
      required: ['action'],
    },
  },

  // 8. comm_branch
  {
    name: 'comm_branch',
    description:
      'Conversation branching. Without message_id: list all branches. With message_id: fork a conversation at that message, creating an isolated history branch.',
    inputSchema: {
      type: 'object',
      properties: {
        message_id: {
          type: 'number',
          description:
            'When provided, creates a branch forking from this message. When omitted, lists all branches.',
        },
        name: {
          type: 'string',
          description: 'Branch name (1-128 chars, only used when creating a branch)',
        },
      },
    },
  },

  // 11. comm_handoff — keep as-is
  {
    name: 'comm_handoff',
    description:
      'Transfer conversation ownership to another agent with full context. Sends a structured handoff message with thread history and optional context.',
    inputSchema: {
      type: 'object',
      properties: {
        to: {
          type: 'string',
          description: 'Target agent name or ID to hand off to',
        },
        thread_id: {
          type: 'number',
          description: 'Thread ID to include history from (optional)',
        },
        context: {
          type: 'string',
          description: 'Additional context or instructions for the receiving agent',
        },
        channel: {
          type: 'string',
          description: 'Channel to post the handoff in (optional, otherwise sent as DM)',
        },
      },
      required: ['to'],
    },
  },

  // 12. comm_search — keep as-is
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
];

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
        } catch (err) {
          process.stderr.write(
            '[agent-comm] Heartbeat timer error: ' +
              (err instanceof Error ? err.message : String(err)) +
              '\n',
          );
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

  // Build the agent context object passed to each handler
  const agentCtx: HandlerAgent = {
    get current() {
      return currentAgent;
    },
    setCurrent(agent) {
      currentAgent = agent;
    },
    require() {
      if (!currentAgent) throw new ValidationError('Not registered. Call comm_register first.');
      return currentAgent;
    },
    resolve(nameOrId: string) {
      const byName = ctx.agents.getByName(nameOrId);
      if (byName) return { id: byName.id, name: byName.name };
      const byId = ctx.agents.getById(nameOrId);
      if (byId) return { id: byId.id, name: byId.name };
      throw new NotFoundError('Agent', nameOrId);
    },
    resolveChannel(name: string) {
      const ch = ctx.channels.getByName(name);
      if (!ch) throw new NotFoundError('Channel', name);
      return ch.id;
    },
    requireChannelMember(channelId: string, agentId: string) {
      if (!ctx.channels.isMember(channelId, agentId)) {
        throw new ValidationError('You must join this channel before posting.');
      }
    },
    startHeartbeat,
    stopHeartbeat,
  };

  return function handleTool(name: string, args: Record<string, unknown>): unknown {
    // Auto-heartbeat on every tool call to keep MCP agents alive
    if (currentAgent && name !== 'comm_register') {
      try {
        ctx.agents.heartbeat(currentAgent.id);
      } catch (err) {
        process.stderr.write(
          '[agent-comm] Auto-heartbeat error: ' +
            (err instanceof Error ? err.message : String(err)) +
            '\n',
        );
      }
    }

    const handler = toolHandlers[name];
    if (!handler) {
      throw new ValidationError(`Unknown tool: ${name}`);
    }
    return handler(ctx, args, agentCtx);
  };
}
