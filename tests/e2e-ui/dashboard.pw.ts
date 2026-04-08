// =============================================================================
// agent-comm — Playwright E2E dashboard test
//
// Boots the standalone HTTP+WS server against a temp SQLite DB on a free port,
// drives the dashboard with chromium, and verifies the main tabs render and
// switch correctly. Tears the server + DB down cleanly.
// =============================================================================

import { test, expect, type ConsoleMessage } from '@playwright/test';
import { createContext, type AppContext } from '../../dist/context.js';
import { startDashboard, type DashboardServer } from '../../dist/server.js';
import { mkdtempSync, mkdirSync, rmSync } from 'fs';
import { tmpdir, homedir } from 'os';
import { join } from 'path';
import { createServer } from 'net';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, () => {
      const addr = srv.address();
      if (addr && typeof addr === 'object') {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close();
        reject(new Error('no port'));
      }
    });
  });
}

let tempDir: string;
let dbPath: string;
let ctx: AppContext;
let dashboard: DashboardServer;
let baseUrl: string;

test.beforeAll(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'agent-comm-e2e-'));
  dbPath = join(tempDir, 'test.db');
  ctx = createContext({ path: dbPath });

  // Seed an agent + a channel so views aren't empty. Skip messages — channel
  // membership is enforced by FK and not relevant to the dashboard render test.
  const agent = ctx.agents.register({ name: 'e2e-seed-agent' });
  ctx.channels.create('general', agent.id);

  const port = await freePort();
  dashboard = await startDashboard(ctx, port);
  baseUrl = `http://localhost:${dashboard.port}`;
});

test.afterAll(async () => {
  try {
    dashboard?.close();
  } catch {
    /* ignore */
  }
  try {
    ctx?.close();
  } catch {
    /* ignore */
  }
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

test.describe('agent-comm dashboard', () => {
  test('loads with no console errors and connects via websocket', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg: ConsoleMessage) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    const pageErrors: string[] = [];
    page.on('pageerror', (err) => pageErrors.push(err.message));

    let wsConnected = false;
    page.on('websocket', (ws) => {
      wsConnected = true;
      void ws;
    });

    await page.goto(baseUrl + '/');
    await expect(page).toHaveTitle(/agent-comm/i);

    // Wait for the WS handshake to fire (the UI opens it on load).
    await page.waitForTimeout(500);
    expect(wsConnected).toBe(true);

    expect(consoleErrors).toEqual([]);
    expect(pageErrors).toEqual([]);

    const screenshotDir = join(homedir(), '.claude', 'tmp');
    mkdirSync(screenshotDir, { recursive: true });
    await page.screenshot({
      path: join(screenshotDir, 'e2e-agent-comm.png'),
      fullPage: true,
    });
  });

  test('all main tabs render their views when clicked', async ({ page }) => {
    await page.goto(baseUrl + '/');

    const tabs: { tab: string; view: string }[] = [
      { tab: '#tab-overview', view: '#view-overview' },
      { tab: '#tab-agents', view: '#view-agents' },
      { tab: '#tab-messages', view: '#view-messages' },
      { tab: '#tab-channels', view: '#view-channels' },
      { tab: '#tab-state', view: '#view-state' },
      { tab: '#tab-feed', view: '#view-feed' },
    ];

    for (const { tab, view } of tabs) {
      await expect(page.locator(tab)).toBeVisible();
      await page.click(tab);
      await expect(page.locator(view)).toBeVisible();
    }
  });

  test('REST /health responds with version info', async ({ request }) => {
    const res = await request.get(baseUrl + '/health');
    expect(res.ok()).toBe(true);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toHaveProperty('version');
  });
});
