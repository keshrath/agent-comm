# agent-comm

## Architecture

Layered architecture with explicit dependency injection (no global state):

```
src/
  domain/     agents, channels, messages, state, reactions, feed, cleanup, rate-limit, events
  storage/    SQLite (better-sqlite3, WAL mode)
  transport/  REST (node:http), WebSocket (ws), MCP (stdio)
  ui/         Vanilla JS dashboard (no build step for UI)
```

- **No frameworks** — no React, Vue, Express. Pure Node.js + TypeScript.
- `context.ts` is the DI root — wires all services together.
- UI files (`index.html`, `app.js`, `styles.css`) are plain files copied to `dist/ui/` on build.

## UI / Dashboard

- **Icons**: Material Symbols Outlined (via Google Fonts CSS). No emojis.
- **Fonts**: Inter (UI text), JetBrains Mono (code/data)
- **Theme**: Light/dark toggle via `.theme-light` / `.theme-dark` class on `<body>`
- **Design tokens**: CSS custom properties (`--bg`, `--accent`, `--border`, `--shadow-*`, etc.)
- **Accent color**: `#5d8da8`
- **Radii**: 12px cards, 16px panels, 8px small elements
- **Section headers**: Uppercase, 13px, weight 600, letter-spacing 0.5px
- **Empty states**: Material Symbols icon (block, centered) + text + optional hint

## Code Style

- ESLint + Prettier enforced via lint-staged (husky pre-commit)

## Versioning

- Version lives in `package.json` and is read at runtime (REST `/health`, WS state payload, UI sidebar)
- Never hardcode version strings
- Every commit must bump the patch version minimum
- Commit message format: `v1.0.x: short description`

## Build & Test

```
npm run build      # tsc + copy UI files to dist/
npm test           # vitest (unit + integration + e2e)
npm run check      # typecheck + lint + format + test
npm run dev        # watch mode (tsc + nodemon)
```

## Key APIs

- **REST**: `GET /health`, `GET /api/agents`, `GET /api/messages`, `GET /api/channels`, `GET /api/state`, `GET /api/feed`, `POST /api/cleanup/stale`, `POST /api/cleanup/full`, `POST /api/state/:ns/:key/cas` (atomic compare-and-swap, used by the file-coord hook)
- **WebSocket**: Full state on connect, incremental events streamed, `refresh` request supported
- **MCP**: 7 tools (`comm_register`, `comm_agents`, `comm_send`, `comm_inbox`, `comm_channel`, `comm_state`, `comm_search`). Activity feed is auto-emitted internally on all actions (no MCP tool needed).

## Hooks (system-layer enforcement)

`scripts/hooks/` ships **5 hook scripts**. Four lifecycle (session-start, check-registration, check-inbox, on-stop) plus one **system-layer file coordination** hook added in v1.3.0:

- **`file-coord.mjs`** (`PreToolUse` + `PostToolUse` on `Edit|Write|MultiEdit`) — claims a per-file lock via `POST /api/state/file-locks/<path>/cas` before any edit, releases on PostToolUse, records the edit in the `files-edited` world-model namespace. Default identity = `hostname-ppid` (stable per Claude session), overridable via `AGENT_COMM_ID`. Fail-open if dashboard is down. **This is the empirically validated coordination primitive — bench v7 measured 56% cheaper, 37% faster, deterministic vs naive parallel multi-agent on shared files.**

The hook is host-agnostic — the same `file-coord.mjs` script works for any client that can shell out to a Node process around tool calls (Claude Code, OpenCode, custom MCP clients). See `docs/SETUP.md` for per-host installation.

## Bench

`bench/` contains a real measurement harness (not synthetic). v1-v6 tested independent parallel work and showed agent-comm doesn't help on that regime — coordination is pure overhead when there's nothing to coordinate. v7 finally tests **shared-file coordination** and shows the hook-enforced version is cheaper, faster, and deterministic. See `bench/README.md` for the full history including the methodology and what was learned at each iteration.
