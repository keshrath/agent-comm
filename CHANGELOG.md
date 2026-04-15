# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.3.10] - 2026-04-15

### Added

- **`comm_poll`** MCP tool — blocking inbox wait with optional `importance` filter. Resolves as soon as a matching new message arrives (or after `timeout_ms`, max 60000ms). Replaces busy-poll patterns in coordinating agents.
- **`importance` filter on `comm_inbox`** — returns only messages at a given level (`low`/`normal`/`high`/`urgent`), so agents can cheaply check for urgent signals without scanning the full inbox.

### Changed

- **Hook set trimmed.** `npm run setup` no longer installs `check-inbox.js` by default. Advisory PostToolUse nudges ("you have unread messages") don't reliably redirect the model during focused work. Peer-sent urgent signals are now handled by the `comm_poll` pattern in the agent's prompt contract. `check-inbox.js` remains in `scripts/hooks/` for users who opt in; when it does fire, it now only surfaces directly-addressed messages or high/urgent broadcasts in joined channels.
- **`workspace-awareness.mjs` trimmed to facts-only.** SessionStart banner now lists other active sessions and recent peer edits as data; it no longer injects prescriptive advice ("Before editing files, check the dashboard..."). Active enforcement (`bash-guard`, `file-coord`) handles the safety contract.
- **Bench suite re-organized.** Scenarios relabeled B1–B6 reflecting the validated primitives: catastrophe / pipeline claim / exclusive resource / skill discovery / cross-session / urgent pivot. See `bench/README.md`.
- **Docs scrubbed to current-state only.** Historical narration removed from README, CLAUDE.md, CONTRIBUTING.md, docs/\*.md, and per-scenario READMEs.

### Removed

- **`comm_search` MCP tool.** Agents don't reach for cross-session message search when solving source-visible problems, so the MCP surface was dead weight. The FTS5 backend (`MessageService.search()` + `GET /api/messages/search`) remains available for the dashboard's human-facing search bar.
- **`message_reactions` table.** Migration v6 drops the residual table; the `comm_react` tool was removed in v1.2.2 and the table has been unused since.

## [1.3.6] - 2026-04-11

### Fixed

- **`filterEditsByOthers`** (scripts/hooks/\_agent-comm-rest.mjs): multiple hook subprocesses from the same Claude Code session are now correctly treated as "self". Identity is matched by hostname prefix (stripping the trailing `-<PID>` segment) instead of exact equality, so the default `hostname-ppid` identity doesn't cause false-positive "other agent" detection when multiple Edit/Write tool calls spawn separate hook subprocesses within a single session. Session-ID–based identities (UUIDs from `CLAUDE_CODE_SESSION_ID`) are unaffected — UUIDs don't end in pure digits so the prefix strip is a no-op.

## [1.3.5] - 2026-04-08

### Changed — workspace-decision pilot now has a third condition

The `workspace-decision` pilot was previously documented as a hook loss
("NO — naive can already coordinate informally"). That verdict was based on
(1) the broken IPv4 hook silently failing on Windows from v1.3.0–v1.3.3 and
(2) only comparing naive vs file-coord — without ever testing the `pipeline-claim`
pattern that's the right architectural fit for task-assignment problems.

v1.3.5 adds a third condition to the pilot: `pipeline-claim`. The driver
pre-seeds `comm_state` with the 6 file names as queue entries (using the
existing `bench-q-<runId>` namespace pattern from async-handoff), and workers
must `cas`-claim before editing. The cas atomicity makes decision collision
impossible at the data layer.

**Re-run result with all three conditions** (post-IPv4-fix):

|                  | naive  | hooked (file-coord) | **pipeline-claim** |
| ---------------- | ------ | ------------------- | ------------------ |
| unique functions | 4/6    | 4/6                 | **5/6** ⭐         |
| wall time        | 87.3s  | **59.7s (-32%)** ⭐ | 74.8s              |
| total cost       | $1.361 | $1.389              | $1.460             |
| units / $        | 2.94   | 2.88                | **3.42** ⭐        |

**Both `pipeline-claim` and `file-coord` are wins, in different ways:**

- `pipeline-claim` is the right tool for task assignment — atomic cas-claim
  prevents decision collision at the data layer. Result: more unique
  coverage and the highest units/\$.
- `file-coord` is still useful here for speed — even at the same coverage
  as naive, it's 32% faster because it eliminates the wasted "did someone
  else touch this?" thinking cycles agents do when coordinating informally.

The bench README's TL;DR row for `workspace-decision` is updated from
"NO — naive can already coordinate informally" to "YES — pipeline-claim
covers 5/6 vs 4/6 naive; file-coord is 32% faster."

### Removed — bench dead code

- **Three unused workload fixtures deleted**: `bench/workloads/camel-to-kebab`
  (v1, 2 functions), `bench/workloads/string-utils-6` (v2, forced division
  by budget), `bench/workloads/algos-12` (v6, solo vs multi). All superseded
  by current pilots and documented in CHANGELOG history if anyone wants to
  revive them. Cleanup reduces bench/workloads/ from 8 to 5 directories.
- **`COORDINATION_INSTRUCTION` removed** — the 60+ line soft-coordination
  prompt that v3-v6 of the bench empirically falsified. No current pilot
  uses it. Replaced by `pipelineClaimInstruction()` which is the validated
  hard-enforcement version.
- **`bus-and-locks` and `bus-only` condition enum values removed** from
  `MultiAgentRun.condition`. Only `control` and `pipeline-claim` remain.
- **`runWorkload`'s default conditions** changed from
  `['control', 'bus-only', 'bus-and-locks']` to `['control']` to match
  reality.
- **Mock driver simplified** — no longer references the dead `bus-and-locks`
  condition. Distinguishes by `pipeline-claim` vs `control` instead.
- **Header comment** in `bench/runner.ts` rewritten to describe the v1.3.5
  reality (mock vs --real, --pilot dispatch, results JSON) instead of the
  legacy "four experimental cells" scheme.

### Why these are non-breaking

The deleted fixtures were never referenced by the active pilot dispatch
(`runner.ts` only routes to `shared-routes`, `lost-update`, `real-codebase`,
`workspace-decision`, `async-handoff`, and `multi-term-commit`). The deleted
condition enum values had no live consumers. The mock driver still produces
deterministic data for `npm run bench:run` (no `--real`).

288/288 tests pass.

### On the agent-comm ↔ agent-tasks dependency direction (architectural note)

This release also clarifies an important architectural rule: **agent-comm
must not depend on agent-tasks**. agent-tasks will eventually want to depend
on agent-comm (for shared state, presence, cross-session pipeline state),
which would create a dependency cycle if agent-comm pulls in agent-tasks.

Concretely: the bench's `pipeline-claim` condition uses agent-comm's
`comm_state` namespace as an ad-hoc queue, NOT the production agent-tasks
pipeline. This keeps the bench self-contained to one MCP server and
preserves the correct dependency direction. Validating agent-tasks' real
pipeline (with stages, dependencies, lifecycle) is a separate effort that
belongs in a bench inside the agent-tasks repo.

## [1.3.4] - 2026-04-08

### Fixed — critical Windows IPv4 bug in all hooks

**THE BIG ONE.** All hook scripts (`file-coord.mjs`, `bash-guard.mjs`,
`workspace-awareness.mjs` via `_agent-comm-rest.mjs`) used Node `http.request`
with `host: 'localhost'`. On Windows, Node's default DNS resolution prefers
IPv6 (`::1`) and the agent-comm dashboard binds only to `0.0.0.0` (IPv4). The
result: every hook HTTP call returned `ECONNREFUSED`, the hooks fail-soft
catch resolved to `null`, and the hook exited 0 silently as if everything
worked.

**This was a silent killer.** It meant the file-coord hook's `PostToolUse`
write to `files-edited` was never landing on Windows. The hook reported
"success", agents thought the file was being recorded, but the world model
was never updated. Downstream hooks (bash-guard) then saw an empty
`files-edited` namespace and never had any reason to block.

Fixed by adding `family: 4` to all `http.request` options in:

- `scripts/hooks/file-coord.mjs` — the original hook from v1.3.0
- `scripts/hooks/_agent-comm-rest.mjs` — the shared lib used by
  `bash-guard` and `workspace-awareness`

Validation: probe test confirms `files-edited` POST writes through after
the fix. Multi-term-commit pilot now produces the expected end-to-end
result (see below).

### Validated — multi-term-commit pilot

With the IPv4 fix in place, the v1.3.3 multi-term-commit pilot finally
produces the expected end-to-end result. Two sequential agents in a shared
git repo, session-A edits foo+bar (no commit), session-B edits baz+qux and
runs `git commit -am`:

| Condition    | commit_purity                | files in B's commit            | wall      | cost       |
| ------------ | ---------------------------- | ------------------------------ | --------- | ---------- |
| `naive`      | **MIXED** (clobbers A's WIP) | bar.js, baz.js, foo.js, qux.js | 91.0s     | $0.774     |
| **`hooked`** | **PURE**                     | **baz.js, qux.js**             | **78.8s** | **$0.591** |

**Hooked is 13% faster, 24% cheaper, AND produces a clean commit** instead
of silently mixing in session-A's WIP under B's commit message.

This is the **strongest empirical validation the project has had so far**.
The bench now directly proves the multi-terminal value prop: the v1.3.2
hooks fix the temporal-coordination scenario described in the v1.3.2
release notes.

### Implication for prior bench results

All bench results from v1.3.0 onward that depended on the file-coord hook
firing on Windows may have been **partially or completely broken** by this
silent IPv4 issue. The earlier "wins" we recorded (lost-update 4× efficiency
in particular) may have been timing artifacts rather than true hook
behavior. We can't know for sure without re-running every pilot, which
costs API budget. The bench README's TL;DR table reflects the v1.3.4
re-run for `multi-term-commit` and the older runs for everything else;
re-running the others is on the v1.3.5+ roadmap when budget allows.

## [1.3.3] - 2026-04-08

### Added — multi-term-commit bench pilot

- **`bench/workloads/multi-term`** — fixture: 4 source files (foo, bar, baz, qux),
  each a stub function. The bench driver inits a git repo around them at run
  time via the new `gitInit: true` option.
- **`runMultiTerminalCommit()` pilot in `bench/runner.ts`** — directly simulates
  the user's real-world scenario from v1.3.2:
  - 2 sequential agents in the SAME shared dir (not parallel)
  - Session A edits foo + bar but does NOT commit
  - Session B then edits baz + qux and runs `git commit -am "..."`
  - **Naive condition** (no bash-guard): B's commit will likely include A's
    foo + bar because `git commit -am` stages all modified files
  - **Hooked condition** (bash-guard installed): B's commit is BLOCKED with a
    "held by session-A" message; B has to react (selective stage, restore, etc.)
  - Headline metric: **commit_purity** — does B's commit contain ONLY baz + qux?
  - Post-run analyzer parses `git log` + `git show --name-only` from the run dir
- **Driver options**: `gitInit: true` initializes a git repo in the shared dir
  before agents spawn. `installBashGuard: true` adds the bash-guard hook to
  the per-agent settings JSON alongside (or instead of) file-coord.
- **Run with**: `npm run bench:run -- --real --pilot=multi-term`

### Why this pilot exists

v1.3.2 shipped the workspace-awareness and bash-guard hooks but they were only
unit-tested in isolation. The multi-term-commit pilot validates them
end-to-end against real Claude subagents in a real git repo. It directly
maps to the scenario you described: "two terminals, same project, agents
don't know about each other, conflict surfaces at commit time." If the hook
prevents the conflict in this pilot, it'll prevent it in your real workflow.

### What it does NOT measure

The pilot is one comparison, N=1, on one fixture. Statistical replication and
larger workloads are deferred. The validation cost is bounded (~$3-4 per run)
so re-running for variance is cheap.

## [1.3.2] - 2026-04-08

### Added — temporal coordination hooks

This release addresses the **multi-terminal scenario** that the file-coord
hook alone cannot solve: two Claude Code sessions in two terminals editing
the same project at different times, neither aware of the other, with the
conflict surfacing only at commit time when one session sees the other's WIP.

- **`scripts/hooks/workspace-awareness.mjs`** — fires on `SessionStart`,
  registers the session in `comm_state` namespace `workspace-agents` with the
  workspace path, and injects context into the agent's startup banner about
  OTHER active sessions in the same workspace plus their recent file edits.
  The agent starts already aware that it's not alone. TTL 4 hours.
- **`scripts/hooks/bash-guard.mjs`** — fires on `PreToolUse` matched on
  `Bash`. Single dispatch hook with a **rules table** that intercepts
  workspace-wide commands and checks them against the world model:
  - `git commit` → **BLOCKS** if any staged file was recently edited by
    another session in this workspace. Prevents the "I committed someone
    else's WIP under my message" scenario.
  - `git push` → **BLOCKS** with similar check on locally-changed files.
  - `npm/pnpm/yarn install/add/remove` → **BLOCKS** if another session
    has recent edits to `package.json` or lockfiles. Prevents lockfile
    chaos from concurrent installs.
  - `npm test / pnpm test / vitest / jest / pytest / cargo test / go test`
    → **WARNS** (allows the command to run) if another session has WIP in
    the workspace. Tests/builds may pick up incomplete changes.
  - `npm run build / pnpm run build / yarn build / tsc / cargo build / go build`
    → **WARNS** with the same check.
  - `prisma migrate / rails db:migrate / alembic upgrade / knex migrate /
drizzle-kit migrate` → **BLOCKS** if any migration files or schema
    files were recently edited by another session.
  - `npm run dev / pnpm dev / yarn dev / next dev / vite` → **WARNS** if
    another session is active in the workspace (port collision risk).
    Adding a new rule is one entry in the table inside `bash-guard.mjs`.
    Bypass-able for emergencies via `AGENT_COMM_GUARD_BYPASS=1`.
- **`scripts/hooks/_agent-comm-rest.mjs`** — shared library for hook scripts.
  Centralizes REST helpers, identity resolution, age formatting, workspace
  detection, and the file-edits / workspace-agents queries. New hooks can
  reuse the primitives instead of duplicating boilerplate.

### Removed

- **Bench dashboard panel UI** (the v1.3.1 "Bench" tab). The static
  results display didn't earn its place — the same information is in
  `bench/README.md` in a more readable form. The `GET /api/bench` REST
  endpoint and the `bench/_results/latest.json` file are kept for any
  programmatic consumer.

### Setup changes

- `scripts/setup.js` now installs both new hooks in addition to the
  existing five.
- The user's `~/.claude/settings.json` is updated to wire the new hooks
  into `SessionStart` (workspace-awareness) and `PreToolUse / Bash`
  (bash-guard) alongside the existing entries.

### Why this matters

The file-coord hook (v1.3.0) operates at the **edit moment** — it prevents
two agents from editing the same file simultaneously. But your real pain
isn't simultaneous edits, it's **temporal overlap**: Session A edits a file
at 14:00, Session B edits a different file at 15:00, Session A finishes
its task at 16:00 and runs `git status`, sees Session B's WIP mixed with
its own, has to manually figure out which changes are which, and frequently
either commits Session B's half-done work under A's commit message or
selectively stages and risks missing pieces.

The two new hooks intervene at the moments where this manifests:

- **Session start** — agent learns the workspace is shared before forming a plan
- **Bash command time** — `git commit`, `git push`, `npm install`, etc. are
  blocked or warned when they would conflict with another session's WIP

Together they make multi-terminal Claude Code workflows on the same project
safe by default, without requiring agents to remember to check anything.

## [1.3.1] - 2026-04-08

### Added — bench expansion

- **4 new bench pilots** alongside `shared-routes`:
  - `lost-update` — 3 agents append to one shared `state.json`. Tests the
    classic lost-update race. **Hooked: 3/3 items preserved at $0.914 vs naive
    1/3 at $1.279 — a 4× efficiency win** and the cleanest empirical
    validation that the file-coord hook fixes a real failure mode.
  - `real-codebase` — 3 agents make interdependent edits (type field,
    validation, logging) to a small Node.js project with `src/types.js`,
    `src/db.js`, `src/user.js` and a real test suite. Both conditions hit
    3/3, hooked is **23% cheaper** but slower (serialized agents wait).
  - `workspace-decision` — 3 agents in a multi-file workspace with **NO
    pre-assignment**, must figure out who does what. **Naive often wins** here
    because agents distribute work informally; the hook is overhead. Honest
    negative result.
  - `async-handoff` — 2 agents in **sequence** sharing a `comm_state` work
    queue. Tests cross-session continuity. 5/6 functions completed across
    the handoff at $0.946 — pipeline-claim works for the strongest theoretical
    use case.
- **Bench dashboard panel** at <http://localhost:3421/#bench>. Reads
  `bench/_results/latest.json` via the new `GET /api/bench` REST endpoint.
  Shows naive vs hooked deltas with green/red highlighting per metric.
- **Pilot CLI** — `npm run bench:run -- --real --pilot=NAME` runs a single
  pilot. Default runs all 5 in sequence.
- **Sequential agent mode** in the bench driver (`sequentialAgents: true`)
  for the async-handoff pilot.

### Fixed

- **`file-coord` hook reentrancy**: when an agent's earlier PostToolUse failed
  to release a lock (Claude Code timeout, crash, etc.), the agent's next Edit
  on the same file would block on its OWN lock indefinitely. Hook now treats
  "lock held by SELF" as a successful re-acquisition and refreshes the TTL.
- **`file-coord` hook polling**: blocked agents now poll the lock for up to
  10 seconds (configurable via `AGENT_COMM_POLL_TIMEOUT_MS`) instead of failing
  immediately. This is what makes the lost-update workload work — without
  polling, sibling agents on a single shared file have no way to wait their
  turn and burn budget retrying.
- **Hook timeout in `scripts/setup.js` and the bench driver**: bumped from
  `5s` to `15s` (must stay larger than the hook's poll timeout). The 5s value
  was killing the hook process mid-poll, which Claude Code interpreted as a
  hook failure → blocked tool call → agent retries → burns budget. **This was
  the silent regression that broke `shared-routes` and `workspace-decision`
  early in the v1.3.1 development cycle.**
- The user's `~/.claude/settings.json` is updated to the 15s timeout as part
  of this release.

### Documentation

- **`bench/README.md` rewritten from scratch.** Removed the v1–v6 chronological
  history (it lives in CHANGELOG and git log). New format leads with the
  TL;DR table of current results, lists when to use the hook and when not to,
  documents each pilot, and ends with a "Limitations" section that explicitly
  acknowledges the fixtures are self-built and points at SWE-bench Lite /
  MARBLE as the eventual upgrade path.
- **Main `README.md`** is now host-agnostic. The "MCP server" section explains
  agent-comm works with any MCP-compatible host (Claude Code, OpenCode,
  Cursor, Windsurf, Codex CLI, Aider, Continue.dev) and points at
  `docs/SETUP.md` for per-host integration recipes. The "agent visibility"
  section is rephrased so it doesn't read like a Claude-only feature.

## [1.3.0] - 2026-04-08

### Added

- **`scripts/hooks/file-coord.mjs`** — system-layer file coordination hook. PreToolUse claims a per-file lock via the new REST `cas` endpoint before any `Edit`/`Write`/`MultiEdit`; PostToolUse releases the lock and records the edit in the `files-edited` world model namespace. Default identity is `hostname-ppid` (stable per Claude session, no setup required), overridable via `AGENT_COMM_ID`. Fail-open if dashboard is down — never blocks real work.
- **`POST /api/state/:namespace/:key/cas`** — REST endpoint exposing atomic compare-and-swap to external coordinators (the `file-coord` hook is the first consumer, but any tool can use it). Returns `{ swapped: false, current }` on conflict so callers can identify the holder.
- **`startDashboard` exported from `lib.ts`** — embedded users (e.g. the bench, or any host that wants to spin up the REST/WS layer in-process) can now start the dashboard without going through the MCP stdio entry point.
- **`bench/workloads/shared-routes`** — the first bench fixture testing shared-file coordination (multiple agents editing one file in the same directory). Bench v7 measured the file-coord hook as 56% cheaper, 37% faster, and deterministic vs naive parallel multi-agent.
- **`scripts/setup.js`** now installs the file-coord hook (PreToolUse + PostToolUse on `Edit|Write|MultiEdit`) automatically when run against Claude Code.
- Documentation: detailed hook explanation in `docs/SETUP.md` (Claude Code, OpenCode plugin recipe, Cursor/Windsurf workarounds, Codex/Aider/Continue notes, generic MCP-client integration sketch). README highlights the v1.3.0 coordination story prominently.
- 4 new tests covering CAS-with-TTL expiry, REST cas success, REST cas conflict, and REST cas validation.

### Fixed

- **Pre-existing TTL expiry bug** in `state.expireSweep`. `expires_at` was stored from JS as ISO format (`2026-04-08T16:54:49.029Z`) but compared as strings against SQLite's `datetime('now')` (`2026-04-08 16:54:49`). Since `'T' > ' '`, **JS-set TTL entries never actually expired**. Fixed by wrapping `expires_at` in `datetime()` in the sweep query so both formats normalize. This was almost certainly causing real lock leaks in any workflow that used TTLs.
- `compareAndSwap` and the MCP `cas` action now accept `ttl_seconds`, so locks claimed via cas can auto-expire on agent crash.

### Why this is a minor bump (1.3.0, not 1.2.x)

The file-coord hook is a new architectural layer that fundamentally changes how multi-agent coordination works in agent-comm — from "MCP tools the model may choose to call" to "infrastructure the model operates within." The bench history (v3-v6 negative results, v7 positive result) is in `bench/README.md`; this is the first release where the project has empirical evidence that multi-agent + agent-comm beats naive multi-agent on a real workload.

## [1.2.29] - 2026-04-08

### Documentation

- Self-documenting release: documents this version + retroactively records the 1.2.28 release whose payload was the 1.2.20 – 1.2.27 backfill.

## [1.2.27] - 2026-04-08

### Changed

- Tidied `.gitignore` with section headers (dependencies, local data, test artifacts, worktrees, OS cruft) and added `test-results/` + `playwright-report/`.

## [1.2.26] - 2026-04-08

### Added

- **Playwright E2E dashboard test suite** at `tests/e2e-ui/dashboard.pw.ts`. Boots the standalone HTTP+WS server against a temp SQLite DB on a free port, drives the dashboard with chromium, and verifies: page loads with no console/page errors, websocket upgrade succeeds, all main tabs (`overview/agents/messages/channels/state/feed`) render their views when clicked, REST `/health` responds with version info. Runnable via `npm run test:e2e:ui` (separate from the existing vitest-based `test:e2e`). Devdep `@playwright/test`. Vitest count unchanged at 264.

## [1.2.25] - 2026-04-08

### Changed

- `CleanupService` now extends `agent-common`'s `CleanupService` base class to inherit the timer + reset-on-startup boilerplate, keeping only the agent-comm-specific cleanup logic locally.

## [1.2.24] - 2026-04-08

### Changed

- `index.ts` MCP dispatcher now delegates to `agent-common`'s `startMcpServer`, removing the local stdio bootstrap boilerplate.

## [1.2.23] - 2026-04-08

### Changed

- `transport/ws.ts` now delegates to `agent-common`'s `setupWebSocket`, removing the local WebSocket plumbing.

## [1.2.22] - 2026-04-08

### Changed

- `transport/rest.ts` now delegates `json` / `readBody` / `serveStatic` helpers to `agent-common`, removing duplicated HTTP plumbing.

## [1.2.21] - 2026-04-08

### Changed

- `storage/database.ts` now delegates to `agent-common`'s `createDb` + `Migration[]` runner, keeping only the agent-comm-specific schema locally.

## [1.2.20] - 2026-04-08

### Changed

- Added `agent-common` as a runtime dependency for events, package metadata, and the dashboard server primitives. First step in the cross-repo deduplication project.

## [1.2.19] - 2026-04-07

### Added

- **Dedicated `feed_events` retention** with its own configurable horizon. The activity feed table grows on every MCP call and used to piggy-back on the global 7-day retention; it now has its own default of 30 days, configurable via `AGENT_COMM_FEED_RETENTION_DAYS` (clamped 1-3650). New `CleanupService.cleanupFeedEvents(maxAgeDays?)` method, used inside `run()` and exposed via `POST /api/cleanup/feed`.
- **Schema-contract test** at `tests/storage/schema-contract.test.ts`. Locks down the columns the global Claude Code statusline reads (`agents.name`, `agents.status`, `agents.last_heartbeat`) by running the exact statusline query and asserting via `PRAGMA table_info`. Renaming any of these will fail loudly in CI instead of silently breaking the statusline.
- `CleanupStats.feed_events` field on `run()` / `purgeEverything()` return values.

### Tests

- 6 new tests across the two new files. Full suite 264 passing (was 258).

## [1.2.18] - 2026-04-07

### Added

- **State TTL — fully wired through every transport.** `state.set()` accepts an optional `ttl_seconds` parameter. Entries with a TTL are lazy-deleted on the next `get` / `list`. Now exposed at all three transport layers:
  - **MCP**: `comm_state { action: "set", ttl_seconds: 600, ... }` — agents can claim playwright/file locks that auto-release if the agent dies.
  - **REST**: `POST /api/state/:namespace/:key` accepts `ttl_seconds` in the body.
  - **Service**: `StateService.set(ns, key, value, agentId, ttlSeconds?)` — programmatic callers.
- Schema **v5**: `state.expires_at` column + partial index `idx_state_expires` (only indexes rows with a non-null expiry).
- New `expires_at` field on `StateEntry`.
- 5 new TTL tests (suite is now 258, was 251).

### Fixed

- Removed duplicate `expires_at` column declaration that briefly appeared in both V1 and V5 migrations during development. Fresh DBs and existing DBs both initialize cleanly now.
- `agent-desk-plugin.json` and `server.json` re-aligned to 1.2.18 (had silently lagged at 1.2.17).

### Schema contract (consumers, beware)

The `agents` table is read directly by external consumers (e.g. the global Claude Code statusline
script at `~/.claude/statusline-command.js` which queries
`SELECT name FROM agents WHERE status = 'online' ORDER BY last_heartbeat DESC LIMIT 1`).
**Do NOT rename `agents.name`, `agents.status`, or `agents.last_heartbeat` without bumping the major
version and updating the statusline.** If you must rename, add a backward-compat view first.

## [1.2.17] - 2026-04-03

### Added

- `package-meta.ts` — load name and version from `package.json` for MCP `initialize` and WebSocket payloads

### Changed

- More readable identifiers in MCP stdio entry, standalone server argv parsing, WebSocket client state, MCP handlers, and channel resolution
- Documentation: MCP tool count in ARCHITECTURE; test counts in README and CONTRIBUTING

[1.2.17]: https://github.com/keshrath/agent-comm/compare/v1.2.16...v1.2.17

## [1.2.3] - 2026-03-30

### Removed

- **`comm_branch`** MCP tool — conversation branching was unused by agents (REST endpoints still available)
- **`comm_handoff`** MCP tool — handoff was unused; agents coordinate via `comm_send` + task reassignment

### Changed

- MCP tool count: 9 → 7

[1.2.3]: https://github.com/keshrath/agent-comm/compare/v1.2.1...v1.2.3

## [1.2.1] - 2026-03-29

### Removed

- **`comm_react`** — reactions feature completely removed (domain, transport, UI, tests)
- **`comm_feed`** MCP tool — activity feed is now auto-emitted internally on all actions; no manual `log` tool needed
- **`comm_message`** MCP tool — thread view merged into `comm_inbox` via `thread_id` parameter

### Changed

- MCP tool count: 12 → 9
- `comm_inbox` now accepts optional `thread_id` parameter (replaces `comm_message({ action: "thread" })`)
- Auto-emit feed events for: register, unregister, send (direct/channel/broadcast), channel join/leave, state changes
- Dashboard: removed reaction rendering, lazy loading for messages and feed via REST pagination
- 221 tests across 12 suites

[1.2.1]: https://github.com/keshrath/agent-comm/compare/v1.2.0...v1.2.1

## [1.2.0] - 2026-03-29

### Changed

- **Major tool consolidation**: 38 tools reduced to 12 via action-based dispatch
  - `comm_agents` — merges `comm_list_agents`, `comm_discover`, `comm_whoami`, `comm_heartbeat`, `comm_set_status`, `comm_unregister`
  - `comm_send` — merges `comm_send`, `comm_broadcast`, `comm_channel_send`, `comm_reply`, `comm_forward`
  - `comm_message` — merges `comm_thread`, `comm_mark_read`, `comm_ack`, `comm_edit_message`, `comm_delete_message`
  - `comm_channel` — merges `comm_channel_create`, `comm_channel_list`, `comm_channel_join`, `comm_channel_leave`, `comm_channel_archive`, `comm_channel_members`, `comm_channel_history`, `comm_channel_update`
  - `comm_state` — merges `comm_state_set`, `comm_state_get`, `comm_state_list`, `comm_state_delete`, `comm_state_cas`
  - `comm_react` — merges `comm_react`, `comm_unreact` (action: "add"|"remove")
  - `comm_feed` — merges `comm_log_activity`, `comm_feed` (action: "log"|"query")
  - Kept as-is: `comm_register`, `comm_inbox`, `comm_branch`, `comm_handoff`, `comm_search`
- All domain service methods unchanged — only transport layer refactored
- All tests updated to use new tool names (259 tests passing)

[1.3.0]: https://github.com/keshrath/agent-comm/compare/v1.2.0...v1.3.0

## [1.2.0] - 2026-03-29

### Added

- **Conversation Branching** — fork a thread at any message point with `comm_branch` (pass `message_id` to create, omit to list). New `thread_branches` table, `branch_id` column on messages. Dashboard shows branch indicators on messages and branch listings in detail view.
- **Stuck Detection** — detect agents alive (heartbeat OK) but not making progress. New `last_activity` column on agents, updated on message send, state change, and activity logging. `comm_list_agents` with `stuck_threshold_minutes` returns idle agents (replaces `comm_stuck`). Heartbeat reaper auto-marks stuck agents as idle. Dashboard shows "idle" badge with time since last activity on agent cards.
- **Handoff Primitive** — transfer conversation ownership with full context via `comm_handoff`. Sends structured high-importance message with thread history and optional context. Dashboard renders handoff messages with distinct orange styling and swap icon.
- Database schema V4 with `thread_branches` table, `branch_id` on messages, `last_activity` on agents
- REST endpoints: `GET /api/branches`, `GET /api/branches/:id`, `GET /api/branches/:id/messages`, `GET /api/stuck`
- Activity feed types: `handoff`, `branch`

### Changed

- MCP tool count: 36 → 38 (consolidated `comm_branches` into `comm_branch`, `comm_stuck` into `comm_list_agents`)
- REST endpoint count: 25 → 29

[1.2.0]: https://github.com/keshrath/agent-comm/compare/v1.1.1...v1.2.0

## [1.1.1] - 2026-03-29

### Added

- Dashboard screenshots for Activity Feed and Agents with Skills views
- Screenshot references in README and DASHBOARD docs
- SubagentStop hook documentation (on-stop.js for clean unregister)

[1.1.1]: https://github.com/keshrath/agent-comm/compare/v1.1.0...v1.1.1

## [1.1.0] - 2026-03-29

### Added

- **Activity Feed** — new `feed_events` table, `comm_log_activity` and `comm_feed` MCP tools, `GET /api/feed` REST endpoint, and Activity tab on the dashboard. Agents report structured events (commits, test results, file edits, errors) to a shared timeline.
- **Skill-Based Discovery** — `comm_register` now accepts an optional `skills` parameter (array of `{id, name, tags[]}`). New `comm_discover` tool finds agents by skill ID or tag for dynamic capability-based routing.
- Database schema V3 with `feed_events` table and `skills` column on `agents`

### Changed

- MCP tool count: 33 → 36

## [1.0.15] - 2026-03-28

### Fixed

- Add missing `/api/agents/:id/heartbeat` endpoint to API docs
- Update CHANGELOG with missing version entries

## [1.0.14] - 2026-03-28

### Added

- Optional `status_text` parameter to `comm_heartbeat` tool

## [1.0.2] - 2026-03-25

### Added

- Cleanup dialog with Stale/Full options (replaces confirm prompt)
- Clickable stat cards to navigate to sections
- Dynamic version display (read from package.json at runtime)
- GitHub Actions CI (Node 20+22, typecheck+lint+format+test)
- npm publish on version tags with provenance
- CLAUDE.md with architecture and design docs

### Fixed

- Message badge count not resetting after clearing messages
- Emoji empty-state icons replaced with Material Symbols Outlined

### Changed

- Stale cleanup now cascades: removes offline agents + their messages, empty channels, state
- Full cleanup wipes all agents, messages, channels, state
- Google Fonts for Inter + Material Symbols Outlined
- Shadow tokens added for consistent elevation

## [1.0.1] - 2026-03-25

### Added

- Cleanup dialog with Stale/Full options (replaces browser confirm prompt)
- Clickable stat cards on Overview to navigate to respective sections
- ESC key and click-outside to dismiss cleanup modal
- Focus-visible states on modal buttons
- Stale cleanup: purge offline agents + their messages, empty channels, state entries
- Full cleanup: wipe all agents, messages, channels, state entries
- `POST /api/cleanup/stale` and `POST /api/cleanup/full` endpoints

### Fixed

- Message badge count not resetting after clearing messages via Messages view

## [1.0.0] - 2026-03-25

First public release on GitHub and npm.

### Added

- Agent registration with presence (online/idle/offline) and capability discovery
- Direct messaging with threading, importance levels, and acknowledgment tracking
- Broadcast messaging to all online agents
- Topic-based channels with membership management
- Namespaced shared key-value state with atomic compare-and-swap
- FTS5 full-text search across messages
- MCP server with 33 tools (stdio transport)
- REST API with full CRUD endpoints
- WebSocket real-time event streaming
- Web dashboard with overview, agents, messages, channels, and state views
- Gmail-style split pane for messages with full markdown rendering
- Interactive views: click agent/channel cards to filter messages, removable filter chips
- Material Symbols icon font, Inter + JetBrains Mono fonts, light/dark theme
- `comm_reply`, `comm_forward`, `comm_set_status`, `comm_react`/`comm_unreact` tools
- Per-agent rate limiting: token bucket (10 burst, 60/min)
- Message reactions with grouped dashboard rendering
- Configurable data retention via `AGENT_COMM_RETENTION_DAYS` env var (default 7)
- Database schema v2: `agents.status_text` column, `message_reactions` table
- Hooks for mandatory agent communication (`scripts/hooks/`)
- Setup script (`npm run setup`): one-command MCP server + hooks registration
- Health check endpoint, export endpoint, cleanup service
- E2E + integration + unit tests (214 tests across 11 suites)
- Prettier, ESLint, Husky pre-commit hooks, lint-staged

[1.1.0]: https://github.com/keshrath/agent-comm/compare/v1.0.15...v1.1.0
[1.0.15]: https://github.com/keshrath/agent-comm/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/keshrath/agent-comm/compare/v1.0.2...v1.0.14
[1.0.2]: https://github.com/keshrath/agent-comm/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/keshrath/agent-comm/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/keshrath/agent-comm/releases/tag/v1.0.0
