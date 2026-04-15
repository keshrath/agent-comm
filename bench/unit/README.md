# Tier A — Unit primitives bench

In-process micro-benchmarks for the four primitives the `file-coord` hook
and coordination layer depend on. No subagents. No API spend. No network
beyond 127.0.0.1 to a throw-away dashboard the bench spawns itself.

Runs as part of `npm run check` and gates merges in CI. If a target misses
by more than 20 %, the bench fails and the PR is blocked.

## What it measures

| Bench                     | What                                                                                   | Target (pass gate)      |
| ------------------------- | -------------------------------------------------------------------------------------- | ----------------------- |
| `cas-latency`             | `StateService.compareAndSwap` in-memory SQLite, 10 000 ops                             | p50 < 8 ms, p95 < 30 ms |
| `hook-cache-fast-path`    | `readFileSync` + `JSON.parse` + mutate + `JSON.stringify` + `writeFileSync`, 1 000 ops | p50 < 1 ms, p95 < 3 ms  |
| `fail-open-detection`     | Time for the hook's `call()` helper to resolve `null` after the dashboard dies         | mean < 500 ms           |
| `sqlite-write-throughput` | `MessageService.send` INSERT into `messages`, 5 000 ops                                | >= 1 000 ops/sec        |

All gates apply a 20 % slack — the run fails if `actual` misses the target
by more than that. Variance across repeated runs stays under 10 % on a
typical laptop (verified by running the bench 3× consecutively).

## Pass criteria design

- **Lower-is-better** metrics (latency): `actual <= target * 1.2`.
- **Higher-is-better** metrics (throughput): `actual >= target / 1.2`.
- A flapping target is treated as a regression. If the bench starts flaking,
  bump warm-up or measurement `N` rather than relaxing the target — a loose
  number is a worse signal than a tight one.

## How to run

```bash
npm run bench:unit
```

Output: a human-readable summary to stdout, plus a structured payload at
`bench/_results/unit-latest.json`:

```json
{
  "schema_version": 1,
  "generated_at": "...",
  "node": "...",
  "platform": "...",
  "arch": "...",
  "benches": [
    { "name": "cas-latency", "p50_ms": ..., "p95_ms": ..., "targets": [...], "pass": true },
    ...
  ]
}
```

## Where it fits

Tier A measures things in isolation and answers "are the primitives fast
enough?". Tier B scenarios use the real subagent path; Tier C comes from
production traffic. If Tier A passes but Tier B fails, the bug is in the
integration, not the primitive. If Tier A fails, stop there.

## Files

```
bench/unit/
  primitives.bench.ts   -- the four benches + output writer
  vitest.config.ts      -- standalone vitest config (isolated from src/ tests)
  README.md             -- this file
```

## Forcing a break (for testing the gate itself)

Set `AGENT_COMM_BENCH_BREAK=cas` to inject a 50 ms busy-wait into every
CAS operation. The bench will fail the p50 gate, letting you verify the
CI reports the failure correctly without having to regress real code.
