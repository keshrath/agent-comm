// =============================================================================
// agent-comm — Core type definitions
// =============================================================================

// ---------------------------------------------------------------------------
// Agents
// ---------------------------------------------------------------------------

export type AgentStatus = 'online' | 'idle' | 'offline';

export interface Agent {
  readonly id: string;
  readonly name: string;
  readonly capabilities: readonly string[];
  readonly metadata: Record<string, unknown>;
  readonly status: AgentStatus;
  readonly status_text: string | null;
  readonly last_heartbeat: string;
  readonly registered_at: string;
  readonly skills: readonly Skill[];
  readonly last_activity: string | null;
}

export interface AgentCreateInput {
  name: string;
  capabilities?: string[];
  metadata?: Record<string, unknown>;
  skills?: Skill[];
}

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export interface Channel {
  readonly id: string;
  readonly name: string;
  readonly description: string | null;
  readonly created_by: string;
  readonly created_at: string;
  readonly archived_at: string | null;
}

export interface ChannelMember {
  readonly channel_id: string;
  readonly agent_id: string;
  readonly joined_at: string;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type MessageImportance = 'low' | 'normal' | 'high' | 'urgent';

export interface Message {
  readonly id: number;
  readonly channel_id: string | null;
  readonly from_agent: string;
  readonly to_agent: string | null;
  readonly thread_id: number | null;
  readonly branch_id: number | null;
  readonly content: string;
  readonly importance: MessageImportance;
  readonly ack_required: boolean;
  readonly created_at: string;
  readonly edited_at: string | null;
}

// ---------------------------------------------------------------------------
// Thread Branches
// ---------------------------------------------------------------------------

export interface ThreadBranch {
  readonly id: number;
  readonly parent_message_id: number;
  readonly name: string | null;
  readonly created_by: string | null;
  readonly created_at: string;
}

export interface MessageSendInput {
  to?: string;
  channel?: string;
  thread_id?: number;
  branch_id?: number;
  content: string;
  importance?: MessageImportance;
  ack_required?: boolean;
}

export interface MessageRead {
  readonly message_id: number;
  readonly agent_id: string;
  readonly read_at: string;
  readonly acked_at: string | null;
}

// ---------------------------------------------------------------------------
// Shared State
// ---------------------------------------------------------------------------

export interface StateEntry {
  readonly namespace: string;
  readonly key: string;
  readonly value: string;
  readonly updated_by: string;
  readonly updated_at: string;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type EventType =
  | 'agent:registered'
  | 'agent:updated'
  | 'agent:offline'
  | 'channel:created'
  | 'channel:archived'
  | 'channel:member_joined'
  | 'channel:member_left'
  | 'message:sent'
  | 'message:read'
  | 'message:acked'
  | 'state:changed'
  | 'state:deleted'
  | 'branch:created'
  | 'handoff:sent';

export interface CommEvent {
  readonly type: EventType;
  readonly timestamp: string;
  readonly data: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CommError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly statusCode: number = 400,
  ) {
    super(message);
    this.name = 'CommError';
  }
}

export class NotFoundError extends CommError {
  constructor(entity: string, id: string) {
    super(`${entity} not found: ${id}`, 'NOT_FOUND', 404);
    this.name = 'NotFoundError';
  }
}

export class ConflictError extends CommError {
  constructor(message: string) {
    super(message, 'CONFLICT', 409);
    this.name = 'ConflictError';
  }
}

export class ValidationError extends CommError {
  constructor(message: string) {
    super(message, 'VALIDATION_ERROR', 422);
    this.name = 'ValidationError';
  }
}

// ---------------------------------------------------------------------------
// JSON-RPC (MCP transport)
// ---------------------------------------------------------------------------

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | string | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

// ---------------------------------------------------------------------------
// Activity Feed
// ---------------------------------------------------------------------------

export type FeedEventType =
  | 'commit'
  | 'test_pass'
  | 'test_fail'
  | 'file_edit'
  | 'task_complete'
  | 'error'
  | 'custom'
  | 'register'
  | 'message'
  | 'state_change'
  | 'handoff'
  | 'branch';

export interface FeedEvent {
  readonly id: number;
  readonly agent_id: string | null;
  readonly type: string;
  readonly target: string | null;
  readonly preview: string | null;
  readonly created_at: string;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

export interface Skill {
  readonly id: string;
  readonly name: string;
  readonly tags: string[];
}
