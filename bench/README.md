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

## v6 result: solo dominates multi-agent on synthetic coding benchmarks

The most uncomfortable but most honest finding. Same workload as v4 but
**doubled to 12 functions** and with a **solo (1 agent) baseline** added.

| Condition                | Coverage | Wall   | Total $ | $/unit       |
| ------------------------ | -------- | ------ | ------- | ------------ |
| **solo (1 agent)**       | 12/12    | 77.1s  | $0.982  | **12.22** ⭐ |
| multi-control (3)        | 12/12    | 100.8s | $2.004  | 5.99         |
| multi-pipeline-claim (3) | 12/12    | 100.6s | $2.018  | 5.95         |

**The most damning data point**: solo's wall time barely moved between v5
(6 functions in 78s) and v6 (12 functions in 77s). Claude in solo mode plans
and writes all functions in one continuous response — there is essentially no
per-function serialization cost. With ~30s of fixed loading and ~0s marginal
cost per function, **no amount of parallelism can beat solo on workloads of
this style**.

### Why solo wins so decisively here

1. **Claude is too good at small-task batching.** It single-shots 12 algorithm
   implementations in one stream-of-consciousness response.
2. **Per-agent fixed overhead** (~30s loading, ~$0.10) is paid 3× by multi-agent.
   The marginal per-function work doesn't amortize it.
3. **Coordination is pure tax.** Both multi conditions are within $0.014 of each
   other — coordination overhead is constant regardless of pattern.
4. **No file dependencies.** Each algos-12 function is independent and well-specified;
   there is no exploration, iteration, or cross-file reasoning needed.

### What v6 proves

> On synthetic, well-specified, independent algorithm tasks, parallel
> multi-agent + agent-comm is not faster, not cheaper, and not more accurate
> than single-agent. **The "spawn 3 subagents to make small coding faster"
> claim is false on this benchmark.**

### What v6 does NOT prove

The bench can't reach the regimes where agent-comm actually pays off:

1. **Tasks that don't fit in one prompt** — real codebases, file dependencies,
   exploration. Claude can't single-shot a 200-file refactor; the algos-12
   fixture is small enough to single-shot easily.
2. **Side-effect-heavy work** — DB writes, deploys, rate-limited APIs. control's
   "free duplication" stops being free when each duplicate has consequences.
3. **Async / cross-session work** — agent A starts work, terminates, agent B
   (fresh context, possibly different machine) picks up via comm_state. Solo
   can't preserve state across sessions; this is the strongest theoretical use
   case for agent-comm and we have not built fixtures to test it.
4. **Real per-unit reasoning cost** — tasks taking ~30s+ of model thinking per
   file (not single-shot generation). algos-12 functions are too small.

Building fixtures that exercise these scenarios is substantial work — a real
codebase to mutate, real side effects, real budget pressure on context size.
**The bench is the wrong tool to argue for those use cases.**

### What v6 leaves intact from v4

Pipeline-claim is **still** the only coordination pattern that produces
deterministic output. Both v4 (N=2 replication) and v6 confirmed:

- 0% file collision in **every** pipeline-claim run
- Full coverage in **every** pipeline-claim run
- Bus-and-locks (soft coordination) is unstable: works sometimes, fails others

So even on the workload where multi-agent loses on cost and speed, **if you
need multi-agent for some other reason** (side effects, scale, async),
pipeline-claim is the right pattern and the only one that works.

### The recalibrated value prop

agent-comm is **not** a tool for making small parallel coding tasks faster.
Synthetic benchmarks have falsified that claim.

agent-comm **is** a substrate for hard-enforced coordination patterns
(`comm_state cas`-based work queues). Use it when:

- Coordination is **structurally required** — task-claim semantics, locks on
  shared resources, exactly-once execution
- The work has **side effects** that make naive duplication unsafe
- You're running **async or cross-session** workflows where state must outlive
  any individual agent
- You're building **orchestrator + worker** patterns where the orchestrator
  hands out tasks via the pipeline

agent-comm is **not the right tool** when:

- You're spawning N parallel agents to "go faster" on independent coding tasks
- Per-task work fits comfortably in one prompt
- There are no side effects and duplication is harmless
- Cost minimization is the only constraint

## v4 result: hard CAS enforcement is the only coordination pattern that works

**Workload**: `algos-6` — 6 algorithm-tier problems (CSV parse, number format,
word wrap, Roman numerals, LCS, email validation). Per-function "real work"
cost: ~$0.06–$0.09 (5× harder than v2's string-utils-6).

**Setup**: 3 parallel agents, $0.80 per-agent budget cap, **2 runs per condition**
for variance. Total spend: ~$11 across 18 agents.

| Condition            | Runs | Coverage     | Total $ | $/unit     | Collision    | Reliability  |
| -------------------- | ---- | ------------ | ------- | ---------- | ------------ | ------------ |
| `control`            | 2    | 6/6, 6/6     | $1.103  | **$0.184** | 100%, 100%   | stable       |
| `bus-and-locks`      | 2    | **4/6, 6/6** | $1.858  | $0.372     | **0%, 100%** | **UNSTABLE** |
| **`pipeline-claim`** | 2    | **6/6, 6/6** | $1.909  | $0.318     | **0%, 0%**   | **stable**   |

### What each condition does

- **control**: 3 agents, naive parallel, no MCP, no coordination instructions.
  Every agent independently solves every function.
- **bus-and-locks**: 3 agents with the agent-comm MCP server attached and a
  strict procedural prompt instructing them to claim files via `comm_state`
  before editing. **Soft enforcement** — the rule is in the prompt only.
- **pipeline-claim**: The driver pre-seeds a per-run `comm_state` namespace
  with one entry per file (value="pending"). Workers must atomically claim
  an entry via `cas` before editing. **Hard enforcement** — there is nothing
  in the prompt that lets an agent get work without going through cas.

### The headline finding

**Pipeline-claim is the only condition that achieves coordination
deterministically.** Both replication runs hit 6/6 coverage with 0% file
collision. Bus-and-locks does it once and fails the next time. Control never
coordinates at all.

This is consistent with what the v3 inspection logs showed: with prompt-only
coordination, agents follow the protocol for their first claim cycle and then
**drift back to "be helpful, finish the task"** on subsequent files. The drift
is non-deterministic — sometimes the agent stays disciplined, sometimes it
abandons the protocol mid-run. Hard CAS enforcement removes the choice
entirely: no claim, no work, period.

### What about $/unit?

Control still wins on raw $/unit on this workload. The reason is two-fold:

1. **API caching**: running control twice in sequence gives the second run a
   ~50% discount because the prompt prefix is cached. Real-world serial cost
   is somewhere between the cached and uncached number, not the average.
2. **Per-unit work is too cheap to amortize the coordination overhead.**
   Algos-6 functions cost ~$0.06 each. Pipeline-claim adds ~$0.13 of CAS
   overhead per claim cycle. Coordination is more expensive than the work
   it's coordinating.

**Crossover math** (derived from this run):

```
pipeline_wins_when:  per_unit_work_cost > coordination_overhead / (N - 1)
                  =  $0.13 / 2  ≈  $0.065  per unit  for N=3
```

We're sitting just above the threshold on $/unit (control $0.184 vs
pipeline-claim $0.318), but the cache discount on control inflates the gap.
**Pipeline-claim should overtake control on raw cost at per-unit work
~$0.30+** — i.e., tasks that take real reasoning (~30s of actual implementation
work per unit, not 5s).

### The real value prop (calibrated to this data)

agent-comm with **pipeline-claim** is the right tool when **any** of these hold:

1. **Duplication has side effects** — DB writes, deploys, rate-limited API
   calls, build artifacts. control's 3× redundancy becomes 3× the damage.
2. **Outcomes must be deterministic** — you need the same job to execute
   exactly once. bus-and-locks can't guarantee this; pipeline-claim can.
3. **Per-unit work cost > ~$0.07** — at typical tasks (parsing, generating
   non-trivial code, calling expensive APIs) the math flips in pipeline-claim's
   favor.
4. **Many agents on a long queue** — pipeline-claim scales linearly; control
   wastes O(N²) work as N grows.

agent-comm with **soft prompting (bus-and-locks)** is **never the right
answer**. It pays the MCP coordination cost without delivering reliable
coordination. If you want coordination, use hard enforcement; if you don't
care, use control. The middle is the worst place to be.

agent-comm is **not the right tool** when:

- Tasks are tiny, stateless, idempotent, and have no side effects
- Cost minimization on cached workloads is the only thing that matters
- N is small (2-3) and you can afford to throw away the duplicates

### Methodology notes

- Per-agent costs include ~$0.10 baseline for context loading (Claude Code
  loads CLAUDE.md, hooks, plugins on each headless invocation). Setting
  `ANTHROPIC_API_KEY` and using `--bare` would drop this ~10×.
- file_collision_rate is computed over edited files vs the fixture, **after**
  the run; it does not detect simultaneous in-progress edits.
- "Cached" runs benefit from API prompt-prefix caching; comparisons across
  conditions in the same invocation are slightly biased toward later
  conditions, especially when prompts share large prefixes.
- N=2 is a small sample. Bus-and-locks's split (one good run, one bad) is
  the strongest signal we have that the result isn't a fluke — the failure
  mode is fundamental to soft prompting, not a single bad roll.

## v2 pilot result (string-utils-6, N=3, 1 run/condition)

For historical reference — the v2 result that motivated v3/v4:

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
- [x] v3 workload: algos-6 (algorithm-tier problems, 5× harder per unit)
- [x] v4: pipeline-claim condition with hard CAS enforcement
- [x] N=2 replication confirming pipeline-claim stability vs bus-and-locks instability
- [x] v5: solo baseline added — multi-agent loses on small synthetic tasks
- [x] v6: scaled to N=12 functions (algos-12) — solo wins more decisively
- [x] Recalibrated value prop based on empirical findings
- [ ] Real-codebase fixture (file dependencies, context pressure) — the bench
      cannot prove or disprove agent-comm's value on small synthetic workloads;
      this requires a fixture that simulates real software work
- [ ] Side-effect fixture where duplication breaks something
- [ ] Async / cross-session fixture
- [ ] Results dashboard panel
