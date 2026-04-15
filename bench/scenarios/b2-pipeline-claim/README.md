# Bench B2 — Pipeline claim race

**Question**: Does `comm_state` CAS give us atomic, race-free task dispatch in a
parallel-agent work queue?

**Setup**: N=5 agents spawned in parallel, sharing one working directory. A
work queue of M=4 items (`task-1`..`task-4`). Every agent is told to claim
items off the queue, do the work (write `report-<id>.md`), and log its
attempts to `claims.jsonl`.

Since there are more agents than items, at least 1 agent must exit without
claiming anything. In the naive condition, multiple agents are expected to
"claim" the same item (plain JSON file = TOCTOU race), producing duplicate
work. In the pipeline-claim condition, `comm_state` CAS guarantees only one
agent can flip an item from `pending` to claimed — duplicates are impossible.

## Conditions

### `naive`

- `withMcp = false` — agents have no `comm_state` tool.
- Queue is `queue.json` in the shared dir. Items have `status: "pending"`.
- Agents told: "pick a pending item, flip its status to claimed-by-<you>, write
  the report, log the attempt to claims.jsonl".
- **Expected**: duplicate_work_count > 0 (TOCTOU races produce collisions).

### `pipeline-claim`

- `withMcp = true`. Driver pre-seeds a `bench-b2-q-<runId>` namespace in
  `comm_state` with one key per task (`task-1`..`task-4`), each value=`pending`.
- Agents told to claim via
  `comm_state action=cas namespace=<ns> key=task-N expected=pending new=<agentId>`.
- Only one agent wins each CAS; others get `success=false` and pick another
  item (or exit if all items claimed).
- **Expected**: duplicate_work_count == 0 on every replicate.

## Metrics

| Metric                 | Source              | Meaning                                      |
| ---------------------- | ------------------- | -------------------------------------------- |
| `unique_tasks`         | `report-*.md` files | How many of 4 items got work done            |
| `duplicate_work_count` | `claims.jsonl`      | Agents who worked on an already-claimed item |
| `claims_attempted`     | `claims.jsonl`      | Total CAS/claim attempts across all agents   |
| `claims_won`           | `claims.jsonl`      | Attempts where the agent won the item        |
| `wall_seconds`         | driver              | Total time from spawn to last-agent exit     |
| `total_cost_usd`       | Claude usage logs   | Summed cost across all agents                |

## Pass criteria

- **pipeline-claim**: `duplicate_work_count == 0` across all replicates.
- **naive**: `duplicate_work_count > 0` on mean (fixture is adversarial enough).

If naive also shows 0 duplicates, the fixture isn't racey enough — raise N or
lower M.

## Usage

```bash
# Dry-run with synthesized plausible numbers:
npm run bench:b2 -- --dry-run

# Real run at n=3 replicates per condition, $15 budget cap:
npm run bench:b2 -- --real --n=3 --max-cost-usd=15

# Single condition:
npm run bench:b2 -- --real --n=1 --conditions=pipeline-claim
```
