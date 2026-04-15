# Bench Tier B4 — skill-based agent discovery

Does `comm_agents action=discover skill=<id>` pay rent, or can a coordinator
achieve the same routing without the skill registry?

## Setup

4 passive worker agents are pre-registered in the fresh per-run agent-comm
context via `seedCtx.agents.register()`, then 1 coordinator subagent is spawned
through the CliDriver and asked to find the tester.

Workers are fixtures — they never run, never reply, they just exist as rows in
the registry.

## Conditions

### `with-discover`

- withMcp=true
- Workers registered with human-readable names
  (`worker-impl`, `worker-review`, `worker-test`, `worker-doc`) and the
  scenario's skills (`implement`, `review`, `test`, `doc`).
- Prompt tells the coordinator explicitly:
  `comm_agents({action:"discover", skill:"test"})` returns the tester.
- Expected: single discover call returns one row, coordinator writes
  `worker-test` to `found-agent.txt`. 3/3 correct.

### `without-discover`

- withMcp=true (same tool surface), but the prompt explicitly forbids the
  `discover` action — only `list` + inbox/send + broadcast are allowed.
- Workers are registered with **opaque** names (`agent-XXXXX`) and **no
  skills** on the registry row. The scenario's skill metadata lives only in
  a shared `workers.json` hint file the coordinator can't parse for identity
  (the name-to-skill mapping is withheld to simulate "skill registry
  doesn't exist").
- The 4 opaque names are the only thing `list` returns. Workers are passive,
  so broadcasting and waiting for a reply accomplishes nothing.
- The coordinator must guess. 25% random baseline.

## Metrics (per replicate)

- `found_correct` — bool; the contents of `found-agent.txt` match the real
  tester's name (human-readable in with-discover, opaque in without-discover).
- `found_any` — bool; file exists with non-empty content.
- `discover_used` — bool; scanned from the coordinator's stdout log for the
  `comm_agents` / `discover` signature.
- `wall_seconds`, `total_cost_usd` — driver-reported.

## PASS criteria

- `with-discover`: `found_correct == true` on every replicate (safety invariant
  for the discover primitive; failure means discover returned nothing / wrong
  row).
- `without-discover`: `mean(found_correct) <= 0.5` (well below the 3/3 bar
  of with-discover; 25% random gives mean ~0.25, noise pushes it up to ~0.4).

## Dry-run synthesis

- `with-discover`: 100% correct, cheap.
- `without-discover`: ~25% correct, random.

## Budget

`n=3` replicates per condition, cumulative cap `$15`.
