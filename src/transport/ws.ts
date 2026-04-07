// =============================================================================
// agent-comm — WebSocket transport
//
// Thin wrapper around agent-common's setupWebSocket. Supplies per-category
// fingerprints (agents, messages, channels, state, feed, branches), category
// data fetchers, and the full-state payload. The `messages` category bundles
// both the messages array and messageCount into a single delta entry.
// =============================================================================

import { setupWebSocket as setupKitWebSocket, type WsHandle } from 'agent-common';
import type { Server } from 'http';
import type { AppContext } from '../context.js';
import { readPackageMeta } from '../package-meta.js';

const packageMeta = readPackageMeta();

export type WebSocketHandle = WsHandle;

export function setupWebSocket(httpServer: Server, ctx: AppContext): WebSocketHandle {
  return setupKitWebSocket({
    httpServer,
    getFingerprints: () => getCategoryFingerprints(ctx),
    getCategoryData: (category) => {
      switch (category) {
        case 'agents':
          return { agents: getAgentsData(ctx) };
        case 'messages':
          return { messages: getMessagesData(ctx), messageCount: ctx.messages.count() };
        case 'channels':
          return { channels: getChannelsData(ctx) };
        case 'state':
          return { state: getStateData(ctx) };
        case 'feed':
          return { feed: getFeedData(ctx) };
        case 'branches':
          return { branches: getBranchesData(ctx) };
        default:
          return {};
      }
    },
    getFullState: () => ({
      version: packageMeta.version,
      agents: getAgentsData(ctx),
      channels: getChannelsData(ctx),
      messages: getMessagesData(ctx),
      messageCount: ctx.messages.count(),
      state: getStateData(ctx),
      feed: getFeedData(ctx),
      branches: getBranchesData(ctx),
    }),
    logError: (err) =>
      process.stderr.write(
        '[agent-comm] WS error: ' + (err instanceof Error ? err.message : String(err)) + '\n',
      ),
  });
}

// ---------------------------------------------------------------------------
// Per-category fingerprints
// ---------------------------------------------------------------------------

interface CategoryFingerprints extends Record<string, string> {
  agents: string;
  messages: string;
  channels: string;
  state: string;
  feed: string;
  branches: string;
}

function getCategoryFingerprints(ctx: AppContext): CategoryFingerprints {
  const row = ctx.db.queryOne<{
    agents_fp: string;
    messages_fp: string;
    channels_fp: string;
    state_fp: string;
    feed_fp: string;
    branches_fp: string;
  }>(
    `SELECT
       COALESCE((SELECT COUNT(*) FROM agents WHERE status != 'offline'), 0)
         || ':' || COALESCE((SELECT MAX(registered_at) FROM agents), '')
         || ':' || COALESCE((SELECT GROUP_CONCAT(status) FROM (SELECT status FROM agents WHERE status != 'offline' ORDER BY id)), '')
       AS agents_fp,
       COALESCE((SELECT MAX(id) FROM messages), 0)
         || ':' || COALESCE((SELECT COUNT(*) FROM messages), 0)
       AS messages_fp,
       COALESCE((SELECT COUNT(*) FROM channels), 0)
         || ':' || COALESCE((SELECT MAX(created_at) FROM channels), '')
         || ':' || COALESCE((SELECT COUNT(*) FROM channel_members), 0)
       AS channels_fp,
       COALESCE((SELECT COUNT(*) FROM state), 0)
         || ':' || COALESCE((SELECT MAX(rowid) FROM state), 0)
         || ':' || COALESCE((SELECT MAX(updated_at) FROM state), '')
       AS state_fp,
       COALESCE((SELECT MAX(id) FROM feed_events), 0)
       AS feed_fp,
       COALESCE((SELECT COUNT(*) FROM thread_branches), 0)
         || ':' || COALESCE((SELECT MAX(id) FROM thread_branches), 0)
       AS branches_fp`,
  );
  return {
    agents: row?.agents_fp ?? '',
    messages: row?.messages_fp ?? '',
    channels: row?.channels_fp ?? '',
    state: row?.state_fp ?? '',
    feed: row?.feed_fp ?? '',
    branches: row?.branches_fp ?? '',
  };
}

// ---------------------------------------------------------------------------
// State data fetchers
// ---------------------------------------------------------------------------

function getAgentsData(ctx: AppContext) {
  return ctx.agents.list({ includeOffline: true });
}

function getMessagesData(ctx: AppContext) {
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
    .toISOString()
    .replace('T', ' ')
    .slice(0, 19);
  const allMessages = ctx.messages.list({ limit: 50, since });
  return allMessages.filter((m) => m.channel_id !== null || m.to_agent === null);
}

function getChannelsData(ctx: AppContext) {
  return ctx.channels.list();
}

function getStateData(ctx: AppContext) {
  return ctx.state.list();
}

function getFeedData(ctx: AppContext) {
  return ctx.feed.recent(30);
}

function getBranchesData(ctx: AppContext) {
  return ctx.branches.list();
}
