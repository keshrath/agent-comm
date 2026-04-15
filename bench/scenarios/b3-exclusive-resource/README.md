# B3 — Exclusive resource bench

Tests `comm_state` TTL lock on a singleton resource. Models the user's actual
daily pattern where N Claude sessions must share one playwright instance.

## Fixture

`workload/fake-browser.js` is a synthetic singleton binary:

1. If `browser.pid` exists → exits 2 with `already running`.
2. Else sleeps 500ms (deliberate race window), writes PID, sleeps 2.5s, deletes PID.
3. Every invocation appends one line to `invocations.jsonl`:
   `{agent, pid, outcome, start|end}` with `outcome ∈ {claim, done, already-running, done-but-stomped, exception}`.

The 500ms pre-sleep is intentional: without it, per-process startup jitter
often serializes parallel invocations by accident and the naive baseline
stops producing failures.

## Conditions

| Condition       | withMcp | prompt tells agent to …                                                |
| --------------- | ------- | ---------------------------------------------------------------------- |
| `naive`         | no      | just run `node fake-browser.js` and report                             |
| `resource-lock` | yes     | CAS-claim `comm_state(locks, fake-browser)`, poll if held, run, delete |

3 agents are spawned in parallel against ONE shared working dir.

## Metrics

| Metric            | Meaning                                                                   |
| ----------------- | ------------------------------------------------------------------------- |
| `successes`       | agents that ran fake-browser.js without `already-running`                 |
| `failures`        | agents that hit `already-running`                                         |
| `stomped`         | agents whose PID file was overwritten mid-run (race won, but not cleanly) |
| `pid_file_leaked` | was a stale `browser.pid` left behind? (bool)                             |
| `wall_seconds`    | total wall clock                                                          |
| `total_cost_usd`  | sum of per-agent costs                                                    |

## Pass criteria

- `resource-lock`: `failures == 0 AND stomped == 0 AND pid_file_leaked == 0` on every replicate (safety invariant).
- `naive`: `failures + stomped >= 1` on mean (demonstrates the race — if not, the fixture isn't contending).

## Running

```
npm run bench:b3 -- --dry-run                     # synthetic smoke
npm run bench:b3 -- --real --n=3 --max-cost-usd=12
```
