# Tier B1 — Catastrophe prevention

Quantifies what a single `bash-guard` block actually saves, in minutes of
human git archaeology avoided. This is the bench that produces the headline
**"hours saved per month"** number for the hook.

## Scenario

A shared git repo, two sequential agents:

- **Agent A** is mid-refactor of `db/schema.sql`: four incremental Edits,
  no commit. Exits with WIP on disk. The `file-coord` hook records each of
  A's Edits in the `files-edited` world-model namespace with a timestamp.
- **Agent B** spawns after a randomized 5-60 s delay (seeded RNG, default
  seed = 42). B is tasked with a small unrelated fix to `scripts/deploy.sh`
  and instructed to commit using `git commit -am "..."`.

## Two conditions

| Condition | `file-coord` | `bash-guard` | Outcome                                                                                     |
| --------- | ------------ | ------------ | ------------------------------------------------------------------------------------------- |
| `naive`   | on           | off          | B's `commit -am` sweeps in A's WIP. Mixed commit.                                           |
| `hooked`  | on           | on           | B's commit is BLOCKED with an actionable message identifying A's recent edits. B re-stages. |

`file-coord` is ON in both conditions — the contrast is purely whether the
bash-level guard fires. Without `file-coord`, A's edits would never be
recorded and `bash-guard` would have nothing to check against.

## Metrics

- `blocked` (bool): did `bash-guard` fire on B's `git commit -am`?
- `commit_purity`: one of `PURE`, `MIXED`, `B_BLOCKED_AND_REVISED`, `NO_COMMIT`.
- `recovery_minutes_est`: heuristic = `count(A_files in B's commit) × 3 minutes`.
  3 min/file is the user's calibration for `git reset` + interactive rebase
  - manually restoring A's WIP from the reflog.
- `wall_seconds`, `total_cost_usd`: standard cost tracking.

## Headline: hours saved per month

```
hours_saved_per_month = (delta_recovery_minutes × blocks_per_week × 4.33) / 60

delta_recovery_minutes = mean_recovery_min(naive) − mean_recovery_min(hooked)
```

`--blocks-per-week` defaults to **3** (a multi-session dev triggers this
race a few times per week). At the default assumption with 3 min/file:

- naive: mean recovery **3 min / block** (MIXED every trial).
- hooked: mean recovery **0 min / block** (PURE or B_BLOCKED_AND_REVISED).
- headline: **~0.65 hours saved per month**.

Tune `--blocks-per-week=N` for your team's actual race rate. The underlying
3 min/file number is the normative calibration — change the call-site, not
the formula.

## Cost model

Per trial cost is dominated by Agent A's four Edits + Agent B's edit + commit
cycle. Typical `costUsd` per trial: `$0.20-0.33`. A default `--n=3 naive +
--n=3 hooked` full run lands around `$1.50-2.50`.

## How to run

```bash
# Dry run (synthetic, no API spend, validates report shape)
npm run bench:b1 -- --dry-run

# Real run (default n=3 per condition, ~5 min wall, ~$1.50-2.50 total)
npm run bench:b1

# Tune the headline assumption
npm run bench:b1 -- --blocks-per-week=5

# Reproducible spawn timing
npm run bench:b1 -- --dry-run --seed=42
```

Flags:

- `--dry-run` — synthetic numbers, no Claude spawn.
- `--n=N` — trials per condition (default 3).
- `--seed=N` — RNG seed for B-spawn delay (default 42).
- `--blocks-per-week=N` — assumption for the headline formula (default 3).
- `--budget=N` — per-agent budget cap USD (default 0.6).
- `--b-delay-min=SEC` / `--b-delay-max=SEC` — B-spawn delay window (default 5..60).
- `--max-cost-usd=N` — cumulative cap (default 15).

## Why n=3 is enough

The signal is binary per trial: bash-guard either fires on B's commit or it
doesn't. `file-coord`-recorded edits are deterministic. The only stochastic
element is what Claude does when blocked (re-stage selectively vs give up
vs re-run the wrong way). n=3 covers the realistic failure modes without
burning budget.

## Results

`bench/_results/b1-catastrophe-{dryrun|real}-<ts>.json`, one file per
invocation, never clobbered. Contains per-trial records, per-condition
summary, and the `headline_hours_per_month` value.

## Files

```
b1-catastrophe/
  README.md          -- this file
  driver.ts          -- harness entry point
  workload/
    db/schema.sql    -- A's target
    scripts/deploy.sh -- B's target
    package.json
    test.js
    README.md
```
