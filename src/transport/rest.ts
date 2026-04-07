// =============================================================================
// agent-comm — REST transport
//
// Lightweight HTTP API using only node:http. No framework dependencies.
// Serves both the JSON API and the static web UI.
// =============================================================================

import type { IncomingMessage, ServerResponse } from 'http';
import { readFileSync, realpathSync } from 'fs';
import { join, extname, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { AppContext } from '../context.js';
import { CommError, ValidationError } from '../types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

type RouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  params: Record<string, string>,
) => void | Promise<void>;

interface Route {
  method: string;
  pattern: RegExp;
  paramNames: string[];
  handler: RouteHandler;
}

export function createRouter(ctx: AppContext): (req: IncomingMessage, res: ServerResponse) => void {
  const routes: Route[] = [];
  const uiDir = resolve(join(__dirname, '..', 'ui'));

  function route(method: string, path: string, handler: RouteHandler): void {
    const paramNames: string[] = [];
    const pattern = path.replace(/:(\w+)/g, (_match, name) => {
      paramNames.push(name);
      return '([^/]+)';
    });
    routes.push({ method, pattern: new RegExp(`^${pattern}$`), paramNames, handler });
  }

  function json(res: ServerResponse, data: unknown, status = 200): void {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(JSON.stringify(data));
  }

  // -----------------------------------------------------------------------
  // API routes
  // -----------------------------------------------------------------------

  let pkg: { version: string };
  try {
    pkg = JSON.parse(readFileSync(join(__dirname, '..', '..', 'package.json'), 'utf8'));
  } catch (err) {
    process.stderr.write(
      '[agent-comm] Failed to read package.json: ' +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
    pkg = { version: '0.0.0' };
  }

  route('GET', '/health', (_req, res) => {
    json(res, {
      status: 'ok',
      version: pkg.version,
      uptime: process.uptime(),
      agents: ctx.agents.list().length,
    });
  });

  route('GET', '/api/agents', (_req, res) => {
    json(res, ctx.agents.list());
  });

  route('GET', '/api/agents/:id', (_req, res, params) => {
    const agent = ctx.agents.resolveByNameOrId(params.id);
    if (!agent) return json(res, { error: 'Not found' }, 404);
    json(res, agent);
  });

  route('GET', '/api/agents/:id/heartbeat', (_req, res, params) => {
    const agent = ctx.agents.resolveByNameOrId(params.id);
    if (!agent) return json(res, { error: 'Not found' }, 404);
    const now = Date.now();
    const hbTime = new Date(
      agent.last_heartbeat + (agent.last_heartbeat.includes('Z') ? '' : 'Z'),
    ).getTime();
    const ageMs = Math.max(0, now - hbTime);
    json(res, {
      agent_id: agent.id,
      name: agent.name,
      status: agent.status,
      status_text: agent.status_text,
      last_heartbeat: agent.last_heartbeat,
      heartbeat_age_ms: ageMs,
      heartbeat_age_s: Math.floor(ageMs / 1000),
    });
  });

  route('GET', '/api/channels', (_req, res) => {
    json(res, ctx.channels.list());
  });

  route('GET', '/api/channels/:name', (_req, res, params) => {
    const channel = ctx.channels.getByName(params.name);
    if (!channel) return json(res, { error: 'Not found' }, 404);
    json(res, {
      ...channel,
      members: ctx.channels.members(channel.id),
    });
  });

  route('GET', '/api/channels/:name/members', (_req, res, params) => {
    const channel = ctx.channels.getByName(params.name);
    if (!channel) return json(res, { error: 'Not found' }, 404);
    json(res, ctx.channels.members(channel.id));
  });

  route('GET', '/api/channels/:name/messages', (req, res, params) => {
    const channel = ctx.channels.getByName(params.name);
    if (!channel) return json(res, { error: 'Not found' }, 404);
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const limit = Math.min(
      Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50),
      500,
    );
    json(res, ctx.messages.list({ channel: channel.id, limit }));
  });

  route('GET', '/api/messages', (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const limit = Math.min(
      Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50),
      500,
    );
    const from = url.searchParams.get('from') ?? undefined;
    const to = url.searchParams.get('to') ?? undefined;
    const offset = Math.max(0, parseInt(url.searchParams.get('offset') ?? '0', 10) || 0);
    json(res, ctx.messages.list({ from, to, limit, offset }));
  });

  route('GET', '/api/messages/:id/thread', (_req, res, params) => {
    const id = parseInt(params.id, 10);
    if (isNaN(id)) return json(res, { error: 'Invalid message ID' }, 400);
    json(res, ctx.messages.thread(id));
  });

  route('GET', '/api/search', (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const query = url.searchParams.get('q');
    if (!query) return json(res, { error: 'Missing ?q= parameter' }, 400);
    if (query.length > 1000)
      return json(res, { error: 'Search query too long (max 1000 chars)' }, 400);
    const channel = url.searchParams.get('channel') ?? undefined;
    const from = url.searchParams.get('from') ?? undefined;
    const channelId = channel ? ctx.channels.getByName(channel)?.id : undefined;
    json(
      res,
      ctx.messages.search(query, {
        limit: parseInt(url.searchParams.get('limit') ?? '20', 10),
        channel: channelId,
        from,
      }),
    );
  });

  route('GET', '/api/state', (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const namespace = url.searchParams.get('namespace') ?? undefined;
    const prefix = url.searchParams.get('prefix') ?? undefined;
    json(res, ctx.state.list(namespace, prefix));
  });

  route('GET', '/api/state/:namespace/:key', (_req, res, params) => {
    const entry = ctx.state.get(params.namespace, params.key);
    if (!entry) return json(res, { error: 'Not found' }, 404);
    json(res, entry);
  });

  route('GET', '/api/feed', (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const agent = url.searchParams.get('agent') ?? undefined;
    const type = url.searchParams.get('type') ?? undefined;
    const since = url.searchParams.get('since') ?? undefined;
    const limit = Math.min(
      Math.max(1, parseInt(url.searchParams.get('limit') ?? '50', 10) || 50),
      500,
    );
    let agentId: string | undefined;
    if (agent) {
      const resolved = ctx.agents.resolveByNameOrId(agent);
      agentId = resolved?.id;
    }
    const offset = parseInt(url.searchParams.get('offset') ?? '0', 10) || 0;
    json(res, ctx.feed.query({ agent: agentId, type, since, limit, offset }));
  });

  route('GET', '/api/branches', (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const messageId = url.searchParams.get('message_id');
    const parentId = messageId ? parseInt(messageId, 10) : undefined;
    json(res, ctx.branches.list(parentId));
  });

  route('GET', '/api/branches/:id', (_req, res, params) => {
    const id = parseInt(params.id, 10);
    if (isNaN(id)) return json(res, { error: 'Invalid branch ID' }, 400);
    const branch = ctx.branches.getById(id);
    if (!branch) return json(res, { error: 'Not found' }, 404);
    json(res, branch);
  });

  route('GET', '/api/branches/:id/messages', (_req, res, params) => {
    const id = parseInt(params.id, 10);
    if (isNaN(id)) return json(res, { error: 'Invalid branch ID' }, 400);
    try {
      json(res, ctx.branches.branchMessages(id));
    } catch (err) {
      process.stderr.write(
        '[agent-comm] Branch messages error: ' +
          (err instanceof Error ? err.message : String(err)) +
          '\n',
      );
      json(res, { error: 'Not found' }, 404);
    }
  });

  route('GET', '/api/stuck', (req, res) => {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const threshold = parseInt(url.searchParams.get('threshold_minutes') ?? '10', 10) || 10;
    json(res, ctx.agents.stuckAgents(threshold));
  });

  route('GET', '/api/overview', (_req, res) => {
    const agents = ctx.agents.list({ includeOffline: true });
    const channels = ctx.channels.list();
    const recentMessages = ctx.messages.list({ limit: 30 });
    const stateEntries = ctx.state.list();
    const feedEvents = ctx.feed.recent(20);
    json(res, {
      agents,
      channels,
      recent_messages: recentMessages,
      state_entries: stateEntries,
      feed_events: feedEvents,
    });
  });

  // -----------------------------------------------------------------------
  // POST endpoints for mutations
  // -----------------------------------------------------------------------

  /** Read JSON body from a POST/PUT request */
  function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      let size = 0;
      const MAX_BODY = 64 * 1024;
      req.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new ValidationError('Request body too large'));
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString());
          if (typeof body !== 'object' || body === null || Array.isArray(body)) {
            reject(new ValidationError('Request body must be a JSON object'));
          } else {
            resolve(body as Record<string, unknown>);
          }
        } catch (err) {
          process.stderr.write(
            '[agent-comm] Request body parse error: ' +
              (err instanceof Error ? err.message : String(err)) +
              '\n',
          );
          reject(new ValidationError('Invalid JSON in request body'));
        }
      });
      req.on('error', reject);
    });
  }

  /** Validate and send a message from body fields on behalf of a resolved sender. */
  function processSendMessage(
    res: ServerResponse,
    body: Record<string, unknown>,
    sender: { id: string; status: string; name: string },
  ): void {
    if (sender.status === 'offline') {
      json(res, { error: `Agent "${sender.name}" is offline. Register via MCP first.` }, 403);
      return;
    }

    const to = body.to as string | undefined;
    const channel = body.channel as string | undefined;
    const content = body.content as string | undefined;

    if (!content || typeof content !== 'string') {
      json(res, { error: '"content" is required' }, 400);
      return;
    }

    const channelId = channel ? ctx.channels.getByName(channel)?.id : undefined;
    if (channel && !channelId) {
      json(res, { error: `Channel not found: ${channel}` }, 404);
      return;
    }

    let toAgentId: string | undefined;
    if (to) {
      const target = ctx.agents.resolveByNameOrId(to);
      if (!target) {
        json(res, { error: `Agent not found: ${to}` }, 404);
        return;
      }
      toAgentId = target.id;
    }

    const threadId = body.thread_id;
    if (threadId !== undefined && threadId !== null && typeof threadId !== 'number') {
      json(res, { error: '"thread_id" must be a number' }, 400);
      return;
    }

    const importance = body.importance;
    const VALID_IMPORTANCE = new Set(['low', 'normal', 'high', 'urgent']);
    if (importance !== undefined && importance !== null) {
      if (typeof importance !== 'string' || !VALID_IMPORTANCE.has(importance)) {
        json(res, { error: '"importance" must be one of: low, normal, high, urgent' }, 400);
        return;
      }
    }

    const msg = ctx.messages.send(sender.id, {
      to: toAgentId,
      channel: channelId,
      content,
      thread_id: threadId as number | undefined,
      importance: importance as 'low' | 'normal' | 'high' | 'urgent' | undefined,
    });
    json(res, msg, 201);
  }

  route('POST', '/api/agents/:id/messages', async (req, res, params) => {
    const sender = ctx.agents.resolveByNameOrId(params.id);
    if (!sender) return json(res, { error: `Agent not found: ${params.id}` }, 404);
    const body = await readBody(req);
    processSendMessage(res, body, sender);
  });

  route('POST', '/api/messages', async (req, res) => {
    const body = await readBody(req);
    const from = body.from as string | undefined;

    if (!from || typeof from !== 'string')
      return json(res, { error: '"from" (agent name or ID) is required' }, 400);

    const sender = ctx.agents.resolveByNameOrId(from);
    if (!sender) return json(res, { error: `Agent not found: ${from}` }, 404);

    processSendMessage(res, body, sender);
  });

  route('POST', '/api/state/:namespace/:key', async (req, res, params) => {
    const body = await readBody(req);
    const value = body.value as string | undefined;
    const updatedBy = body.updated_by as string | undefined;
    const ttlRaw = body.ttl_seconds;
    const ttl =
      typeof ttlRaw === 'number' && Number.isFinite(ttlRaw) && ttlRaw > 0 ? ttlRaw : undefined;

    if (typeof value !== 'string') return json(res, { error: '"value" is required' }, 400);
    if (!updatedBy || typeof updatedBy !== 'string')
      return json(res, { error: '"updated_by" (agent ID) is required' }, 400);

    const entry = ctx.state.set(params.namespace, params.key, value, updatedBy, ttl);
    json(res, entry);
  });

  route('DELETE', '/api/state/:namespace/:key', (_req, res, params) => {
    const deleted = ctx.state.delete(params.namespace, params.key);
    if (!deleted) return json(res, { error: 'Not found' }, 404);
    json(res, { deleted: true });
  });

  route('DELETE', '/api/messages', (_req, res) => {
    const purged = ctx.cleanup.purgeMessages();
    json(res, { purged });
  });

  route('DELETE', '/api/agents/offline', (_req, res) => {
    const purged = ctx.cleanup.purgeOfflineAgents();
    json(res, { purged });
  });

  route('POST', '/api/cleanup', (_req, res) => {
    const stats = ctx.cleanup.purgeAll();
    json(res, stats);
  });

  route('POST', '/api/cleanup/stale', (_req, res) => {
    const stats = ctx.cleanup.purgeStaleAssociated();
    json(res, stats);
  });

  route('POST', '/api/cleanup/full', (_req, res) => {
    const stats = ctx.cleanup.purgeEverything();
    json(res, stats);
  });

  route('GET', '/api/export', (_req, res) => {
    json(res, {
      exported_at: new Date().toISOString(),
      agents: ctx.agents.list({ includeOffline: true }),
      channels: ctx.channels.list(true),
      messages: ctx.messages.list({ limit: 500 }),
      state: ctx.state.list(),
    });
  });

  route('DELETE', '/api/messages/:id', async (req, res, params) => {
    const id = parseInt(params.id, 10);
    if (isNaN(id)) return json(res, { error: 'Invalid message ID' }, 400);
    const body = await readBody(req);
    const agentId = body.agent_id as string | undefined;
    if (!agentId || typeof agentId !== 'string')
      return json(res, { error: '"agent_id" is required' }, 400);
    ctx.messages.delete(id, agentId);
    json(res, { deleted: true });
  });

  // -----------------------------------------------------------------------
  // Request handler
  // -----------------------------------------------------------------------

  return async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      res.end();
      return;
    }

    const url = new URL(req.url ?? '/', `http://${req.headers.host}`);
    const pathname = url.pathname;

    for (const r of routes) {
      if (req.method !== r.method) continue;
      const match = pathname.match(r.pattern);
      if (!match) continue;

      const params: Record<string, string> = {};
      r.paramNames.forEach((name, i) => {
        params[name] = decodeURIComponent(match[i + 1]);
      });

      try {
        await r.handler(req, res, params);
      } catch (err) {
        if (err instanceof CommError) {
          json(res, { error: err.message, code: err.code }, err.statusCode);
        } else {
          process.stderr.write(
            '[agent-comm] REST handler error: ' +
              (err instanceof Error ? err.message : String(err)) +
              '\n',
          );
          json(res, { error: 'Internal server error' }, 500);
        }
      }
      return;
    }

    if (pathname.startsWith('/api/')) {
      json(res, { error: 'Not found' }, 404);
      return;
    }

    serveStatic(res, uiDir, pathname === '/' ? '/index.html' : pathname);
  };
}

function serveStatic(res: ServerResponse, baseDir: string, pathname: string): void {
  // Decode percent-encoded characters first to catch encoded traversal attempts (%2e%2e, %00)
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch (err) {
    process.stderr.write(
      '[agent-comm] URI decode error: ' + (err instanceof Error ? err.message : String(err)) + '\n',
    );
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  if (decoded.includes('\0') || /(?:^|[\\/])\.\.(?:[\\/]|$)/.test(decoded)) {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }

  let realBase: string;
  try {
    realBase = realpathSync(baseDir);
  } catch (err) {
    process.stderr.write(
      '[agent-comm] Static base dir resolve error: ' +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
    res.writeHead(404);
    res.end('Not found');
    return;
  }

  const filePath = resolve(join(baseDir, decoded));
  if (!filePath.startsWith(realBase)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  let realFilePath: string;
  try {
    realFilePath = realpathSync(filePath);
  } catch (err) {
    process.stderr.write(
      '[agent-comm] Static file resolve error: ' +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
    realFilePath = filePath;
  }

  if (!realFilePath.startsWith(realBase)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  try {
    const content = readFileSync(realFilePath);
    const ext = extname(realFilePath);
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch (err) {
    process.stderr.write(
      '[agent-comm] Static file read error: ' +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
    try {
      const indexPath = join(baseDir, 'index.html');
      const indexContent = readFileSync(indexPath);
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(indexContent);
    } catch (fallbackErr) {
      process.stderr.write(
        '[agent-comm] Static index fallback error: ' +
          (fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)) +
          '\n',
      );
      res.writeHead(404);
      res.end('Not found');
    }
  }
}
