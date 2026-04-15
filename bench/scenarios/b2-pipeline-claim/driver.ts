// =============================================================================
// Bench Tier B2 — Pipeline claim race.
//
// Showcase scenario for agent-comm's coordination value: N=5 parallel agents
// competing for M=4 work items. Binary outcome — either the claim primitive
// is atomic (no duplicates) or it isn't.
//
// Conditions:
//   naive          — withMcp=false. Agents coordinate via a plain queue.json
//                    (TOCTOU races expected). Duplicate work > 0 on mean.
//   pipeline-claim — withMcp=true. Driver pre-seeds comm_state namespace
//                    `bench-b2-q-<runId>` with one key per task (value="pending").
//                    Agents claim via `comm_state action=cas`. CAS is atomic
//                    so duplicate_work_count MUST be 0 on every replicate.
//
// Metrics:
//   unique_tasks         — distinct report-<id>.md files with content (max 4)
//   duplicate_work_count — agents who worked on an already-claimed task
//   claims_attempted     — total CAS/claim attempts (from claims.jsonl)
//   claims_won           — attempts where the agent won the item
//   wall_seconds, total_cost_usd
//
// PASS criteria:
//   pipeline-claim : duplicate_work_count == 0 on EVERY replicate (safety invariant)
//   naive          : mean duplicate_work_count > 0 (fixture is adversarial)
// =============================================================================

import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeCliDriver } from '../../drivers/cli.js';
import type { WorkloadTask, AgentDriver } from '../../runner.js';
import type { MultiAgentRun } from '../../metrics.js';
import { runReplicates, statsOf, parseSharedArgs, type Stats } from '../_shared/replicate.js';

// -----------------------------------------------------------------------------
// CLI args
// -----------------------------------------------------------------------------

type Condition = 'naive' | 'pipeline-claim';

interface CliArgs {
  dryRun: boolean;
  real: boolean;
  n: number;
  maxCostUsd: number;
  conditions: Condition[];
}

function parseArgs(argv: string[]): CliArgs {
  const dryRun = argv.includes('--dry-run');
  const real = argv.includes('--real');
  const shared = parseSharedArgs(argv, { n: 3, maxCostUsd: 15 });
  const condFlag = argv.find((a) => a.startsWith('--conditions='));
  const conditions = (condFlag?.split('=')[1] ?? 'naive,pipeline-claim')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Condition => s === 'naive' || s === 'pipeline-claim');
  return {
    dryRun,
    real,
    n: shared.n,
    maxCostUsd: shared.maxCostUsd,
    conditions: conditions.length > 0 ? conditions : ['naive', 'pipeline-claim'],
  };
}

// -----------------------------------------------------------------------------
// Workload constants
// -----------------------------------------------------------------------------

const TASK_IDS = ['task-1', 'task-2', 'task-3', 'task-4'] as const;
const N_AGENTS = 5;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'workload');

// -----------------------------------------------------------------------------
// Prompts — condition-aware. Both prompts share the "write a short report"
// body; they diverge only on the claim mechanism.
// -----------------------------------------------------------------------------

const TASKS_HUMAN = TASK_IDS.join(', ');

function naivePromptForAgent(i: number): string {
  const name = `a${i}`;
  return [
    `You are worker "${name}", one of ${N_AGENTS} parallel workers.`,
    ``,
    `SHARED STATE in this directory:`,
    `  queue.json      — list of ${TASK_IDS.length} pending work items (${TASKS_HUMAN}).`,
    `  claims.jsonl    — append-only claim log (one JSON event per line).`,
    `  report-<id>.md  — output files, one per task, written by the worker who does it.`,
    ``,
    `GOAL: claim ONE unclaimed item, write the report for it, exit. Do not claim more`,
    `than one item — if all are claimed, exit immediately without editing anything.`,
    ``,
    `CLAIM PROTOCOL (naive — NO MCP TOOLS AVAILABLE):`,
    `  1. Read queue.json. Pick the first item whose status is "pending".`,
    `  2. Log the attempt to claims.jsonl:`,
    `       echo '{"event":"attempt","agent":"${name}","task":"<task-id>","outcome":"won","ts":"<iso>"}' >> claims.jsonl`,
    `     (use your chosen task-id; set outcome="won" since the plain-file read-check thinks you have it).`,
    `  3. Write queue.json back with that item's status flipped to "claimed" and claimed_by="${name}".`,
    `  4. Log the work event:`,
    `       echo '{"event":"work","agent":"${name}","task":"<task-id>","ts":"<iso>"}' >> claims.jsonl`,
    `  5. Write report-<task-id>.md — a 3-4 sentence summary of the item's title field from queue.json.`,
    `  6. Exit.`,
    ``,
    `IMPORTANT: if you see no pending item on your read of queue.json, STILL append an`,
    `attempt event with outcome="lost" for the first item and then exit without writing`,
    `any report. Do NOT work on a task that is already claimed.`,
    ``,
    `Run \`node verify.js\` once you are done so the harness can record results.`,
  ].join('\n');
}

function pipelineClaimPromptForAgent(i: number): string {
  // The queue namespace is injected by makeCliDriver's pipelineClaimInstruction
  // appended after this prompt. We reference the same semantics here so the
  // agent has a single coherent procedure to follow (write the report +
  // claims.jsonl logging). The trailing default text reinforces the CAS rule.
  const name = `a${i}`;
  return [
    `You are worker "${name}", one of ${N_AGENTS} parallel workers.`,
    ``,
    `SHARED STATE in this directory:`,
    `  queue.json      — informational list of the ${TASK_IDS.length} items (${TASKS_HUMAN}).`,
    `                    Do NOT edit this file. The authoritative queue is in comm_state.`,
    `  claims.jsonl    — append-only claim log (one JSON event per line).`,
    `  report-<id>.md  — output files, one per task, written by the worker who claimed it.`,
    ``,
    `GOAL: atomically claim ONE item, write its report, exit. If all items are claimed,`,
    `exit without editing anything.`,
    ``,
    `CLAIM PROTOCOL — use the comm_state MCP tool (TASK-IDs are the queue keys):`,
    ``,
    `  For each candidate task-id in the list above:`,
    `    1. Attempt CAS:`,
    `         mcp__agent-comm__comm_state`,
    `           action="cas"`,
    `           namespace=<the namespace given below>`,
    `           key=<task-id>`,
    `           expected="pending"`,
    `           new_value="${name}"`,
    `    2. Log the attempt to claims.jsonl via bash:`,
    `         echo '{"event":"attempt","agent":"${name}","task":"<task-id>","outcome":"won"|"lost","ts":"<iso>"}' >> claims.jsonl`,
    `       where outcome is "won" if swapped=true, else "lost".`,
    `    3. If you WON: log a work event:`,
    `         echo '{"event":"work","agent":"${name}","task":"<task-id>","ts":"<iso>"}' >> claims.jsonl`,
    `       Then read queue.json to get the item's "title", write a 3-4 sentence report`,
    `       to report-<task-id>.md, mark the key done:`,
    `         mcp__agent-comm__comm_state action="set" namespace=<ns> key=<task-id> value="done"`,
    `       and EXIT. Do NOT claim a second item.`,
    `    4. If you LOST: move on to the next task-id.`,
    `  If you've LOST on every task-id, exit without writing any report.`,
    ``,
    `ABSOLUTE RULE: never write report-<id>.md for a task you did not win via CAS.`,
  ].join('\n');
}

// -----------------------------------------------------------------------------
// Run-level metrics extracted from a single MultiAgentRun's shared dir.
// -----------------------------------------------------------------------------

interface RunMetrics {
  unique_tasks: number;
  duplicate_work_count: number;
  claims_attempted: number;
  claims_won: number;
  wall_seconds: number;
  total_cost_usd: number;
  agents_launched: number;
}

interface CondAggregate {
  condition: Condition;
  n: number;
  per_run: RunMetrics[];
  unique_tasks: Stats;
  duplicate_work_count: Stats;
  claims_attempted: Stats;
  claims_won: Stats;
  wall_seconds: Stats;
  total_cost_usd: Stats;
  passed: boolean;
  failure_reason?: string;
  stopped_early?: boolean;
  stop_reason?: string;
}

async function readRunState(
  runId: string,
): Promise<{ unique: number; duplicates: number; attempted: number; won: number } | null> {
  const TMP_ROOT =
    process.env.AGENT_COMM_BENCH_TMP ??
    (process.platform === 'win32' ? 'C:\\tmp\\agent-comm-bench' : '/tmp/agent-comm-bench');
  const sharedDir = path.join(TMP_ROOT, `bench-${runId}`, 'shared');
  let unique = 0;
  for (const id of TASK_IDS) {
    try {
      const content = await fsp.readFile(path.join(sharedDir, `report-${id}.md`), 'utf8');
      if (content.trim().length > 0) unique += 1;
    } catch {
      /* missing */
    }
  }
  let attempted = 0;
  let won = 0;
  const taskWorkers = new Map<string, Set<string>>();
  try {
    const raw = await fsp.readFile(path.join(sharedDir, 'claims.jsonl'), 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as {
          event?: string;
          agent?: string;
          task?: string;
          outcome?: string;
        };
        if (typeof obj.agent !== 'string' || typeof obj.task !== 'string') continue;
        if (!(TASK_IDS as readonly string[]).includes(obj.task)) continue;
        if (obj.event === 'attempt') {
          attempted += 1;
          if (obj.outcome === 'won') won += 1;
        } else if (obj.event === 'work') {
          if (!taskWorkers.has(obj.task)) taskWorkers.set(obj.task, new Set());
          taskWorkers.get(obj.task)!.add(obj.agent);
        }
      } catch {
        /* skip malformed */
      }
    }
  } catch {
    // No log file — return what we have; duplicate detection degrades gracefully.
  }
  let duplicates = 0;
  for (const workers of taskWorkers.values()) {
    if (workers.size > 1) duplicates += workers.size - 1;
  }
  return { unique, duplicates, attempted, won };
}

// -----------------------------------------------------------------------------
// Real-run driver: spawn ONE replicate of one condition.
// -----------------------------------------------------------------------------

async function runReplicate(condition: Condition): Promise<RunMetrics> {
  const promptForAgent = condition === 'naive' ? naivePromptForAgent : pipelineClaimPromptForAgent;
  const driverCondition: 'pipeline-claim' | 'control' =
    condition === 'pipeline-claim' ? 'pipeline-claim' : 'control';

  const driver: AgentDriver = makeCliDriver({
    fixtureDir: FIXTURE_DIR,
    testCmd: 'node verify.js',
    maxBudgetUsd: 1.5,
    // When condition=pipeline-claim, the driver uses these as the queue keys
    // it seeds in comm_state (namespace=bench-q-<runId>, each value="pending").
    // When condition=control (naive), expectedFiles isn't used for seeding.
    expectedFiles: [...TASK_IDS],
    sharedDir: true,
    promptForAgent,
  });

  const task: WorkloadTask = {
    task_id: 'b2-pipeline-claim',
    workload: 'b2-pipeline-claim',
    target: FIXTURE_DIR,
    prompt: 'unused — see promptForAgent',
  };

  const run: MultiAgentRun = await driver.runOnce(task, N_AGENTS, driverCondition);
  const state = await readRunState(run.run_id);
  const unique = state?.unique ?? 0;
  const duplicates = state?.duplicates ?? 0;
  const attempted = state?.attempted ?? 0;
  const won = state?.won ?? 0;
  const total_cost_usd = run.agents.reduce((s, a) => s + (a.cost_usd ?? 0), 0);

  return {
    unique_tasks: unique,
    duplicate_work_count: duplicates,
    claims_attempted: attempted,
    claims_won: won,
    wall_seconds: run.total_wall_ms / 1000,
    total_cost_usd,
    agents_launched: N_AGENTS,
  };
}

// -----------------------------------------------------------------------------
// Dry-run synthesis — deterministic plausible numbers per condition.
// -----------------------------------------------------------------------------

function synthesizeReplicate(condition: Condition, seed: number): RunMetrics {
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  if (condition === 'pipeline-claim') {
    // CAS is atomic — exactly 4 tasks won out of 5 agents. The losing agent
    // attempts each of the 4 items (one per CAS loop), losing on all, and exits.
    // So attempts ~= 4 won + (N-M) * M lost = 4 + 4 = 8 on average, usually
    // lower because wins short-circuit peer agents mid-loop.
    const attempted = 7 + Math.floor(rand() * 5); // 7..11
    return {
      unique_tasks: TASK_IDS.length,
      duplicate_work_count: 0,
      claims_attempted: attempted,
      claims_won: TASK_IDS.length,
      wall_seconds: 60 + rand() * 40,
      total_cost_usd: 0.35 + rand() * 0.2,
      agents_launched: N_AGENTS,
    };
  }
  // Naive: everyone races. Typical pattern on TOCTOU — 2-3 agents pick task-1
  // (the first pending item they all see), 1-2 agents pick task-2, etc. End
  // state usually 3-4 unique reports with 1-3 duplicates.
  const unique = 3 + Math.floor(rand() * 2); // 3..4
  const duplicates = 1 + Math.floor(rand() * 3); // 1..3
  return {
    unique_tasks: unique,
    duplicate_work_count: duplicates,
    // naive agents log ONE attempt each (they don't loop) — so N_AGENTS total
    claims_attempted: N_AGENTS,
    claims_won: N_AGENTS, // everyone THINKS they won because no CAS
    wall_seconds: 55 + rand() * 30,
    total_cost_usd: 0.32 + rand() * 0.18,
    agents_launched: N_AGENTS,
  };
}

// -----------------------------------------------------------------------------
// Aggregation + PASS/FAIL
// -----------------------------------------------------------------------------

function aggregate(condition: Condition, runs: RunMetrics[]): CondAggregate {
  const unique = runs.map((r) => r.unique_tasks);
  const dup = runs.map((r) => r.duplicate_work_count);
  const attempted = runs.map((r) => r.claims_attempted);
  const won = runs.map((r) => r.claims_won);
  const wall = runs.map((r) => r.wall_seconds);
  const cost = runs.map((r) => r.total_cost_usd);

  let passed: boolean;
  let failure_reason: string | undefined;
  if (condition === 'pipeline-claim') {
    // Safety invariant: CAS must produce zero duplicates on every replicate.
    passed = dup.every((x) => x === 0);
    if (!passed) {
      failure_reason = `pipeline-claim produced DUPLICATE work: max=${Math.max(...dup)} (safety invariant: must be 0 on every replicate)`;
    }
  } else {
    // Naive baseline: expect real duplicates. Mean must exceed 0 otherwise the
    // fixture isn't actually racey (N >= M and prompt tells them to race).
    const stats = statsOf(dup);
    passed = stats.mean > 0;
    if (!passed) {
      failure_reason = `naive duplicate_work_count mean=${stats.mean.toFixed(2)} <= 0 (expected races — fixture may not be adversarial enough; raise N or lower M)`;
    }
  }

  return {
    condition,
    n: runs.length,
    per_run: runs,
    unique_tasks: statsOf(unique),
    duplicate_work_count: statsOf(dup),
    claims_attempted: statsOf(attempted),
    claims_won: statsOf(won),
    wall_seconds: statsOf(wall),
    total_cost_usd: statsOf(cost),
    passed,
    failure_reason,
  };
}

function formatAgg(a: CondAggregate): string {
  const fmt = (s: Stats, digits = 3): string =>
    `${s.mean.toFixed(digits)} +/- ${s.stddev.toFixed(digits)} (min ${s.min.toFixed(digits)}, max ${s.max.toFixed(digits)})`;
  const verdict = a.passed ? 'PASS' : 'FAIL';
  const uniqueVals = a.per_run.map((r) => String(r.unique_tasks)).join(', ');
  const dupVals = a.per_run.map((r) => String(r.duplicate_work_count)).join(', ');
  const lines = [
    `  --- ${a.condition} (n=${a.n}) [${verdict}] ---`,
    `    unique_tasks          ${fmt(a.unique_tasks, 2)}  (per-run: ${uniqueVals})`,
    `    duplicate_work_count  ${fmt(a.duplicate_work_count, 2)}  (per-run: ${dupVals})`,
    `    claims_attempted      ${fmt(a.claims_attempted, 1)}`,
    `    claims_won            ${fmt(a.claims_won, 1)}`,
    `    wall_seconds          ${fmt(a.wall_seconds, 1)}`,
    `    total_cost_usd        $${fmt(a.total_cost_usd, 3)}`,
  ];
  if (a.failure_reason) lines.push(`    reason                ${a.failure_reason}`);
  if (a.stopped_early) lines.push(`    stopped_early         ${a.stop_reason ?? 'yes'}`);
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Persist results
// -----------------------------------------------------------------------------

async function persistResults(args: CliArgs, aggs: CondAggregate[]): Promise<string> {
  const outDir = path.resolve('bench/_results');
  await fsp.mkdir(outDir, { recursive: true });
  const fname = `b2-pipeline-claim-${args.dryRun ? 'dryrun-' : ''}${Date.now()}.json`;
  const out = path.join(outDir, fname);
  await fsp.writeFile(
    out,
    JSON.stringify(
      {
        scenario: 'b2-pipeline-claim',
        version: '1.3.9',
        generated_at: new Date().toISOString(),
        args,
        aggregates: aggs,
      },
      null,
      2,
    ),
  );
  return out;
}

// -----------------------------------------------------------------------------
// Main
// -----------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (!args.dryRun && !args.real) {
    console.error('error: must pass --dry-run (smoke) or --real (live, costs money)');
    console.error(
      'usage: tsx bench/scenarios/b2-pipeline-claim/driver.ts [--dry-run|--real] [--n=3] [--max-cost-usd=15] [--conditions=naive,pipeline-claim]',
    );
    process.exit(2);
  }

  if (!fs.existsSync(FIXTURE_DIR) || !fs.existsSync(path.join(FIXTURE_DIR, 'queue.json'))) {
    console.error(`error: fixture missing at ${FIXTURE_DIR}`);
    process.exit(2);
  }

  const mode = args.dryRun ? 'DRY-RUN (synthetic)' : 'REAL';
  console.log(`=== Bench Tier B2 — Pipeline claim race (${mode}) ===`);
  console.log(
    `    n=${args.n} per condition   conditions=${args.conditions.join(',')}   max-cost-usd=$${args.maxCostUsd}`,
  );
  console.log(
    `    workload: ${N_AGENTS} agents competing for ${TASK_IDS.length} items (${TASKS_HUMAN})`,
  );
  console.log();

  const aggs: CondAggregate[] = [];
  let cumulativeCost = 0;
  for (const condition of args.conditions) {
    const remainingBudget = args.maxCostUsd - cumulativeCost;
    if (remainingBudget <= 0 && !args.dryRun) {
      console.log(
        `>>> SKIPPING ${condition}: global budget cap $${args.maxCostUsd} already exhausted ($${cumulativeCost.toFixed(2)} spent)`,
      );
      continue;
    }
    console.log(`>>> running ${condition} ...`);
    const loopResult = await runReplicates<RunMetrics>({
      n: args.n,
      maxCostUsd: args.dryRun ? Infinity : remainingBudget,
      costOf: (r) => r.total_cost_usd,
      label: `b8:${condition}`,
      run: async (rep) => {
        const r = args.dryRun
          ? synthesizeReplicate(
              condition,
              0xb8 ^ (condition === 'pipeline-claim' ? 0x100 : 0) ^ rep,
            )
          : await runReplicate(condition);
        console.log(
          `    [${condition} #${rep}/${args.n}] unique=${r.unique_tasks}/${TASK_IDS.length} dup=${r.duplicate_work_count} attempted=${r.claims_attempted} won=${r.claims_won} wall=${r.wall_seconds.toFixed(1)}s cost=$${r.total_cost_usd.toFixed(3)}`,
        );
        return r;
      },
    });
    cumulativeCost += loopResult.totalCostUsd;
    const agg = aggregate(condition, loopResult.completed);
    agg.stopped_early = loopResult.stoppedEarly;
    agg.stop_reason = loopResult.stopReason;
    aggs.push(agg);
  }

  console.log();
  console.log('=== AGGREGATE ===');
  for (const a of aggs) console.log(formatAgg(a));
  console.log();
  console.log(`    cumulative_cost_usd = $${cumulativeCost.toFixed(3)} (cap $${args.maxCostUsd})`);

  const out = await persistResults(args, aggs);
  console.log(`Results: ${out}`);

  const allPassed = aggs.length > 0 && aggs.every((a) => a.passed);
  console.log();
  console.log(allPassed ? 'OVERALL: PASS' : 'OVERALL: FAIL');
  process.exit(allPassed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
