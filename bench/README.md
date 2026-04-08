# agent-comm bench

Quantitative evaluation of agent-comm's coordination layer for parallel agents.
The bench answers ONE question:

> When multiple agents work in the same directory at the same time, does the
> agent-comm `file-coord` hook produce better outcomes than naive parallel
> execution?

The answer is **yes for some workloads, no for others**, and the bench is
designed to surface both. We publish negative results alongside positive ones.

## TL;DR (current state)

| Pilot                   | What it tests                                                                                                   | Hook winner?                                         |
| ----------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| **`multi-term-commit`** | **2 sequential terminal sessions, A edits foo+bar (no commit), B then edits baz+qux and runs `git commit -am`** | **YES ⭐ — clean commit + 13% faster + 24% cheaper** |
| `lost-update`           | 3 agents append to one shared `state.json` (classic race)                                                       | YES — 4× efficiency (early run; needs re-validation) |
| `shared-routes`         | 3 agents add routes to one shared `routes.js` (pre-assigned)                                                    | YES — cheaper, faster, deterministic                 |
| `real-codebase`         | 3 agents make interdependent edits in a small Node project                                                      | PARTIAL — cheaper, slower                            |
| `workspace-decision`    | 3 agents in a multi-file workspace, NO pre-assignment                                                           | NO — naive can already coordinate informally         |
| `async-handoff`         | 2 agents in sequence sharing a `comm_state` queue                                                               | YES — 5/6 cross-session continuity                   |

**The headline is `multi-term-commit`** — the only pilot that directly
tests the user-facing multi-terminal scenario the project was designed to
fix, validated end-to-end after the v1.3.4 critical IPv4 fix. It produces
a clean win on every dimension (purity, wall time, cost). The other pilots
are interesting infrastructure measurements; `multi-term-commit` is the
one that maps to actual daily pain.

> **Note on prior results**: a critical Windows IPv4 bug in the hook's
> `http.request` calls was discovered and fixed in **v1.3.4**. The hook
> was using `host: 'localhost'` and Node's default DNS preferred IPv6,
> but the dashboard binds to IPv4 only — every hook HTTP call returned
> `ECONNREFUSED`, and the fail-soft `null` resolution meant the hook
> exited 0 silently as if everything worked. All bench results from
> v1.3.0 onward that depended on the file-coord hook firing on Windows
> may have been silently degraded by this bug. The `multi-term-commit`
> row is from a post-fix run; the others are from earlier runs and
> should be re-validated. Re-validation is on the v1.3.5+ roadmap.

## When to use the file-coord hook

**Use it when:**

- Multiple agents will edit **the same file** in parallel (config files,
  routing tables, schemas, deployment manifests, anything single-source)
- **Lost-update races** would corrupt or silently lose work (counters,
  shared lists, accumulators)
- **Side effects** make duplicate work expensive (deploys, DB writes,
  rate-limited APIs, billing)
- **Determinism matters** more than raw throughput

**Skip it when:**

- Agents work on **different files** in a multi-file workspace and natural
  file ownership is enough
- Tasks are **small and stateless** with no shared resources
- You're running a **single agent** at a time

## How to run

```bash
# Unit-test the metric calculators (no agents, no API spend)
npm run bench:metrics

# Run all 5 pilots end-to-end with real Claude subagents
npm run bench:run -- --real

# Run a single pilot
npm run bench:run -- --real --pilot=lost-update
npm run bench:run -- --real --pilot=shared-routes
npm run bench:run -- --real --pilot=real-codebase
npm run bench:run -- --real --pilot=workspace-decision
npm run bench:run -- --real --pilot=async
```

Each pilot writes results to `bench/_results/latest.json`. The agent-comm
dashboard reads this file via `GET /api/bench` and displays it in the **Bench**
tab at <http://localhost:3421/#bench>.

## Setup notes

- **`AGENT_COMM_ID`** does not need to be set. The hook defaults to
  `hostname-ppid`, which is stable per-Claude-session and unique per process.
- The hook **requires the agent-comm dashboard to be running** on port 3421
  (auto-starts on first MCP connection in a typical Claude Code workflow). If
  the dashboard is unreachable, the hook **fails open** — never blocks real work.
- The hook config in your `~/.claude/settings.json` MUST set `timeout: 15` (or
  higher) on the file-coord entries. The hook polls for up to 10 seconds for a
  contended lock; if Claude Code's hook timeout is shorter, the hook is killed
  mid-poll and the agent sees the kill as a tool-call failure (and burns
  budget retrying). `npm run setup` configures this correctly.

## What each pilot measures

### `lost-update` — the cleanest positive case

Three agents share a single `state.json` containing `{"items": []}`. Each
agent reads the file, appends its name (`alpha`, `beta`, `gamma`) to the
items array, and writes it back. The test passes only when all 3 names are
present in the final file.

Without coordination this is the textbook **lost-update race**: agents read
the same baseline `[]`, all append, all write `["self"]`, the last writer
wins, the other 2 entries are silently lost.

With the file-coord hook, the writes serialize through CAS-based locks: each
agent waits for the previous one's PostToolUse release, then reads the
already-updated state and appends to it. **All 3 entries survive.**

### `shared-routes` — pre-assigned work on one file

Three agents share a single `routes.js` file with an `AGENTS_ADD_ROUTES_HERE`
marker. Each agent is **pre-assigned** a different resource (`users`, `posts`,
`comments`) and must add a `GET` and `POST` handler for it. The test passes
when all 6 routes are present.

This isolates the file-race question from the decision-collision question:
agents already know who's doing what, so the only thing being measured is
whether their parallel writes survive. Without the hook agents sometimes
get lucky timing; with the hook the result is deterministic.

### `real-codebase` — multi-file project, interdependent tasks

A small Node.js project with `src/types.js`, `src/db.js`, `src/user.js` and
a real test suite. Three agents are pre-assigned three interdependent tasks:

1. Add an `is_active` field to the User type and propagate through services
2. Add input validation to `createUser`
3. Add error logging to `db.js`

These tasks legitimately overlap on the same files (Agent 1 and 2 both touch
`user.js`; 1 and 3 both touch `db.js`). Without coordination, agents read
stale state mid-edit. With the hook, edits serialize and each agent reads the
latest state.

### `workspace-decision` — multi-file, NO pre-assignment

Three agents share a directory with 6 independent function files. Every
agent gets the **same prompt**: "implement any 2 functions you choose; the
team is graded on UNIQUE functions completed." There is no per-agent
assignment — agents must figure out who does what.

This is the test for **decision coordination**, not file coordination. The
file-coord hook signals "held by X" when an agent tries to edit a claimed
file, which gives the second agent a hint to pivot. But naive agents tend to
distribute work informally just by reading the directory listing in different
orders, so the hook's value here is marginal at best.

### `async-handoff` — sequential cross-session continuity

Two agents are spawned **in sequence** (not parallel), sharing the same
`comm_state` work queue. The first agent claims tasks via CAS, completes
some, exits. The second agent — a fresh process with a new context — sees
the queue's current state via `comm_state list` and picks up the remaining
tasks.

This tests the strongest theoretical use case for agent-comm: **state that
outlives a single agent process**. A solo agent cannot do this because solo
has no memory between sessions; the bus is the only mechanism.

## Detailed results

These are real numbers from runs of each pilot. **N=1 per condition** unless
noted — these are pilot results, not statistically replicated. Re-running can
shift the numbers ±20% on the workloads where outcomes depend on lucky
timing (`shared-routes`, `workspace-decision`).

### `lost-update` — 4× hooked efficiency

|                 | naive   | hooked   |
| --------------- | ------- | -------- |
| items preserved | **1/3** | **3/3**  |
| total cost      | $1.279  | $0.914   |
| wall time       | 53.7s   | 174.7s   |
| units / $       | 0.78    | **3.28** |

The hook is **30% cheaper** and preserves all the work; naive loses 2 of 3
entries to the race. Wall time is higher because agents serialize, but
that's the entire point — coordination IS serialization, and on this workload
the alternative is silent data loss.

### `shared-routes` — 56% cheaper, 37% faster

|            | naive (sometimes lucky) | hooked     |
| ---------- | ----------------------- | ---------- |
| coverage   | 6/6                     | 6/6        |
| wall time  | 58.9s                   | **37.1s**  |
| total cost | $1.533                  | **$0.669** |
| units / $  | 3.91                    | **8.97**   |

The hook is faster AND cheaper because it eliminates the wasted retries
that naive agents do when their Edits collide. Naive can hit 6/6 by lucky
timing; the hook is deterministic across replications.

### `real-codebase` — cheaper, slower

|                 | naive  | hooked     |
| --------------- | ------ | ---------- |
| tasks completed | 3/3    | 3/3        |
| wall time       | 62.5s  | 211.4s     |
| total cost      | $1.412 | **$1.093** |
| units / $       | 2.12   | **2.74**   |

Both conditions get all 3 tasks done. The hook is **23% cheaper** because
serialized agents don't waste tokens on confused mid-edit retries, but it's
**3× slower** because the agents wait on each other on the shared files.
Real-world tradeoff: pay more for speed, less for cost.

### `workspace-decision` — naive often wins

|                  | naive  | hooked |
| ---------------- | ------ | ------ |
| unique functions | 6/6    | 4/6    |
| wall time        | 57.8s  | 68.8s  |
| total cost       | $1.269 | $1.539 |
| units / $        | 4.73   | 2.60   |

When agents have a multi-file workspace and natural file ownership, naive
parallel agents tend to distribute work informally — they read the directory
listing, pick different files, and finish without ever colliding. The
file-coord hook adds overhead without value here. **The hook is the wrong
tool for this workload.**

### `async-handoff` — sequential continuity works

|                  | pipeline-claim |
| ---------------- | -------------- |
| unique completed | 5/6            |
| wall time        | 127.1s         |
| total cost       | $0.946         |
| units / $        | 5.29           |

Two agents in sequence completed 5 of 6 functions across the handoff. The
queue state in `comm_state` survived the agent process boundary cleanly.
Single-condition pilot — there's no "naive" comparison because solo cannot
preserve state across sessions by definition.

## Limitations and what would make this better

These are fixtures we built ourselves. They're **proof-of-concept tests for
the file-coord hook's mechanism**, not externally validated benchmarks. There
is no widely adopted benchmark for "multi-agent coordination on shared file
edits in real codebases" — the closest options are:

- **SWE-bench / SWE-bench Lite** ([Princeton](https://www.swebench.com/)) —
  real GitHub issues from popular Python projects, but single-agent. Could be
  adapted by running N parallel agents on the same instance and measuring
  whether their patches conflict, but the bench isn't designed for that.
- **MultiAgentBench / MARBLE** ([arXiv:2503.01935](https://arxiv.org/abs/2503.01935))
  — explicitly tests coordination protocols across topologies (star, chain,
  graph). Reports Coordination Score and Communication Score on real tasks.
  Closest match conceptually but uses synthetic environments.

A future iteration of this bench will adopt one of these (probably SWE-bench
Lite + a multi-agent wrapper) so the empirical claims can be compared to
published baselines.

**Other limitations:**

- N=1 per condition. Outcomes on `shared-routes`, `workspace-decision`, and
  `real-codebase` are sensitive to lucky timing and can shift ±20% across runs.
- Per-agent context-loading overhead is ~$0.10 baseline (because we cannot
  use `--bare` without `ANTHROPIC_API_KEY`). Real-world cost with the API
  key would be ~10× lower.
- The hook polls for up to 10 seconds. Workloads where every edit is contended
  (high-frequency edits to one file) may see wall-time inflation as agents
  queue up. Tunable via `AGENT_COMM_POLL_TIMEOUT_MS`.
- Sub-agent budget caps in the bench are tight ($0.40-$0.80 per agent) to
  keep total bench cost bounded. Real workflows with larger budgets would see
  the hook help more (because agents have headroom to wait and retry).

## Reproducing

```bash
git clone https://github.com/keshrath/agent-comm.git
cd agent-comm
npm install && npm run build

# Optional: configure ANTHROPIC_API_KEY for ~10× cheaper runs
export ANTHROPIC_API_KEY=sk-ant-...

# Run all pilots — ~$15-20 in API spend
npm run bench:run -- --real

# Or run a single pilot
npm run bench:run -- --real --pilot=lost-update

# View results in the dashboard
open http://localhost:3421/#bench
```

Bench tmp data lives in `/tmp/agent-comm-bench/` (Linux/macOS) or
`C:\tmp\agent-comm-bench\` (Windows). Each run gets its own dir with the
agent dirs, the per-agent settings JSON, and the captured `_logs/` for
post-mortem.

## Files

```
bench/
  README.md                    — this file
  metrics.ts                   — pure metric calculators (file_collision_rate,
                                  units_per_dollar, etc.)
  metrics.test.ts              — 20 unit tests for the calculators
  runner.ts                    — CLI entrypoint, pilot dispatch, results write
  drivers/cli.ts               — Real Claude CLI driver (spawns headless
                                  `claude -p` subagents in shared dirs, installs
                                  the file-coord hook in per-agent settings,
                                  parses JSON output, runs the test command)
  workloads/
    lost-update/               — 3 agents append to state.json
    shared-routes/             — 3 agents add routes to routes.js
    real-codebase/             — small Node project, 3 interdependent tasks
    algos-6/                   — 6 algorithm functions (used by workspace-
                                  decision and async-handoff)
  _results/
    latest.json                — written by each pilot run, served by the
                                  dashboard at /api/bench
```
