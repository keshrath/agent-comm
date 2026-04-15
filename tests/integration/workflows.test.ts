// =============================================================================
// Integration tests — multi-agent workflow scenarios
//
// Each test simulates a realistic multi-agent coordination pattern using
// the MCP tool handler layer (same interface agents actually use).
// =============================================================================

import type { AppContext } from '../../src/context.js';
import { createTestContext } from '../helpers.js';
import { createToolHandler, type ToolHandler } from '../../src/transport/mcp.js';

let ctx: AppContext;

beforeEach(() => {
  ctx = createTestContext();
});

afterEach(() => {
  ctx.close();
});

function agent(name: string, capabilities?: string[]): ToolHandler {
  const h = createToolHandler(ctx);
  h('comm_register', { name, capabilities });
  return h;
}

// ---------------------------------------------------------------------------
// Multi-agent coordination
// ---------------------------------------------------------------------------

describe('Multi-agent channel workflow', () => {
  it('three agents coordinate via channel with threading', () => {
    const lead = agent('lead', ['planning']);
    const dev = agent('dev', ['code']);
    const qa = agent('qa', ['testing']);

    lead('comm_channel', {
      action: 'create',
      channel: 'sprint',
      description: 'Sprint coordination',
    });
    dev('comm_channel', { action: 'join', channel: 'sprint' });
    qa('comm_channel', { action: 'join', channel: 'sprint' });

    const task = lead('comm_send', {
      channel: 'sprint',
      content: 'Implement auth module. Dev: build it. QA: write tests.',
      importance: 'high',
    }) as { id: number };

    const devReply = dev('comm_send', {
      reply_to: task.id,
      content: 'On it — starting with the JWT middleware.',
    }) as { id: number; thread_id: number };
    expect(devReply.thread_id).toBe(task.id);

    qa('comm_send', {
      reply_to: task.id,
      content: 'Will prepare test fixtures while dev builds.',
    });

    const thread = lead('comm_inbox', { thread_id: task.id }) as unknown[];
    expect(thread).toHaveLength(3);
  });
});

describe('Agent discovery and direct messaging', () => {
  it('finds agents by capability and sends targeted messages', () => {
    const coordinator = agent('coordinator');
    const feHandler = agent('fe-dev', ['react', 'typescript']);
    agent('be-dev', ['python', 'django']);
    agent('devops', ['docker', 'k8s']);

    const tsDevs = coordinator('comm_agents', {
      action: 'list',
      capability: 'typescript',
    }) as { name: string }[];
    expect(tsDevs).toHaveLength(1);
    expect(tsDevs[0].name).toBe('fe-dev');

    coordinator('comm_send', {
      to: 'fe-dev',
      content: 'Need a React component for the dashboard.',
      importance: 'high',
      ack_required: true,
    });

    const inbox = feHandler('comm_inbox', { unread_only: true }) as {
      id: number;
      ack_required: boolean;
    }[];
    expect(inbox).toHaveLength(1);
    expect(inbox[0].ack_required).toBe(true);

    // ack feature removed — agents just read messages via inbox
  });
});

describe('Status text coordination', () => {
  it('agents set status to signal work phase', () => {
    const a1 = agent('builder');
    const a2 = agent('reviewer');

    a1('comm_agents', { action: 'status', status_text: 'implementing auth module' });
    a2('comm_agents', { action: 'status', status_text: 'waiting for PR' });

    const agents = a1('comm_agents', { action: 'list' }) as {
      name: string;
      status_text: string | null;
    }[];
    const builder = agents.find((a) => a.name === 'builder');
    const reviewer = agents.find((a) => a.name === 'reviewer');
    expect(builder?.status_text).toBe('implementing auth module');
    expect(reviewer?.status_text).toBe('waiting for PR');

    a1('comm_agents', { action: 'status', status_text: 'PR ready for review' });
    a2('comm_agents', { action: 'status', status_text: 'reviewing PR #42' });

    const updated = a1('comm_agents', { action: 'list' }) as {
      name: string;
      status_text: string | null;
    }[];
    expect(updated.find((a) => a.name === 'builder')?.status_text).toBe('PR ready for review');
    expect(updated.find((a) => a.name === 'reviewer')?.status_text).toBe('reviewing PR #42');
  });
});

describe('Shared state with CAS for distributed locking', () => {
  it('two agents contend for a lock via compare-and-swap', () => {
    const a1 = agent('deployer-1');
    const a2 = agent('deployer-2');

    const win = a1('comm_state', {
      action: 'cas',
      key: 'deploy-lock',
      expected: null,
      new_value: 'deployer-1',
    }) as { swapped: boolean };
    expect(win.swapped).toBe(true);

    const lose = a2('comm_state', {
      action: 'cas',
      key: 'deploy-lock',
      expected: null,
      new_value: 'deployer-2',
    }) as { swapped: boolean };
    expect(lose.swapped).toBe(false);

    const holder = a2('comm_state', { action: 'get', key: 'deploy-lock' }) as { value: string };
    expect(holder.value).toBe('deployer-1');

    a1('comm_state', { action: 'delete', key: 'deploy-lock' });

    const grab = a2('comm_state', {
      action: 'cas',
      key: 'deploy-lock',
      expected: null,
      new_value: 'deployer-2',
    }) as { swapped: boolean };
    expect(grab.swapped).toBe(true);
  });
});

describe('Message forwarding across channels', () => {
  it('forwards a channel message to a DM with comment', () => {
    const alice = agent('alice');
    const bob = agent('bob');
    const charlie = agent('charlie');

    alice('comm_channel', { action: 'create', channel: 'announcements' });
    bob('comm_channel', { action: 'join', channel: 'announcements' });

    const announcement = alice('comm_send', {
      channel: 'announcements',
      content: 'Release v2.0 is scheduled for Friday.',
      importance: 'high',
    }) as { id: number };

    bob('comm_send', {
      forward: announcement.id,
      to: 'charlie',
      content: 'forwarded',
      comment: 'FYI — you should prepare the deploy script.',
    });

    const inbox = charlie('comm_inbox', {}) as { content: string }[];
    expect(inbox).toHaveLength(1);
    expect(inbox[0].content).toContain('Forwarded from alice');
    expect(inbox[0].content).toContain('Release v2.0');
    expect(inbox[0].content).toContain('prepare the deploy script');
  });
});

describe('Channel lifecycle with description updates', () => {
  it('create, update description, archive, re-create', () => {
    const admin = agent('ch-admin');
    agent('member');

    const ch = admin('comm_channel', {
      action: 'create',
      channel: 'temp-project',
      description: 'Q1 project',
    }) as { id: string; description: string };
    expect(ch.description).toBe('Q1 project');

    const updated = admin('comm_channel', {
      action: 'update',
      channel: 'temp-project',
      description: 'Q1 project — extended to Q2',
    }) as { description: string };
    expect(updated.description).toBe('Q1 project — extended to Q2');

    admin('comm_channel', { action: 'archive', channel: 'temp-project' });

    const channels = admin('comm_channel', { action: 'list', include_archived: true }) as {
      name: string;
      archived_at: string | null;
    }[];
    const archived = channels.find((c) => c.name === 'temp-project');
    expect(archived?.archived_at).not.toBeNull();
  });
});

describe('Search across agents and channels', () => {
  // comm_search is no longer exposed via MCP — the FTS5 backend remains
  // accessible via REST (/api/messages/search) and MessageService.search()
  // for the dashboard's human-facing search bar. This test exercises the
  // underlying MessageService directly to confirm the primitive still works.
  it('full-text search via MessageService finds messages from multiple sources', () => {
    const a1 = agent('arch');
    const a2 = agent('impl');

    a1('comm_channel', { action: 'create', channel: 'design' });
    a2('comm_channel', { action: 'join', channel: 'design' });

    a1('comm_send', {
      channel: 'design',
      content: 'The authentication module should use JWT tokens with RS256 signing.',
    });
    a2('comm_send', {
      channel: 'design',
      content: 'I will implement the JWT verification middleware in Express.',
    });
    a1('comm_send', {
      to: 'impl',
      content: 'Make sure the JWT secret rotation is handled properly.',
    });

    const results = ctx.messages.search('JWT');
    expect(results.length).toBe(3);
  });
});

describe('Rate limiting does not block different agents', () => {
  it('agent A hitting limit does not affect agent B', () => {
    const spammer = agent('spammer');
    const normal = agent('normal-user');
    agent('target');

    for (let i = 0; i < 10; i++) {
      spammer('comm_send', { to: 'target', content: `spam ${i}` });
    }
    expect(() => spammer('comm_send', { to: 'target', content: 'overflow' })).toThrow('Rate limit');

    expect(() =>
      normal('comm_send', { to: 'target', content: 'this should work fine' }),
    ).not.toThrow();
  });
});

describe('Offline agent re-registration', () => {
  it('agent can re-register after going offline and retains status_text', () => {
    const h = createToolHandler(ctx);
    h('comm_register', { name: 'transient' });
    h('comm_agents', { action: 'status', status_text: 'working' });
    h('comm_agents', { action: 'unregister' });

    const h2 = createToolHandler(ctx);
    const result = h2('comm_register', { name: 'transient' }) as {
      status: string;
      status_text: string | null;
    };
    expect(result.status).toBe('online');
    expect(result.status_text).toBe('working');
  });
});
