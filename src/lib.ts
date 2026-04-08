// =============================================================================
// agent-comm — Library API
//
// Public exports for programmatic use. Import from 'agent-comm/lib'.
// The default export (index.ts) is the MCP stdio server.
// =============================================================================

// Context (entry point for library consumers)
export { createContext, type AppContext } from './context.js';

// Dashboard server (REST + WS) — exposed so embedded users (e.g. the bench)
// can spin up the HTTP layer without spawning the MCP stdio entry point.
export { startDashboard, type DashboardServer } from './server.js';

// Storage
export { createDb, type Db, type DbOptions } from './storage/database.js';

// Domain services
export { AgentService } from './domain/agents.js';
export { ChannelService } from './domain/channels.js';
export { MessageService } from './domain/messages.js';
export { StateService } from './domain/state.js';
export { FeedService } from './domain/feed.js';
export { BranchService } from './domain/branches.js';
export { CleanupService } from './domain/cleanup.js';
export { EventBus } from './domain/events.js';
export { RateLimiter } from './domain/rate-limit.js';

// Types
export type {
  Agent,
  AgentStatus,
  AgentCreateInput,
  Channel,
  ChannelMember,
  Message,
  MessageImportance,
  MessageSendInput,
  MessageRead,
  ThreadBranch,
  StateEntry,
  EventType,
  CommEvent,
  FeedEventType,
  FeedEvent,
  Skill,
  JsonRpcRequest,
  JsonRpcResponse,
  ToolDefinition,
} from './types.js';

// Error classes
export { CommError, NotFoundError, ConflictError, ValidationError } from './types.js';
