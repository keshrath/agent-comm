# multi-term-commit workload

Regression pilot. Fixture for the standalone `bench/runner.ts` harness,
kept for stability checks against the `bash-guard` hook. Not part of the
Tier B valuation suite — Tier B1 is the operational bench for catastrophe
prevention. Multi-term stays as a lightweight fixture so future changes to
the bash-guard path don't silently regress.

## Scenario

Two sequential agents in the same shared dir:

1. Session A edits `foo.js` + `bar.js`, walks away (no commit).
2. Session B starts in a different terminal (same project), edits
   `baz.js` + `qux.js`, runs `git commit -am "B's work"`.

Without `bash-guard`, B's `commit -am` sweeps in A's WIP because the `-a`
flag stages every modified file. With `bash-guard`, B's commit is blocked
with a message identifying the holder, and the agent re-stages selectively.

## Headline metric

`commit_purity` — fraction of B's commits that contain ONLY B's intended
files (`baz.js`, `qux.js`). On the naive condition this is usually `MIXED`
(includes `foo.js`, `bar.js` from A). On the hooked condition it's `PURE`
or `B_BLOCKED_AND_REVISED`.

## How to run

```bash
# Synthetic smoke
npm run bench:run

# Real run (spawns headless claude -p subagents, real API spend)
npm run bench:run -- --real
```

Results land in `bench/_results/latest.json` (served by the dashboard at
`GET /api/bench`).

## Files

```
workloads/multi-term/
  README.md        -- this file
  package.json     -- node scaffolding
  foo.js           -- A's target #1 (add stub)
  bar.js           -- A's target #2 (add stub)
  baz.js           -- B's target #1
  qux.js           -- B's target #2
```

Each `.js` file exports a single function with a `TODO` body — the agents
are asked to implement their two files and commit.
