#!/usr/bin/env node

// =============================================================================
// agent-comm — MCP server entry point (stdio transport)
//
// Communicates via JSON-RPC over stdin/stdout via agent-common's startMcpServer.
// Auto-starts the dashboard HTTP server via leader election on initialize.
// =============================================================================

import { startMcpServer } from 'agent-common';
import { createContext } from './context.js';
import { readPackageMeta } from './package-meta.js';
import { tools, createToolHandler } from './transport/mcp.js';
import { startDashboard, type DashboardServer } from './server.js';

const SERVER_INFO = readPackageMeta();
const DASHBOARD_PORT = parseInt(process.env.AGENT_COMM_PORT ?? '3421', 10);

const appContext = createContext();
const handleTool = createToolHandler(appContext);

let dashboard: DashboardServer | null = null;
let dashboardAttempted = false;

function tryStartDashboard(): void {
  if (dashboard || dashboardAttempted) return;
  dashboardAttempted = true;
  startDashboard(appContext, DASHBOARD_PORT)
    .then((dashboardServer) => {
      dashboard = dashboardServer;
    })
    .catch(() => {
      process.stderr.write(
        `[agent-comm] Dashboard port ${DASHBOARD_PORT} in use — another instance is serving.\n`,
      );
    });
}

startMcpServer({
  serverInfo: SERVER_INFO,
  tools,
  handleTool,
  onInitialize: tryStartDashboard,
});

function cleanup(): void {
  if (dashboard) {
    dashboard.close();
    dashboard = null;
  }
  appContext.close();
}

process.on('SIGINT', () => {
  cleanup();
  process.exit(0);
});
process.on('SIGTERM', () => {
  cleanup();
  process.exit(0);
});
process.on('exit', cleanup);
