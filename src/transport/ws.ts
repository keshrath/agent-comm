// =============================================================================
// agent-comm — WebSocket transport
//
// Real-time state streaming to connected UI clients.
// Full state sent on connect; subsequent updates are delta-based —
// each state category is fingerprinted and only changed categories are sent.
// =============================================================================

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import type { AppContext } from '../context.js';
import { readPackageMeta } from '../package-meta.js';

const packageMeta = readPackageMeta();

const MAX_WS_MESSAGE_SIZE = 4096;
const MAX_WS_CONNECTIONS = 50;
const PING_INTERVAL_MS = 30_000;
const DB_POLL_INTERVAL_MS = 2_000;

export interface WebSocketHandle {
  wss: WebSocketServer;
  close(): void;
}

interface CategoryFingerprints {
  agents: string;
  messages: string;
  channels: string;
  state: string;
  feed: string;
  branches: string;
}

interface ClientState {
  alive: boolean;
  fingerprints: CategoryFingerprints | null;
}

export function setupWebSocket(httpServer: Server, ctx: AppContext): WebSocketHandle {
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_WS_MESSAGE_SIZE });
  const clients = new Map<WebSocket, ClientState>();

  wss.on('connection', (ws: WebSocket) => {
    if (wss.clients.size > MAX_WS_CONNECTIONS) {
      ws.close(1013, 'Too many connections');
      return;
    }

    clients.set(ws, { alive: true, fingerprints: null });
    sendFullState(ws, ctx, clients);

    ws.on('pong', () => {
      const clientState = clients.get(ws);
      if (clientState) clientState.alive = true;
    });

    ws.on('message', (raw: Buffer) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch (err) {
        process.stderr.write(
          '[agent-comm] WS message parse error: ' +
            (err instanceof Error ? err.message : String(err)) +
            '\n',
        );
        ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
        return;
      }

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        ws.send(JSON.stringify({ type: 'error', message: 'Message must be a JSON object' }));
        return;
      }

      const msg = parsed as { type: string };

      if (msg.type === 'refresh') {
        const clientState = clients.get(ws);
        if (clientState) clientState.fingerprints = null;
        sendFullState(ws, ctx, clients);
      } else {
        const safeType = String(msg.type)
          .slice(0, 64)
          .replace(/[<>&"']/g, '');
        ws.send(JSON.stringify({ type: 'error', message: `Unknown message type: ${safeType}` }));
      }
    });

    ws.on('error', () => clients.delete(ws));
    ws.on('close', () => clients.delete(ws));
  });

  // Ping/pong heartbeat to detect dead connections
  const pingInterval = setInterval(() => {
    for (const [ws, state] of clients) {
      if (!state.alive) {
        ws.terminate();
        clients.delete(ws);
        continue;
      }
      state.alive = false;
      ws.ping();
    }
  }, PING_INTERVAL_MS);
  pingInterval.unref();

  // Poll DB for changes. Per-category fingerprints allow delta updates —
  // only categories whose fingerprint changed are included in the payload.
  const dbPollInterval = setInterval(() => {
    if (clients.size === 0) return;
    try {
      const currentFp = getCategoryFingerprints(ctx);
      for (const [ws, clientState] of clients) {
        if (ws.readyState !== WebSocket.OPEN) continue;
        if (!clientState.fingerprints) {
          sendFullState(ws, ctx, clients);
          continue;
        }
        sendDelta(ws, ctx, clientState, currentFp);
      }
    } catch (err) {
      process.stderr.write(
        '[agent-comm] WS DB poll error: ' +
          (err instanceof Error ? err.message : String(err)) +
          '\n',
      );
    }
  }, DB_POLL_INTERVAL_MS);
  dbPollInterval.unref();

  return {
    wss,
    close() {
      clearInterval(pingInterval);
      clearInterval(dbPollInterval);
      for (const [ws] of clients) {
        ws.close(1001, 'Server shutting down');
      }
      clients.clear();
      wss.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Per-category fingerprints
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Send helpers
// ---------------------------------------------------------------------------

function sendFullState(ws: WebSocket, ctx: AppContext, clients: Map<WebSocket, ClientState>): void {
  try {
    const fp = getCategoryFingerprints(ctx);
    const clientState = clients.get(ws);
    if (clientState) clientState.fingerprints = { ...fp };

    ws.send(
      JSON.stringify({
        type: 'state',
        version: packageMeta.version,
        agents: getAgentsData(ctx),
        channels: getChannelsData(ctx),
        messages: getMessagesData(ctx),
        messageCount: ctx.messages.count(),
        state: getStateData(ctx),
        feed: getFeedData(ctx),
        branches: getBranchesData(ctx),
      }),
    );
  } catch (err) {
    process.stderr.write(
      '[agent-comm] WS send error: ' + (err instanceof Error ? err.message : String(err)) + '\n',
    );
  }
}

function sendDelta(
  ws: WebSocket,
  ctx: AppContext,
  clientState: ClientState,
  currentFp: CategoryFingerprints,
): void {
  const prevFp = clientState.fingerprints!;
  const changed: Partial<Record<string, unknown>> = {};
  let hasChanges = false;

  if (prevFp.agents !== currentFp.agents) {
    changed.agents = getAgentsData(ctx);
    hasChanges = true;
  }
  if (prevFp.messages !== currentFp.messages) {
    changed.messages = getMessagesData(ctx);
    changed.messageCount = ctx.messages.count();
    hasChanges = true;
  }
  if (prevFp.channels !== currentFp.channels) {
    changed.channels = getChannelsData(ctx);
    hasChanges = true;
  }
  if (prevFp.state !== currentFp.state) {
    changed.state = getStateData(ctx);
    hasChanges = true;
  }
  if (prevFp.feed !== currentFp.feed) {
    changed.feed = getFeedData(ctx);
    hasChanges = true;
  }
  if (prevFp.branches !== currentFp.branches) {
    changed.branches = getBranchesData(ctx);
    hasChanges = true;
  }

  if (!hasChanges) return;

  clientState.fingerprints = { ...currentFp };

  try {
    ws.send(
      JSON.stringify({
        type: 'state',
        version: packageMeta.version,
        delta: true,
        ...changed,
      }),
    );
  } catch (err) {
    process.stderr.write(
      '[agent-comm] WS delta send error: ' +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
  }
}
