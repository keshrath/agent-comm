# Contributing to agent-comm

## Getting Started

1. Clone the repository:
   ```bash
   git clone https://github.com/keshrath/agent-comm.git
   cd agent-comm
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Build:
   ```bash
   npm run build
   ```

## Development Setup

### Prerequisites

- **Node.js >= 20** (LTS recommended)
- **npm >= 10**
- **Git**

### Development Mode

```bash
# Watch mode — recompiles TypeScript + restarts server on changes
npm run dev

# Watch mode (MCP only, no dashboard server)
npm run dev:mcp

# Start dashboard standalone (port 3421)
npm run start:server

# Run tests
npm test
npm run test:watch
npm run test:e2e
```

### Environment

The dashboard auto-starts on port 3421 when the MCP server launches.

## Project Structure

```
agent-comm/
  src/
    index.ts              Entry point (MCP stdio + dashboard auto-start)
    context.ts            DI root — wires all services (no global state)
    server.ts             HTTP + WebSocket standalone server
    types.ts              Shared types
    domain/
      agents.ts           Agent registration, heartbeat, presence
      channels.ts         Channel creation, join/leave, membership
      messages.ts         Direct + channel messaging, threading, forwarding
      state.ts            Shared key-value state with CAS support
      reactions.ts        Message reactions
      cleanup.ts          Stale agent/message cleanup
      rate-limit.ts       Per-agent rate limiting
      events.ts           In-process event bus
    storage/
      database.ts         SQLite (WAL mode, schema versioning V2, FK cascades)
    transport/
      mcp.ts              33 MCP tool definitions + dispatch
      rest.ts             REST API endpoints + static file serving
      ws.ts               WebSocket event streaming
    ui/
      index.html          Dashboard SPA
      styles.css          Light/dark theme (MD3 design tokens)
      app.js              Client-side vanilla JS (WebSocket, tabs, rendering)
  tests/
    helpers.ts            Shared test utilities
    domain/
      agents.test.ts      Agent registration, heartbeat, presence
      channels.test.ts    Channel CRUD, join/leave, messaging
      messages.test.ts    Direct messaging, threading, forwarding
      state.test.ts       Shared state, CAS operations
      reactions.test.ts   Message reactions
      rate-limit.test.ts  Rate limiting
      events.test.ts      Event bus
      edge-cases.test.ts  Edge cases and error handling
    integration/
      workflows.test.ts   Multi-agent workflow tests
    transport/
      mcp.test.ts         MCP transport tests
    e2e/
      server.test.ts      HTTP/WebSocket server tests
```

## Code Style

- **TypeScript** with strict mode, ES modules
- **No `any`** — ESLint rule enforced
- **No inline comments** — use file-level section headers only (`// === Section ===` or `// --- Section ---`)
- **Naming**: `camelCase` for functions/variables, `PascalCase` for types/classes, `UPPER_SNAKE` for constants
- **Async**: use `async`/`await` over raw promises
- **No frameworks** — no React, Vue, Express. Pure Node.js + TypeScript
- **Dependency injection** — services receive `Db` and `EventBus` via `context.ts`, no global state
- **ESLint + Prettier** enforced via lint-staged (husky pre-commit)

## Testing

```bash
npm test                          # Run all tests (214 across 11 suites)
npm run test:watch                # Watch mode
npm run test:e2e                  # E2E server tests only
npm run test:coverage             # Coverage report (v8 provider)
npm run lint                      # ESLint
npm run typecheck                 # Type-check (tsc --noEmit)
npm run check                     # Full pipeline: typecheck + lint + format + test
```

Tests use **vitest** with in-memory SQLite databases. Each test gets a fresh context via helpers in `tests/helpers.ts`.

### What to Test

- Domain: agent registration/presence, channel CRUD, messaging/threading, shared state/CAS, reactions, rate limiting
- Integration: multi-agent workflows, cross-feature interactions
- Transport: MCP tool dispatch, REST endpoints, WebSocket events
- E2E: HTTP server lifecycle, WebSocket connections

## Database Migrations

Schema changes go in `src/storage/database.ts`. Follow this pattern:

1. Add a new `migrateVN()` function
2. Increment `SCHEMA_VERSION`
3. Migrations **must be idempotent** — use `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ADD COLUMN` with existence checks
4. All tables use foreign keys with `ON DELETE CASCADE`

Current schema version: **V2**

## Pull Requests

1. Fork the repository
2. Create a feature branch from `main`
3. Ensure all checks pass: `npm run check`
4. Write or update tests for your changes
5. Keep commits focused — one logical change per commit

### PR checklist

- [ ] `npm run check` passes (typecheck + lint + format + test)
- [ ] New features have tests
- [ ] No `any` types introduced
- [ ] No inline comments (use section headers)

## Commit Messages

Format: `v1.0.x: short description`

Every commit must bump the patch version minimum. No Co-Authored-By or AI branding.

## License

MIT
