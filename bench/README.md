# agent-comm benchmarks

Quantitative evaluation of whether agent-comm actually helps parallel agent fan-outs,
and at what cost. Two headline metrics, both with honest tradeoff reporting.

## Hypothesis

> Shared state with TTL claims (`comm_state`) and a structured task pipeline reduce
> wasted work in N-agent fan-outs _without_ killing parallelism, at acceptable token
> overhead.

This is falsifiable. The benchmark exists to disprove it.

## Metrics

### 1. File Collision Rate (user-facing headline)

Fraction of multi-agent runs where two or more agents edit the same file in a way
that causes a test regression or merge conflict.

```
collision_rate = runs_with_collision / total_runs
```

No prior published baseline for parallel coding agents — we own this metric.
Report **with** vs **without** TTL locks on file paths.

### 2. Duplicate Sub-Goal Rate (academically anchored)

Fraction of sub-goals proposed by ≥2 agents independently. Replicates the
methodology of _Theory of Mind for Multi-Agent Collaboration_
([arXiv:2310.10701](https://arxiv.org/abs/2310.10701)), which reports ~30% baseline
dropping to ~10% with shared belief state.

```
redundancy_rate = duplicate_subgoals / total_subgoals
```

Sub-goals are extracted from agent message logs and normalized
(lowercase, stopword strip, lemmatize). Two sub-goals are "duplicates" if their
normalized forms have Jaccard similarity ≥ 0.8 OR exact embedding cosine ≥ 0.9.

Report **with** vs **without** `comm_state` claims namespace.

## Tradeoff axes (always reported alongside the headline)

A coordination metric is meaningless without its cost. Every run also reports:

- **Token overhead ratio**: `total_tokens_multi / tokens_single_best_agent`
- **Wall-clock parallelism**: `sum(per_agent_wall_time) / total_wall_time`
  (1.0 = serial, N = perfect parallelism)
- **Useful-work ratio**: `(useful_parallel_work) / (coordination_overhead)`

If agent-comm gets collision rate to 0 by serializing everything, parallelism = 1
and we've proven nothing. The number we care about is the _ratio_.

## Workloads

| ID                   | Source                    | N agents | What they do                                          |
| -------------------- | ------------------------- | -------- | ----------------------------------------------------- |
| `swe-lite-fanout`    | SWE-bench Lite, 50 issues | 5–10     | Each agent attempts the same issue independently      |
| `repo-multi-feature` | agent-\* repos            | 3–6      | Agents implement non-overlapping features in parallel |
| `tom-replay`         | ToM paper task suite      | 4        | Direct replication of arXiv:2310.10701 setup          |

## Conditions

For each workload, run **all four cells**:

|           | No agent-comm | agent-comm |
| --------- | ------------- | ---------- |
| Locks off | A (control)   | B          |
| Locks on  | —             | C (full)   |

Cell A is the baseline. Cell C is the headline. B isolates "did the message bus
alone help, or is it the locks?"

## Negative results policy

If agent-comm hurts on a workload, **publish it**. The credibility from
"agent-comm adds 1.4× token overhead and only helps when N≥4 on shared-repo
tasks" is worth more than any cherry-picked +X% number.

## Running

```bash
npm run bench:metrics    # unit-test the metric calculators (fast, no agents)
npm run bench:run        # run a workload end-to-end (slow, spawns real agents)
```

The metric calculators are pure functions and tested independently of any
agent runs — see `bench/metrics.test.ts`. This means the math is verified
before you spend tokens.

## Status

- [x] Methodology spec (this file)
- [x] Metric calculators + unit tests
- [x] Runner skeleton with pluggable agent driver
- [ ] Subagent driver (Claude Code SDK integration)
- [ ] Workload: tom-replay
- [ ] Workload: swe-lite-fanout
- [ ] Workload: repo-multi-feature
- [ ] Results dashboard panel
