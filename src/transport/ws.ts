// =============================================================================
// agent-comm — WebSocket transport
//
// Real-time state streaming to connected UI clients.
// Full state sent on connect; DB fingerprint polled every 2s to detect
// changes from any MCP process (each has its own in-memory EventBus,
// so cross-process events require DB-level change detection).
// =============================================================================

import { WebSocketServer, WebSocket } from 'ws';
import type { Server } from 'http';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AppContext } from '../context.js';

const __ws_dirname = dirname(fileURLToPath(import.meta.url));
let pkg: { version: string };
try {
  pkg = JSON.parse(readFileSync(join(__ws_dirname, '..', '..', 'package.json'), 'utf8'));
} catch (err) {
  process.stderr.write(
    '[agent-comm] Failed to read package.json: ' +
      (err instanceof Error ? err.message : String(err)) +
      '\n',
  );
  pkg = { version: '0.0.0' };
}

const MAX_WS_MESSAGE_SIZE = 4096;
const MAX_WS_CONNECTIONS = 50;
const PING_INTERVAL_MS = 30_000;
const DB_POLL_INTERVAL_MS = 2_000;

export interface WebSocketHandle {
  wss: WebSocketServer;
  close(): void;
}

interface ClientState {
  alive: boolean;
}

export function setupWebSocket(httpServer: Server, ctx: AppContext): WebSocketHandle {
  const wss = new WebSocketServer({ server: httpServer, maxPayload: MAX_WS_MESSAGE_SIZE });
  const clients = new Map<WebSocket, ClientState>();

  wss.on('connection', (ws: WebSocket) => {
    if (wss.clients.size > MAX_WS_CONNECTIONS) {
      ws.close(1013, 'Too many connections');
      return;
    }

    clients.set(ws, { alive: true });
    sendFullState(ws, ctx);

    ws.on('pong', () => {
      const s = clients.get(ws);
      if (s) s.alive = true;
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
        sendFullState(ws, ctx);
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

  // Poll DB for changes from any MCP process. A lightweight fingerprint
  // query covers all tables; on change we push a full state snapshot.
  let lastFingerprint = '';
  const dbPollInterval = setInterval(() => {
    if (clients.size === 0) return;
    try {
      const fp = getFingerprint(ctx);
      if (fp !== lastFingerprint) {
        lastFingerprint = fp;
        for (const [ws] of clients) {
          if (ws.readyState === WebSocket.OPEN) {
            sendFullState(ws, ctx);
          }
        }
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

/** Cheap fingerprint across all dashboard-relevant tables. */
function getFingerprint(ctx: AppContext): string {
  const row = ctx.db.queryOne<{ fp: string }>(
    `SELECT
       COALESCE((SELECT MAX(id) FROM messages), 0)
       || ':' || COALESCE((SELECT COUNT(*) FROM agents WHERE status != 'offline'), 0)
       || ':' || COALESCE((SELECT MAX(registered_at) FROM agents), '')
       || ':' || COALESCE((SELECT COUNT(*) FROM channels), 0)
       || ':' || COALESCE((SELECT COUNT(*) FROM state), 0)
       || ':' || COALESCE((SELECT MAX(rowid) FROM state), 0)
       || ':' || COALESCE((SELECT COUNT(*) FROM message_reactions), 0)
       || ':' || COALESCE((SELECT MAX(id) FROM feed_events), 0)
       || ':' || COALESCE((SELECT COUNT(*) FROM thread_branches), 0)
     AS fp`,
  );
  return row?.fp ?? '';
}

function sendFullState(ws: WebSocket, ctx: AppContext): void {
  try {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000)
      .toISOString()
      .replace('T', ' ')
      .slice(0, 19);
    const allMessages = ctx.messages.list({ limit: 50, since });
    const publicMessages = allMessages.filter((m) => m.channel_id !== null || m.to_agent === null);
    const messageIds = publicMessages.map((m) => m.id);
    const reactions = ctx.reactions.getForMessages(messageIds);

    ws.send(
      JSON.stringify({
        type: 'state',
        version: pkg.version,
        agents: ctx.agents.list({ includeOffline: true }),
        channels: ctx.channels.list(),
        messages: publicMessages,
        messageCount: ctx.messages.count(),
        state: ctx.state.list(),
        reactions,
        feed: ctx.feed.recent(30),
        branches: ctx.branches.list(),
      }),
    );
  } catch (err) {
    process.stderr.write(
      '[agent-comm] WS send error: ' + (err instanceof Error ? err.message : String(err)) + '\n',
    );
  }
}
