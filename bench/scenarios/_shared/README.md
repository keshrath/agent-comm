# Shared bench infra

Single source of truth for the replicate loop, variance aggregation, and
cumulative budget cap that every Tier B scenario uses (`b1-catastrophe`,
`b2-pipeline-claim`, `b3-exclusive-resource`, `b4-skill-discovery`,
`b5-cross-session`, `b6-urgent-pivot`).

## Exports

| Symbol                               | Purpose                                                                                  |
| ------------------------------------ | ---------------------------------------------------------------------------------------- |
| `runReplicates<R>(opts)`             | Loop up to `n` replicates; stop early if cumulative USD cost crosses `maxCostUsd`.       |
| `statsOf(xs)` / `formatStats(s)`     | Mean, population stddev, min, max, count — descriptive only, no inferential corrections. |
| `aggregateNumeric(records, metrics)` | Bulk roll-up of numeric fields on a list of replicate records into `{ metric: Stats }`.  |
| `parseSharedArgs(argv, defaults)`    | Parse `--n` and `--max-cost-usd` (also reads `AGENT_COMM_BENCH_MAX_COST_USD`).           |

## `runReplicates` contract

```ts
const result = await runReplicates<RunMetrics>({
  n: 5,
  maxCostUsd: 15,
  costOf: (r) => r.total_cost_usd,
  label: 'b2:pipeline-claim',
  run: async (rep) => runReplicate(condition),
});
// result.completed : RunMetrics[]  (length <= n)
// result.totalCostUsd : number
// result.stoppedEarly : boolean
// result.stopReason? : string
```

Behaviour:

- The loop checks `totalCostUsd >= cap` **before** each replicate. If the cap
  is already hit, it stops, sets `stoppedEarly: true`, and returns the
  completed partial list — which is still useful for diagnosis.
- `costOf` is caller-supplied so the shape of `R` stays free-form across
  scenarios. Most scenarios point it at `r.total_cost_usd`.
- `0` or `Infinity` for `maxCostUsd` disables the cap.

## Budget cap semantics

Every Tier B scenario respects `--max-cost-usd=N`, default **$15**. This is
a **cumulative** cap across:

- all replicates of one condition, AND
- all conditions run in the same invocation.

Example: `--n=5 --conditions=naive,hooked` caps the whole 10-replicate run
at `$15` total. If naive burns `$12`, hooked gets `$3` and stops early when
it crosses the cap. Results are still written with `stopped_early: true`
and a `stop_reason` string.

The env var `AGENT_COMM_BENCH_MAX_COST_USD` sets the same thing when a flag
is not passed.

## Stats conventions

- Population stddev (not sample) — we report descriptive spread, not
  inferential confidence intervals.
- `formatStats(s, digits)` returns `"mean +/- stddev (min X, max Y, n=K)"`.
- Numeric-only keys are aggregated; strings and booleans pass through as
  raw per-replicate arrays.

## Files

```
_shared/
  replicate.ts   -- the module above
  README.md      -- this file
```
