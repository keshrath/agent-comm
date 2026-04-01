// =============================================================================
// REST API error case tests — 400, 404, 409 coverage
// =============================================================================

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { createContext, type AppContext } from '../../src/context.js';
import { createRouter } from '../../src/transport/rest.js';

let ctx: AppContext;
let httpServer: Server;
let baseUrl: string;

function get(path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    import('http').then(({ default: http }) => {
      http.get(url, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          resolve({ status: res.statusCode!, body });
        });
        res.on('error', reject);
      });
    });
  });
}

function post(
  path: string,
  body: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    import('http').then(({ default: http }) => {
      const data = JSON.stringify(body);
      const req = http.request(
        new URL(path, baseUrl),
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(data),
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer) => chunks.push(chunk));
          res.on('end', () => {
            resolve({
              status: res.statusCode!,
              body: JSON.parse(Buffer.concat(chunks).toString()),
            });
          });
        },
      );
      req.on('error', reject);
      req.write(data);
      req.end();
    });
  });
}

function del(
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    import('http').then(({ default: http }) => {
      const data = body ? JSON.stringify(body) : '';
      const headers: Record<string, string | number> = {};
      if (body) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(data);
      }
      const req = http.request(new URL(path, baseUrl), { method: 'DELETE', headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode!,
            body: JSON.parse(Buffer.concat(chunks).toString()),
          });
        });
      });
      req.on('error', reject);
      if (data) req.write(data);
      req.end();
    });
  });
}

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      ctx = createContext({ path: ':memory:' });
      const router = createRouter(ctx);
      httpServer = createServer(router);
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        if (typeof addr === 'object' && addr) {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    }),
);

afterAll(() => {
  httpServer.close();
  ctx.close();
});

describe('REST API error cases', () => {
  // -------------------------------------------------------------------------
  // Agent endpoints
  // -------------------------------------------------------------------------

  describe('GET /api/agents/:id', () => {
    it('returns 404 for non-existent agent', async () => {
      const { status, body } = await get('/api/agents/no-such-agent');
      expect(status).toBe(404);
      expect(body.error).toContain('Not found');
    });

    it('returns 404 for random UUID', async () => {
      const { status } = await get('/api/agents/00000000-0000-0000-0000-000000000000');
      expect(status).toBe(404);
    });
  });

  describe('GET /api/agents/:id/heartbeat', () => {
    it('returns 404 for non-existent agent', async () => {
      const { status, body } = await get('/api/agents/ghost/heartbeat');
      expect(status).toBe(404);
      expect(body.error).toContain('Not found');
    });
  });

  // -------------------------------------------------------------------------
  // Channel endpoints
  // -------------------------------------------------------------------------

  describe('GET /api/channels/:name', () => {
    it('returns 404 for non-existent channel', async () => {
      const { status, body } = await get('/api/channels/nonexistent');
      expect(status).toBe(404);
      expect(body.error).toContain('Not found');
    });
  });

  describe('GET /api/channels/:name/members', () => {
    it('returns 404 for non-existent channel', async () => {
      const { status, body } = await get('/api/channels/ghost-channel/members');
      expect(status).toBe(404);
      expect(body.error).toContain('Not found');
    });
  });

  describe('GET /api/channels/:name/messages', () => {
    it('returns 404 for non-existent channel', async () => {
      const { status, body } = await get('/api/channels/nowhere/messages');
      expect(status).toBe(404);
      expect(body.error).toContain('Not found');
    });
  });

  // -------------------------------------------------------------------------
  // Message endpoints
  // -------------------------------------------------------------------------

  describe('POST /api/messages', () => {
    it('returns 400 when "from" is missing', async () => {
      const { status, body } = await post('/api/messages', { content: 'hello' });
      expect(status).toBe(400);
      expect(body.error).toContain('"from"');
    });

    it('returns 400 when "from" is not a string', async () => {
      const { status, body } = await post('/api/messages', { from: 123, content: 'hello' });
      expect(status).toBe(400);
      expect(body.error).toContain('"from"');
    });

    it('returns 404 when sender agent does not exist', async () => {
      const { status, body } = await post('/api/messages', {
        from: 'ghost-agent',
        content: 'hello',
      });
      expect(status).toBe(404);
      expect(body.error).toContain('Agent not found');
    });

    it('returns 403 when sender is offline', async () => {
      const agent = ctx.agents.register({ name: 'rest-offline-agent' });
      ctx.agents.unregister(agent.id);

      const { status, body } = await post('/api/messages', {
        from: 'rest-offline-agent',
        content: 'hello',
      });
      expect(status).toBe(403);
      expect(body.error).toContain('offline');
    });

    it('returns 400 when "content" is missing', async () => {
      ctx.agents.register({ name: 'rest-sender' });
      const { status, body } = await post('/api/messages', { from: 'rest-sender' });
      expect(status).toBe(400);
      expect(body.error).toContain('"content"');
    });

    it('returns 404 when "to" agent does not exist', async () => {
      const { status, body } = await post('/api/messages', {
        from: 'rest-sender',
        to: 'nobody',
        content: 'hello',
      });
      expect(status).toBe(404);
      expect(body.error).toContain('Agent not found');
    });

    it('returns 404 when channel does not exist', async () => {
      const { status, body } = await post('/api/messages', {
        from: 'rest-sender',
        channel: 'no-channel',
        content: 'hello',
      });
      expect(status).toBe(404);
      expect(body.error).toContain('Channel not found');
    });

    it('returns 400 when thread_id is not a number', async () => {
      const { status, body } = await post('/api/messages', {
        from: 'rest-sender',
        content: 'hello',
        thread_id: 'bad',
      });
      expect(status).toBe(400);
      expect(body.error).toContain('thread_id');
    });

    it('returns 400 when importance is invalid', async () => {
      const { status, body } = await post('/api/messages', {
        from: 'rest-sender',
        content: 'hello',
        importance: 'critical',
      });
      expect(status).toBe(400);
      expect(body.error).toContain('importance');
    });
  });

  describe('POST /api/agents/:id/messages', () => {
    it('returns 404 when agent does not exist', async () => {
      const { status, body } = await post('/api/agents/nonexistent/messages', {
        content: 'hello',
      });
      expect(status).toBe(404);
      expect(body.error).toContain('Agent not found');
    });

    it('returns 400 when content is missing', async () => {
      const agent = ctx.agents.register({ name: 'rest-path-sender' });
      const { status, body } = await post(`/api/agents/${agent.id}/messages`, { to: 'someone' });
      expect(status).toBe(400);
      expect(body.error).toContain('"content"');
    });

    it('sends a message successfully', async () => {
      const target = ctx.agents.register({ name: 'rest-path-target' });
      const sender = ctx.agents.getByName('rest-path-sender')!;
      const { status, body } = await post(`/api/agents/${sender.id}/messages`, {
        to: target.name,
        content: 'hello via path',
      });
      expect(status).toBe(201);
      expect(body.content).toBe('hello via path');
    });
  });

  describe('GET /api/messages/:id/thread', () => {
    it('returns 400 for non-numeric message ID', async () => {
      const { status, body } = await get('/api/messages/abc/thread');
      expect(status).toBe(400);
      expect(body.error).toContain('Invalid message ID');
    });
  });

  describe('DELETE /api/messages/:id', () => {
    it('returns 400 for non-numeric message ID', async () => {
      const { status, body } = await del('/api/messages/abc', { agent_id: 'x' });
      expect(status).toBe(400);
      expect(body.error).toContain('Invalid message ID');
    });

    it('returns 400 when agent_id is missing', async () => {
      const { status, body } = await del('/api/messages/1', {});
      expect(status).toBe(400);
      expect(body.error).toContain('agent_id');
    });
  });

  // -------------------------------------------------------------------------
  // Search endpoint
  // -------------------------------------------------------------------------

  describe('GET /api/search', () => {
    it('returns 400 without query parameter', async () => {
      const { status, body } = await get('/api/search');
      expect(status).toBe(400);
      expect(body.error).toContain('Missing');
    });

    it('returns 400 for excessively long query', async () => {
      const longQuery = 'a'.repeat(1001);
      const { status, body } = await get(`/api/search?q=${longQuery}`);
      expect(status).toBe(400);
      expect(body.error).toContain('too long');
    });
  });

  // -------------------------------------------------------------------------
  // State endpoints
  // -------------------------------------------------------------------------

  describe('GET /api/state/:namespace/:key', () => {
    it('returns 404 for non-existent state entry', async () => {
      const { status, body } = await get('/api/state/missing/key');
      expect(status).toBe(404);
      expect(body.error).toContain('Not found');
    });
  });

  describe('POST /api/state/:namespace/:key', () => {
    it('returns 400 when value is missing', async () => {
      const { status, body } = await post('/api/state/ns/key', { updated_by: 'agent1' });
      expect(status).toBe(400);
      expect(body.error).toContain('"value"');
    });

    it('returns 400 when updated_by is missing', async () => {
      const { status, body } = await post('/api/state/ns/key', { value: 'val' });
      expect(status).toBe(400);
      expect(body.error).toContain('updated_by');
    });
  });

  describe('DELETE /api/state/:namespace/:key', () => {
    it('returns 404 for non-existent state entry', async () => {
      const { status, body } = await del('/api/state/missing/key');
      expect(status).toBe(404);
      expect(body.error).toContain('Not found');
    });
  });

  // -------------------------------------------------------------------------
  // Branches
  // -------------------------------------------------------------------------

  describe('GET /api/branches/:id', () => {
    it('returns 400 for non-numeric branch ID', async () => {
      const { status, body } = await get('/api/branches/abc');
      expect(status).toBe(400);
      expect(body.error).toContain('Invalid branch ID');
    });

    it('returns 404 for non-existent branch', async () => {
      const { status, body } = await get('/api/branches/99999');
      expect(status).toBe(404);
      expect(body.error).toContain('Not found');
    });
  });

  describe('GET /api/branches/:id/messages', () => {
    it('returns 400 for non-numeric branch ID', async () => {
      const { status, body } = await get('/api/branches/abc/messages');
      expect(status).toBe(400);
      expect(body.error).toContain('Invalid branch ID');
    });
  });

  // -------------------------------------------------------------------------
  // Unknown API paths
  // -------------------------------------------------------------------------

  describe('unknown routes', () => {
    it('returns 404 for unknown API path', async () => {
      const { status, body } = await get('/api/does-not-exist');
      expect(status).toBe(404);
      expect(body.error).toContain('Not found');
    });
  });

  // -------------------------------------------------------------------------
  // Invalid JSON
  // -------------------------------------------------------------------------

  describe('invalid JSON body', () => {
    it('returns 422 for malformed JSON', async () => {
      const result = await new Promise<{ status: number; body: Record<string, unknown> }>(
        (resolve, reject) => {
          import('http').then(({ default: http }) => {
            const req = http.request(
              new URL('/api/state/ns/key', baseUrl),
              { method: 'POST', headers: { 'Content-Type': 'application/json' } },
              (res) => {
                const chunks: Buffer[] = [];
                res.on('data', (chunk: Buffer) => chunks.push(chunk));
                res.on('end', () => {
                  resolve({
                    status: res.statusCode!,
                    body: JSON.parse(Buffer.concat(chunks).toString()),
                  });
                });
              },
            );
            req.on('error', reject);
            req.write('not json');
            req.end();
          });
        },
      );
      expect(result.status).toBe(422);
      expect(result.body.error).toContain('Invalid JSON');
    });

    it('returns 422 for array body', async () => {
      const result = await post('/api/state/ns/key', [1, 2, 3]);
      expect(result.status).toBe(422);
    });
  });
});
