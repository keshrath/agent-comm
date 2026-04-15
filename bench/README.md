# agent-comm bench

Evaluation harness for the `file-coord` hook, `bash-guard` hook, and the
surrounding coordination primitives (CAS, locks, skill registry, messaging).
Every feature must produce a measurable bench win or get removed.

Every scenario respects a `--max-cost-usd=N` cumulative cap (default `$15`)
to prevent runaway API spend. Results are written to `bench/_results/<scenario>-<timestamp>.json`.

## Tiers at a glance

| Tier   | Name                  | Validates                                                       | Cost             | npm script                    |
| ------ | --------------------- | --------------------------------------------------------------- | ---------------- | ----------------------------- |
| **A**  | Unit primitives       | CAS latency, hook cache fast-path, fail-open, SQLite throughput | Free, runs in CI | `npm run bench:unit`          |
| **B1** | Catastrophe           | `bash-guard` block on `git commit -am` saves human minutes      | ~$3-5 per `n=3`  | `npm run bench:b1`            |
| **B2** | Pipeline claim        | `comm_state` CAS eliminates duplicate work on task dispatch     | ~$7 per `n=3`    | `npm run bench:b2`            |
| **B3** | Exclusive resource    | `comm_state` TTL lock serialises singleton resources            | ~$1 per `n=1`    | `npm run bench:b3`            |
| **B4** | Skill discovery       | `comm_agents discover` beats random on capability lookup        | ~$1 per `n=3`    | `npm run bench:b4`            |
| **B5** | Cross-session persist | `comm_state` survives process boundary for resumed work         | ~$2 per `n=3`    | `npm run bench:b5`            |
| **B6** | Urgent pivot          | Peer-sent urgent message + `comm_poll` causes pivot             | ~$1 per `n=3`    | `npm run bench:b6`            |
| **C**  | Production signals    | Block events + fail-open counters from real traffic             | Free, always-on  | dashboard `/api/feed`         |
| reg.   | multi-term-commit     | Cross-session `bash-guard` regression                           | ~$1 per run      | `npm run bench:run -- --real` |

## Cheap smoke (no API spend)

```bash
npm run bench:unit                        # Tier A (required for CI)
npm run bench:b1 -- --dry-run             # synthesise bash-guard numbers
npm run bench:b2 -- --dry-run             # synthesise CAS numbers
```

## Real runs (spawn Claude subagents, cost real USD)

```bash
npm run bench:b1                          # catastrophe (default real, n=3)
npm run bench:b2 -- --real --n=3          # pipeline claim (CAS)
npm run bench:b5 -- --real --n=3          # cross-session persistence
npm run bench:b6 -- --real --n=3          # peer-sent urgent pivot
```

Every real run takes `--max-cost-usd=N` (or env `AGENT_COMM_BENCH_MAX_COST_USD`).
Default `$15`. The loop stops before the next replicate once cumulative spend
crosses the cap and writes `stopped_early: true` to the result JSON.

Composite: `npm run bench:all` = `bench:unit` + `bench:run` (unit + regression,
no live API spend). Individual Bx scenarios are invoked explicitly.

## Headline numbers

| Tier   | Baseline                             | With feature                                                                      | Headline                                               |
| ------ | ------------------------------------ | --------------------------------------------------------------------------------- | ------------------------------------------------------ |
| **A**  | —                                    | CAS p50 ~0.05 ms, hook cache p50 ~0.19 ms, fail-open ~1.3 ms, SQLite ~17k ops/sec | All 4 gates pass with 2–3 orders of magnitude headroom |
| **B1** | naive: `MIXED` commit every trial    | hooked: `PURE` commit every trial                                                 | **~0.65 hours saved / month** at 3 blocks/week         |
| **B2** | naive: mean 4 duplicate tasks (n=3)  | pipeline-claim: 0 duplicates on every replicate                                   | Safety invariant met                                   |
| **B3** | naive: 2/3 successes (1 race loss)   | resource-lock: 3/3 successes                                                      | Race eliminated                                        |
| **B4** | without-discover: 1/3 correct        | with-discover: 3/3 correct                                                        | Deterministic vs random baseline                       |
| **B5** | no-state: 2/4 unique, 2 duplicates   | with-state: 4/4 unique, 0 duplicates                                              | Cross-process persistence pays rent                    |
| **B6** | no-channels: 3/3 pivoted (file-stat) | with-channels: 3/3 pivoted via `comm_poll` + `importance=urgent`                  | Parity achieved                                        |

## Tier C — production instrumentation

Tier C is passive. The `file-coord` hook emits block events and fail-open
counters from real user traffic; the dashboard aggregates them. No driver
to run — query the live dashboard:

```bash
curl http://localhost:3421/api/feed?type=hook-block
curl http://localhost:3421/api/feed?type=hook-fail-open
```

If Tier C disagrees with A/B, the bench is wrong — not production.
Tier C is the ground truth.

## Files

```
bench/
  README.md              -- this file
  metrics.ts             -- pure metric calculators (unit-tested)
  metrics.test.ts        -- tests for the calculators
  runner.ts              -- CLI for the multi-term-commit regression pilot
  drivers/
    cli.ts               -- spawns `claude -p` subagents, installs hooks,
                           parses JSON output, runs the verify command
  unit/                  -- Tier A: in-process primitive benches
  scenarios/
    _shared/             -- replicate loop, stats, budget cap
    b1-catastrophe/      -- bash-guard validation
    b2-pipeline-claim/   -- CAS atomic dispatch
    b3-exclusive-resource/ -- TTL locks
    b4-skill-discovery/  -- capability registry
    b5-cross-session/    -- state across process boundary
    b6-urgent-pivot/     -- peer-sent urgent + comm_poll
  workloads/
    multi-term/          -- regression pilot fixture (foo/bar/baz/qux.js)
  _results/              -- every run appends a fresh JSON here
    latest.json          -- served by GET /api/bench for the dashboard
    unit-latest.json     -- latest unit bench run
    <scenario>-<ts>.json -- per-scenario historical snapshots
```

## Setup notes

- `AGENT_COMM_ID` does **not** need to be set. The hook defaults to
  `hostname-ppid`, which is stable per Claude session and unique per process.
- The hook requires the agent-comm dashboard on port 3421. It auto-starts on
  first MCP connection in a typical Claude Code workflow. If the dashboard is
  unreachable, the hook **fails open** — it never blocks real work.
- `~/.claude/settings.json` file-coord hook entries MUST set `timeout: 15`
  (or higher). The hook polls for up to 10 s on a contended lock; a shorter
  harness timeout kills the hook mid-poll and an Edit shows up as a tool-call
  failure. `npm run setup` configures this correctly.
- Bench tmp data lives in `C:\tmp\agent-comm-bench\` (Windows) or
  `/tmp/agent-comm-bench/` (Linux/macOS). Each run gets its own dir with
  per-agent settings + captured `_logs/` for post-mortem. Override via
  `AGENT_COMM_BENCH_TMP`.

## When to use the file-coord hook (operational guidance)

**Use it when:**

- Multiple agents will edit the **same file** in parallel (config, routing
  tables, schemas, deployment manifests, anything single-source).
- **Lost-update races** would corrupt or silently drop work.
- **Side effects** make duplicate work expensive (deploys, DB writes,
  rate-limited APIs, billing).
- **Determinism** matters more than raw throughput.

**Skip it when:**

- Agents work on **different** files in a multi-file workspace.
- Tasks are small, stateless, no shared resources.
- You're running a **single** agent at a time.
