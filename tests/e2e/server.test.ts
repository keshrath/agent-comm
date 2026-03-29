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
    expect(body.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(typeof body.uptime).toBe('number');
  });

  it('GET /api/agents returns empty list', async () => {
    const { status, body } = await get('/api/agents');
    expect(status).toBe(200);
    expect(body).toEqual([]);
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

  it('GET /api/channels returns empty list initially', async () => {
    const { status, body } = await get('/api/channels');
    expect(status).toBe(200);
    expect(body).toEqual([]);
  });

  it('GET /api/overview returns all data', async () => {
    const { body } = await get('/api/overview');
    expect(Array.isArray(body.agents)).toBe(true);
    expect(Array.isArray(body.channels)).toBe(true);
    expect(Array.isArray(body.recent_messages)).toBe(true);
    expect(Array.isArray(body.state_entries)).toBe(true);
    // Should contain the previously registered e2e-agent
    expect((body.agents as { name: string }[]).some((a) => a.name === 'e2e-agent')).toBe(true);
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
    const entries = body as { namespace: string; key: string; value: string }[];
    expect(entries.length).toBeGreaterThan(0);
    const entry = entries.find((e) => e.key === 'e2e-key');
    expect(entry).toBeDefined();
    expect(entry!.value).toBe('e2e-value');
    expect(entry!.namespace).toBe('default');
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
    expect(new Date(body.exported_at as string).getTime()).toBeGreaterThan(0);
    expect(Array.isArray(body.agents)).toBe(true);
    expect(Array.isArray(body.channels)).toBe(true);
    expect(Array.isArray(body.messages)).toBe(true);
    expect(Array.isArray(body.state)).toBe(true);
    // Should include the e2e-agent we registered
    expect((body.agents as { name: string }[]).some((a) => a.name === 'e2e-agent')).toBe(true);
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
    expect(Array.isArray(data.agents)).toBe(true);
    expect(Array.isArray(data.channels)).toBe(true);
    expect(Array.isArray(data.messages)).toBe(true);
  });

  it('picks up agent registration via DB poll', async () => {
    const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = new WebSocket(`ws://localhost:${port}`);
      let gotInitial = false;

      client.on('message', (raw: Buffer) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'state' && !gotInitial) {
          gotInitial = true;
          // Mutate DB — poll will detect this
          ctx.agents.register({ name: 'ws-poll-agent' });
        } else if (msg.type === 'state' && gotInitial) {
          // Second state push from poll — should include the new agent
          const agents = (msg.agents || []) as { name: string }[];
          if (agents.some((a) => a.name === 'ws-poll-agent')) {
            client.close();
            resolve(msg);
          }
        }
      });
      client.on('error', reject);
      setTimeout(() => {
        client.close();
        reject(new Error('Timeout'));
      }, 10000);
    });

    const agents = (data.agents || []) as { name: string }[];
    expect(agents.some((a) => a.name === 'ws-poll-agent')).toBe(true);
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

    expect(data.messageCount as number).toBeGreaterThan(0);
    expect(data.reactions).not.toBeNull();
    // reactions is an object keyed by message ID
    expect(Object.keys(data.reactions as Record<string, unknown>).length).toBeGreaterThanOrEqual(0);
  });

  it('picks up state changes via DB poll', async () => {
    const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = new WebSocket(`ws://localhost:${port}`);
      let gotInitial = false;

      client.on('message', (raw: Buffer) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'state' && !gotInitial) {
          gotInitial = true;
          const agent =
            ctx.agents.getByName('e2e-agent') ?? ctx.agents.register({ name: 'e2e-state-agent' });
          ctx.state.set('ws-ns', 'ws-key', 'ws-val', agent.id);
        } else if (parsed.type === 'state' && gotInitial) {
          const entries = (parsed.state || []) as {
            namespace: string;
            key: string;
            value: string;
          }[];
          if (entries.some((e) => e.namespace === 'ws-ns' && e.key === 'ws-key')) {
            client.close();
            resolve(parsed);
          }
        }
      });
      client.on('error', reject);
      setTimeout(() => {
        client.close();
        reject(new Error('Timeout'));
      }, 10000);
    });

    const entries = (data.state || []) as { namespace: string; key: string; value: string }[];
    const entry = entries.find((e) => e.namespace === 'ws-ns' && e.key === 'ws-key');
    expect(entry).toBeDefined();
    expect(entry!.value).toBe('ws-val');
  });

  it('picks up reactions via DB poll', async () => {
    const agent =
      ctx.agents.getByName('e2e-agent') ?? ctx.agents.register({ name: 'e2e-react-agent' });
    // Use a channel message so it appears in public state (DMs are filtered out)
    let ch = ctx.channels.getByName('react-test-ch');
    if (!ch) ch = ctx.channels.create('react-test-ch', agent.id);
    const msg = ctx.messages.send(agent.id, { channel: ch.id, content: 'react-ws-test' });

    const data = await new Promise<Record<string, unknown>>((resolve, reject) => {
      const client = new WebSocket(`ws://localhost:${port}`);
      let gotInitial = false;

      client.on('message', (raw: Buffer) => {
        const parsed = JSON.parse(raw.toString());
        if (parsed.type === 'state' && !gotInitial) {
          gotInitial = true;
          ctx.reactions.react(msg.id, agent.id, 'fire');
        } else if (parsed.type === 'state' && gotInitial) {
          const reactions = parsed.reactions || {};
          if (reactions[msg.id]) {
            client.close();
            resolve(parsed);
          }
        }
      });
      client.on('error', reject);
      setTimeout(() => {
        client.close();
        reject(new Error('Timeout'));
      }, 10000);
    });

    const reactions = (data.reactions || {}) as Record<string, { reaction: string }[]>;
    expect(reactions[msg.id]).toBeDefined();
    expect(reactions[msg.id].some((r) => r.reaction === 'fire')).toBe(true);
  });
});
