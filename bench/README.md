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

## v2 pilot result (string-utils-6, N=3, 1 run/condition)

The first real comparative number, run on `bench/workloads/string-utils-6` —
6 independent functions in 6 files, 3 parallel agents, $0.35 per-agent budget cap.

| Condition       | unique units | total cost | units / $ | file collision | individual pass |
| --------------- | ------------ | ---------- | --------- | -------------- | --------------- |
| `control`       | 6.0 / 6      | $0.636     | **9.44**  | 100%           | 100%            |
| `bus-and-locks` | 4.0 / 6      | $1.114     | 3.59      | **0%**         | 0%              |

**What actually happened**:

- `control`: each of the 3 agents independently solved all 6 functions. Massive
  duplication of _work_ (every file edited 3×) but 100% _coverage_. Each agent
  used ~$0.21 of its $0.35 budget. Team threw away 2× the necessary effort.
- `bus-and-locks`: locks worked exactly as designed — zero file overlap, each
  agent claimed disjoint work. But every agent hit the budget cap because the
  coordination protocol (comm_register + comm_state list + cas + delete +
  context loading) consumed most of the per-agent budget. Each agent only had
  budget for 1–2 functions. 2 functions were never claimed by anyone, so team
  coverage dropped from 6/6 to 4/6.

**Per-function cost**: $0.035 in control vs $0.28 with locks — **~8× overhead**.

### What this finding means

This is **exactly what coordination theory predicts**: distributed coordination
only pays off when `coordination_cost < duplication_cost`. On a 30-second task
with ample budget per agent, naive duplication is cheaper than coordinating to
avoid it. The bench correctly captured the tradeoff.

agent-comm **is** useful when:

- Tasks are **expensive enough** that coordination overhead is small relative to
  per-unit work cost (a 5-minute task per file makes the $0.10 coordination cost
  ~3% overhead instead of 200%)
- Duplication is **destructive or irreversible** (DB writes, external API calls
  with rate limits, build artifacts)
- Work **doesn't fit in one agent's context/budget** so division is forced
- Agents are **long-running and stateful** — comm_state survives individual
  agent lifetimes

agent-comm **is not** useful when:

- Tasks are small, cheap, and stateless
- Every agent has enough budget to do everything alone
- Duplication is harmless (idempotent, isolated worktrees)

This is the bench earning its keep — telling users _when_ to reach for the tool,
not just claiming it always wins.

### Reproducing

```bash
npm run build
npm run bench:run -- --real    # ~$1.75, ~3 minutes
```

Per-agent cost is dominated by context loading (~$0.10/agent baseline) since the
bench cannot use `--bare` without `ANTHROPIC_API_KEY` (parent OAuth session is
required for headless invocation). Setting `ANTHROPIC_API_KEY` would drop costs
~10× and allow much larger sample sizes.

## Status

- [x] Methodology spec (this file)
- [x] Metric calculators + unit tests (20 tests)
- [x] Runner skeleton with pluggable agent driver
- [x] Real Claude CLI driver
- [x] v1 workload: camel-to-kebab (2 functions)
- [x] v2 workload: string-utils-6 (forced division by budget)
- [x] First real comparative result with honest interpretation
- [ ] v3: larger per-task work to find the coordination/duplication crossover
- [ ] Workload: tom-replay (academic anchor)
- [ ] Workload: swe-lite-fanout (real-world anchor)
- [ ] Results dashboard panel
