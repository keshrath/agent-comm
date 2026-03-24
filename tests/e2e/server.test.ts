import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { createServer, type Server } from 'http';
import { WebSocket } from 'ws';
import { createContext, type AppContext } from '../../src/context.js';
import { createRouter } from '../../src/transport/rest.js';
import { setupWebSocket } from '../../src/transport/ws.js';

let ctx: AppContext;
let httpServer: Server;
let wss: ReturnType<typeof setupWebSocket>;
let baseUrl: string;
let port: number;

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

beforeAll(
  () =>
    new Promise<void>((resolve) => {
      ctx = createContext({ path: ':memory:' });
      const router = createRouter(ctx);
      httpServer = createServer(router);
      wss = setupWebSocket(httpServer, ctx);
      httpServer.listen(0, () => {
        const addr = httpServer.address();
        if (typeof addr === 'object' && addr) {
          port = addr.port;
          baseUrl = `http://localhost:${port}`;
        }
        resolve();
      });
    }),
);

afterAll(() => {
  wss.close();
  httpServer.close();
  ctx.close();
});

describe('REST API E2E', () => {
  it('GET /health returns ok', async () => {
    const { status, body } = await get('/health');
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('1.0.0');
    expect(typeof body.uptime).toBe('number');
  });

  it('GET /api/agents returns empty list', async () => {
    const { status, body } = await get('/api/agents');
    expect(status).toBe(200);
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(0);
  });

  it('GET /api/agents returns agents after registration', async () => {
    ctx.agents.register({ name: 'e2e-agent', capabilities: ['testing'] });

    const { status, body } = await get('/api/agents');
    expect(status).toBe(200);
    expect(body).toHaveLength(1);
    expect((body as Record<string, unknown>[])[0].name).toBe('e2e-agent');
  });

  it('GET /api/agents/:name resolves by name', async () => {
    const { status, body } = await get('/api/agents/e2e-agent');
    expect(status).toBe(200);
    expect(body.name).toBe('e2e-agent');
    expect(body.capabilities).toEqual(['testing']);
  });

  it('GET /api/agents/:id returns 404 for unknown', async () => {
    const { status } = await get('/api/agents/nonexistent');
    expect(status).toBe(404);
  });

  it('GET /api/channels returns empty list', async () => {
    const { body } = await get('/api/channels');
    expect(Array.isArray(body)).toBe(true);
  });

  it('GET /api/overview returns all data', async () => {
    const { body } = await get('/api/overview');
    expect(body).toHaveProperty('agents');
    expect(body).toHaveProperty('channels');
    expect(body).toHaveProperty('recentMessages');
    expect(body).toHaveProperty('stateEntries');
  });

  it('GET /api/search returns 400 without query', async () => {
    const { status, body } = await get('/api/search');
    expect(status).toBe(400);
    expect(body.error).toContain('Missing');
  });

  it('GET /api/state returns state entries', async () => {
    const agent = ctx.agents.getByName('e2e-agent')!;
    ctx.state.set('default', 'e2e-key', 'e2e-value', agent.id);

    const { body } = await get('/api/state');
    expect(Array.isArray(body)).toBe(true);
    expect((body as Record<string, unknown>[]).length).toBeGreaterThan(0);
  });

  it('GET /api/state/:namespace/:key returns specific entry', async () => {
    const { body } = await get('/api/state/default/e2e-key');
    expect(body.value).toBe('e2e-value');
  });

  it('GET /api/state/:namespace/:key returns 404 for missing', async () => {
    const { status } = await get('/api/state/default/nonexistent');
    expect(status).toBe(404);
  });

  it('GET /api/export returns full database dump', async () => {
    const { status, body } = await get('/api/export');
    expect(status).toBe(200);
    expect(body).toHaveProperty('exported_at');
    expect(body).toHaveProperty('agents');
    expect(body).toHaveProperty('channels');
    expect(body).toHaveProperty('messages');
    expect(body).toHaveProperty('state');
    expect(Array.isArray(body.agents)).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
  });

  it('POST with invalid JSON returns 422 not 500', async () => {
    const result = await new Promise<{ status: number; body: Record<string, unknown> }>(
      (resolve, reject) => {
        import('http').then(({ default: http }) => {
          const req = http.request(
            new URL('/api/messages', baseUrl),
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
          req.write('not json at all');
          req.end();
        });
      },
    );
    expect(result.status).toBe(422);
    expect(result.body.error).toContain('Invalid JSON');
  });

  it('GET unknown API returns 404', async () => {
    const { status } = await get('/api/nonexistent');
    expect(status).toBe(404);
  });

  it('serves static UI at /', async () => {
    const url = new URL('/', baseUrl);
    const res = await new Promise<{ status: number; contentType: string }>((resolve) => {
      import('http').then(({ default: http }) => {
        http.get(url, (r) => {
          r.resume();
          resolve({
            status: r.statusCode!,
            contentType: r.headers['content-type'] || '',
          });
        });
      });
    });
    expect(res.status).toBe(200);
    expect(res.contentType).toContain('text/html');
  });
});

describe('WebSocket E2E', () => {
  it('receives full state on connect', async () => {
    const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = new WebSocket(`ws://localhost:${port}`);
      client.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'state') {
          client.close();
          resolve(msg);
        }
      });
      client.on('error', reject);
      setTimeout(() => {
        client.close();
        reject(new Error('Timeout'));
      }, 5000);
    });

    expect(data.type).toBe('state');
    expect(data).toHaveProperty('agents');
    expect(data).toHaveProperty('channels');
    expect(data).toHaveProperty('messages');
  });

  it('receives event on agent registration', async () => {
    const events = await new Promise<Record<string, unknown>[]>((resolve, reject) => {
      const collected: Record<string, unknown>[] = [];
      const client = new WebSocket(`ws://localhost:${port}`);
      let gotState = false;

      client.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'state' && !gotState) {
          gotState = true;
          ctx.agents.register({ name: 'ws-test-agent' });
        } else if (msg.type === 'agent:registered') {
          collected.push(msg);
          client.close();
          resolve(collected);
        }
      });
      client.on('error', reject);
      setTimeout(() => {
        client.close();
        resolve(collected);
      }, 5000);
    });

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].type).toBe('agent:registered');
  });

  it('responds to refresh request', async () => {
    const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = new WebSocket(`ws://localhost:${port}`);
      let firstState = true;

      client.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'state') {
          if (firstState) {
            firstState = false;
            client.send(JSON.stringify({ type: 'refresh' }));
          } else {
            client.close();
            resolve(msg);
          }
        }
      });
      client.on('error', reject);
      setTimeout(() => {
        client.close();
        reject(new Error('Timeout'));
      }, 5000);
    });

    expect(data.type).toBe('state');
  });

  it('full state includes messageCount and reactions', async () => {
    const agent =
      ctx.agents.getByName('e2e-agent') ?? ctx.agents.register({ name: 'e2e-ws-agent' });
    const msg = ctx.messages.send(agent.id, { to: agent.id, content: 'ws-count-test' });
    ctx.reactions.react(msg.id, agent.id, 'check');

    const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = new WebSocket(`ws://localhost:${port}`);
      client.on('message', (raw: Buffer) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'state') {
          client.close();
          resolve(parsed);
        }
      });
      client.on('error', reject);
      setTimeout(() => {
        client.close();
        reject(new Error('Timeout'));
      }, 5000);
    });

    expect(data).toHaveProperty('messageCount');
    expect(typeof data.messageCount).toBe('number');
    expect(data.messageCount as number).toBeGreaterThan(0);
    expect(data).toHaveProperty('reactions');
  });

  it('pushes state:changed event with value and updated_by', async () => {
    const event = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = new WebSocket(`ws://localhost:${port}`);
      let gotState = false;

      client.on('message', (raw: Buffer) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'state' && !gotState) {
          gotState = true;
          const agent =
            ctx.agents.getByName('e2e-agent') ?? ctx.agents.register({ name: 'e2e-state-agent' });
          ctx.state.set('ws-ns', 'ws-key', 'ws-val', agent.id);
        } else if (parsed.type === 'state:changed') {
          client.close();
          resolve(parsed);
        }
      });
      client.on('error', reject);
      setTimeout(() => {
        client.close();
        reject(new Error('Timeout'));
      }, 5000);
    });

    expect(event.type).toBe('state:changed');
    const data = (event as { data: Record<string, unknown> }).data;
    expect(data.namespace).toBe('ws-ns');
    expect(data.key).toBe('ws-key');
    expect(data.value).toBe('ws-val');
    expect(data.updated_by).toBeDefined();
  });

  it('pushes message:reacted event', async () => {
    const agent =
      ctx.agents.getByName('e2e-agent') ?? ctx.agents.register({ name: 'e2e-react-agent' });
    const msg = ctx.messages.send(agent.id, { to: agent.id, content: 'react-ws-test' });

    const event = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = new WebSocket(`ws://localhost:${port}`);
      let gotState = false;

      client.on('message', (raw: Buffer) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'state' && !gotState) {
          gotState = true;
          ctx.reactions.react(msg.id, agent.id, 'fire');
        } else if (parsed.type === 'message:reacted') {
          client.close();
          resolve(parsed);
        }
      });
      client.on('error', reject);
      setTimeout(() => {
        client.close();
        reject(new Error('Timeout'));
      }, 5000);
    });

    expect(event.type).toBe('message:reacted');
    const data = (event as { data: Record<string, unknown> }).data;
    expect(data.reaction).toBe('fire');
  });
});
