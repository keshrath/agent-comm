// =============================================================================
// agent-comm — Application context
//
// Dependency injection root. Creates and wires together all services.
// Every layer receives its dependencies explicitly — no global state.
// =============================================================================

import { createDb, type Db, type DbOptions } from './storage/database.js';
import { EventBus } from './domain/events.js';
import { AgentService } from './domain/agents.js';
import { ChannelService } from './domain/channels.js';
import { MessageService } from './domain/messages.js';
import { StateService } from './domain/state.js';
import { CleanupService } from './domain/cleanup.js';
import { RateLimiter } from './domain/rate-limit.js';
import { ReactionService } from './domain/reactions.js';
import { FeedService } from './domain/feed.js';
import { BranchService } from './domain/branches.js';

export interface AppContext {
  readonly db: Db;
  readonly events: EventBus;
  readonly agents: AgentService;
  readonly channels: ChannelService;
  readonly messages: MessageService;
  readonly state: StateService;
  readonly cleanup: CleanupService;
  readonly rateLimiter: RateLimiter;
  readonly reactions: ReactionService;
  readonly feed: FeedService;
  readonly branches: BranchService;
  close(): void;
}

export function createContext(dbOptions?: DbOptions): AppContext {
  const db = createDb(dbOptions);
  const events = new EventBus();
  let closed = false;

  const retentionDays = Math.min(
    365,
    Math.max(1, parseInt(process.env.AGENT_COMM_RETENTION_DAYS ?? '7', 10) || 7),
  );

  const agents = new AgentService(db, events);
  const channels = new ChannelService(db, events);
  const messages = new MessageService(db, events);
  const state = new StateService(db, events);
  const cleanup = new CleanupService(db, retentionDays);
  const rateLimiter = new RateLimiter();
  const reactions = new ReactionService(db, events);
  const feed = new FeedService(db, events);
  const branches = new BranchService(db, events);

  // Wire cross-service dependencies (avoids circular imports)
  messages.setAgentLookup(agents);

  return {
    db,
    events,
    agents,
    channels,
    messages,
    state,
    cleanup,
    rateLimiter,
    reactions,
    feed,
    branches,
    close() {
      if (closed) return;
      closed = true;
      cleanup.stopTimer();
      agents.stopReaper();
      events.removeAll();
      db.close();
    },
  };
}
