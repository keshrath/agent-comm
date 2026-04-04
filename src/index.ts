#!/usr/bin/env node

// =============================================================================
// agent-comm — MCP server entry point (stdio transport)
//
// Communicates via JSON-RPC over stdin/stdout.
// Auto-starts the dashboard HTTP server via leader election.
// =============================================================================

import { createInterface } from 'readline';
import { createContext } from './context.js';
import { readPackageMeta } from './package-meta.js';
import { tools, createToolHandler } from './transport/mcp.js';
import { startDashboard, type DashboardServer } from './server.js';
import { CommError } from './types.js';
import type { JsonRpcRequest, JsonRpcResponse } from './types.js';

const SERVER_INFO = readPackageMeta();
const CAPABILITIES = { tools: {} };
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

function writeJsonRpcResponse(response: JsonRpcResponse): void {
  process.stdout.write(JSON.stringify(response) + '\n');
}

function handleRequest(request: JsonRpcRequest): JsonRpcResponse | null {
  const { method, params, id } = request;

  switch (method) {
    case 'initialize':
      tryStartDashboard();
      return {
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: '2024-11-05',
          serverInfo: SERVER_INFO,
          capabilities: CAPABILITIES,
        },
      };

    case 'notifications/initialized':
      return null;

    case 'tools/list':
      return { jsonrpc: '2.0', id, result: { tools } };

    case 'tools/call': {
      const toolName = String(params?.name ?? '');
      const rawArgs = params?.arguments;
      const toolArgs: Record<string, unknown> =
        typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs)
          ? (rawArgs as Record<string, unknown>)
          : {};
      try {
        const result = handleTool(toolName, toolArgs);
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
          },
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const code = err instanceof CommError ? err.code : 'UNKNOWN_ERROR';
        return {
          jsonrpc: '2.0',
          id,
          result: {
            content: [{ type: 'text', text: `Error [${code}]: ${message}` }],
            isError: true,
          },
        };
      }
    }

    case 'ping':
      return { jsonrpc: '2.0', id, result: {} };

    default:
      return {
        jsonrpc: '2.0',
        id,
        error: { code: -32601, message: `Method not found: ${method}` },
      };
  }
}

const stdioReadline = createInterface({ input: process.stdin, terminal: false });

stdioReadline.on('line', (line: string) => {
  if (!line.trim()) return;
  try {
    const request = JSON.parse(line) as JsonRpcRequest;
    const response = handleRequest(request);
    if (response) writeJsonRpcResponse(response);
  } catch (err) {
    process.stderr.write(
      '[agent-comm] JSON-RPC parse error: ' +
        (err instanceof Error ? err.message : String(err)) +
        '\n',
    );
    writeJsonRpcResponse({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }
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
