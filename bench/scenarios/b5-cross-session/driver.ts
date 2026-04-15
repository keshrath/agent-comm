// =============================================================================
// Bench Tier B5 — Cross-session persistence.
//
// Tests whether comm_state provides cross-process task handoff when a session
// dies (or exits) mid-work. Two sequential agents run ONE AFTER THE OTHER in
// SEPARATE per-agent working dirs (agentA cannot see agentB's files and vice
// versa); each capped at AT MOST 2 tasks from a list of 4. The only coord
// channel available in the with-state condition is comm_state persisted by
// the driver across the pair of spawns.
//
// Why per-agent dirs (v1.3.9 retry): the original shared-dir fixture let
// agentB filesystem-observe agentA's `report-task-*.md` and dedup without
// comm_state — making the no-state condition artificially clean and
// destroying the contrast vs with-state. With per-agent dirs B only sees an
// un-modified queue.json and writes to a dir A never touched.
//
// Conditions:
//   no-state   — withMcp=false. Queue lives in a plain queue.json file. B
//                cannot see A's reports (different dir) and has no comm_state
//                to consult, so B re-picks the first 2 pending tasks from
//                queue.json — the SAME 2 tasks A picked. => 2 unique across
//                the union of both dirs, 2 duplicate work entries.
//   with-state — withMcp=true + sequentialAgents=true. Pre-seeded comm_state
//                namespace `bench-q-<runId>` with 4 keys = "pending". The
//                driver reuses the seedCtx + dashboard across both agents,
//                so comm_state PERSISTS from A to B. Agents CAS-claim
//                (expected="pending" new_value=agentId), complete, then set
//                value="done". AgentB sees 2 entries already "done" and
//                claims the other 2. => 4 unique, 0 duplicates.
//
// Metrics per replicate (parsed from verify.js output on shared dir):
//   unique_reports        — distinct report-<id>.md files with content (max 4)
//   duplicate_work_count  — tasks where >1 agent logged a work event
//   tasks_by_A, tasks_by_B — work events per agent from claims.jsonl
//   wall_seconds, total_cost_usd
//
// PASS criteria:
//   with-state : duplicate_work_count == 0 on EVERY replicate AND mean
//                unique_reports == 4  (safety invariant + progress).
//   no-state   : mean duplicate_work_count > 0 (fixture is adversarial;
//                without state, B cannot know what A did).
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

type Condition = 'no-state' | 'with-state';

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
  const conditions = (condFlag?.split('=')[1] ?? 'no-state,with-state')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Condition => s === 'no-state' || s === 'with-state');
  return {
    dryRun,
    real,
    n: shared.n,
    maxCostUsd: shared.maxCostUsd,
    conditions: conditions.length > 0 ? conditions : ['no-state', 'with-state'],
  };
}

// -----------------------------------------------------------------------------
// Workload constants
// -----------------------------------------------------------------------------

const TASK_IDS = ['task-1', 'task-2', 'task-3', 'task-4'] as const;
const N_AGENTS = 2; // sequential: agentA then agentB

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'workload');

const TASKS_HUMAN = TASK_IDS.join(', ');

// -----------------------------------------------------------------------------
// Prompts
//
// The driver spawns 2 agents as a0 and a1. We map a0 -> agentA, a1 -> agentB.
// In the retry fixture, each agent runs in its OWN working dir — so agent B
// CANNOT see A's report files. The only possible coordination channel in the
// with-state condition is comm_state.
// -----------------------------------------------------------------------------

function noStatePromptForAgent(i: number): string {
  const name = i === 0 ? 'agentA' : 'agentB';
  return [
    `You are worker "${name}". You run in a PRIVATE working directory — agentA`,
    `runs first and exits; agentB runs second in a fresh process in a DIFFERENT`,
    `directory. You CANNOT see any files agentA wrote, and agentA cannot see`,
    `anything you write. You also have NO access to any MCP tools. Coordinate`,
    `only via files and bash inside your own directory.`,
    ``,
    `LOCAL STATE in this directory (freshly copied from the fixture):`,
    `  queue.json     — list of ${TASK_IDS.length} work items (${TASKS_HUMAN}) ALL with status "pending". READ-ONLY — DO NOT MODIFY.`,
    `  claims.jsonl   — append-only log. Append one line per task you work on:`,
    `                   {"event":"work","agent":"${name}","task":"<task-id>","ts":"<iso>"}`,
    `  report-<id>.md — your output files, one per task you do.`,
    ``,
    `GOAL: work on AT MOST 2 items whose status is "pending" in queue.json.`,
    `Pick the FIRST 2 pending items in order (task-1 then task-2). Do NOT`,
    `modify queue.json. For each item you work on:`,
    ``,
    `  1. Append a line to claims.jsonl (via bash \`echo ... >> claims.jsonl\`):`,
    `       {"event":"work","agent":"${name}","task":"<task-id>","ts":"<iso>"}`,
    `  2. Write report-<task-id>.md with this EXACT first line:`,
    `       # report — written by ${name}`,
    `     followed by 3-4 sentences summarizing the item's "title" field.`,
    ``,
    `STRICT LIMIT: do NOT start a third task even if more are pending. After`,
    `2 reports (or fewer, if fewer are pending), exit.`,
    ``,
    `Run \`node verify.js\` once you are done so the harness can record results.`,
  ].join('\n');
}

function withStatePromptForAgent(i: number): string {
  const name = i === 0 ? 'agentA' : 'agentB';
  // The driver appends pipelineClaimInstruction automatically (see cli.ts)
  // which references the queue namespace. We still describe the full B14
  // procedure in the body so the cap-at-2 rule is explicit.
  return [
    `You are worker "${name}". You run in a PRIVATE working directory — agentA`,
    `runs first and exits; agentB runs second in a fresh process in a DIFFERENT`,
    `directory. You CANNOT see agentA's files and A cannot see yours. However,`,
    `the authoritative work queue is in comm_state (keys below); it PERSISTS`,
    `across the two processes, so agentB WILL see whatever agentA marked done`,
    `via CAS — that's the ONLY handoff channel between you.`,
    ``,
    `LOCAL STATE in this directory (freshly copied from the fixture):`,
    `  queue.json     — informational titles only (task-1..task-4). READ for`,
    `                   the "title" field when writing your report. DO NOT edit.`,
    `  claims.jsonl   — append-only log. Append one line per task you work on:`,
    `                   {"event":"work","agent":"${name}","task":"<task-id>","ts":"<iso>"}`,
    `  report-<id>.md — your output files, one per task you successfully claim.`,
    ``,
    `CLAIM PROTOCOL — use the comm_state MCP tool. The namespace is given in`,
    `the instructions appended below. For each task-id in order (${TASKS_HUMAN}),`,
    `up to AT MOST 2 successful claims:`,
    ``,
    `  1. Attempt CAS:`,
    `       mcp__agent-comm__comm_state`,
    `         action="cas"`,
    `         namespace=<ns from below>`,
    `         key=<task-id>`,
    `         expected="pending"`,
    `         new_value="${name}"`,
    `  2. If swapped=false, the key is no longer "pending" (either another`,
    `     agent won it or it is already "done"). Move to the next task-id.`,
    `  3. If swapped=true (YOU WON):`,
    `     a. Append a work event to claims.jsonl via bash:`,
    `          echo '{"event":"work","agent":"${name}","task":"<task-id>","ts":"<iso>"}' >> claims.jsonl`,
    `     b. Read queue.json, locate this task's "title" field, and write`,
    `        report-<task-id>.md starting with this EXACT first line:`,
    `          # report — written by ${name}`,
    `        followed by 3-4 sentences summarizing the title.`,
    `     c. Mark the key done:`,
    `          mcp__agent-comm__comm_state action="set" namespace=<ns> key=<task-id> value="done"`,
    `  4. Stop after 2 successful claims. Do NOT attempt a third — exit.`,
    ``,
    `ABSOLUTE RULE: never write report-<id>.md for a task you did not win via`,
    `CAS (expected="pending"). If CAS returned swapped=false for every task`,
    `you tried, exit without writing anything.`,
    ``,
    `Run \`node verify.js\` once you are done so the harness can record results.`,
  ].join('\n');
}

// -----------------------------------------------------------------------------
// Run-level metrics extracted from the shared run dir.
// -----------------------------------------------------------------------------

interface RunMetrics {
  unique_reports: number;
  duplicate_work_count: number;
  tasks_by_A: number;
  tasks_by_B: number;
  wall_seconds: number;
  total_cost_usd: number;
}

interface CondAggregate {
  condition: Condition;
  n: number;
  per_run: RunMetrics[];
  unique_reports: Stats;
  duplicate_work_count: Stats;
  tasks_by_A: Stats;
  tasks_by_B: Stats;
  wall_seconds: Stats;
  total_cost_usd: Stats;
  passed: boolean;
  failure_reason?: string;
  stopped_early?: boolean;
  stop_reason?: string;
}

interface ReadState {
  unique: number;
  duplicates: number;
  byA: number;
  byB: number;
}

async function readRunState(runId: string): Promise<ReadState> {
  const TMP_ROOT =
    process.env.AGENT_COMM_BENCH_TMP ??
    (process.platform === 'win32' ? 'C:\\tmp\\agent-comm-bench' : '/tmp/agent-comm-bench');
  const runRoot = path.join(TMP_ROOT, `bench-${runId}`);
  // Per-agent dir layout (retry fixture): runRoot/a0/ (agentA), runRoot/a1/
  // (agentB). Aggregate across both. `unique` is the size of the UNION of
  // non-empty report files written by either side; `duplicates` is the count
  // of filenames BOTH sides wrote (i.e. the same task done twice).
  const AGENT_DIRS: Array<{ dir: string; name: 'agentA' | 'agentB' }> = [
    { dir: path.join(runRoot, 'a0'), name: 'agentA' },
    { dir: path.join(runRoot, 'a1'), name: 'agentB' },
  ];

  const reportsByTask = new Map<string, Set<'agentA' | 'agentB'>>();
  for (const { dir, name } of AGENT_DIRS) {
    for (const id of TASK_IDS) {
      try {
        const content = await fsp.readFile(path.join(dir, `report-${id}.md`), 'utf8');
        if (content.trim().length > 0) {
          if (!reportsByTask.has(id)) reportsByTask.set(id, new Set());
          reportsByTask.get(id)!.add(name);
        }
      } catch {
        /* missing */
      }
    }
  }
  const unique = reportsByTask.size; // union of filenames

  // Work events: read each agent's private claims.jsonl. Because the dirs
  // are isolated, each file only contains its own agent's events.
  let byA = 0;
  let byB = 0;
  const taskWorkers = new Map<string, Set<string>>();
  for (const { dir } of AGENT_DIRS) {
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(dir, 'claims.jsonl'), 'utf8');
    } catch {
      continue;
    }
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as {
          event?: string;
          agent?: string;
          task?: string;
        };
        if (obj.event !== 'work') continue;
        if (typeof obj.agent !== 'string' || typeof obj.task !== 'string') continue;
        if (!(TASK_IDS as readonly string[]).includes(obj.task)) continue;
        if (!taskWorkers.has(obj.task)) taskWorkers.set(obj.task, new Set());
        taskWorkers.get(obj.task)!.add(obj.agent);
        if (obj.agent === 'agentA') byA += 1;
        else if (obj.agent === 'agentB') byB += 1;
      } catch {
        /* skip malformed */
      }
    }
  }

  // Duplicate work = tasks that appear in BOTH agents' report files OR in
  // both claims logs. We compute via both sources and take the max, since a
  // flaky agent might write the report but skip the claims.jsonl append (or
  // vice versa) — either symptom is a real duplicate.
  let duplicatesFromClaims = 0;
  for (const workers of taskWorkers.values()) {
    if (workers.size > 1) duplicatesFromClaims += workers.size - 1;
  }
  let duplicatesFromReports = 0;
  for (const agents of reportsByTask.values()) {
    if (agents.size > 1) duplicatesFromReports += agents.size - 1;
  }
  const duplicates = Math.max(duplicatesFromClaims, duplicatesFromReports);
  return { unique, duplicates, byA, byB };
}

// -----------------------------------------------------------------------------
// Real-run driver — spawn ONE replicate of one condition (2 sequential agents).
// -----------------------------------------------------------------------------

async function runReplicate(condition: Condition): Promise<RunMetrics> {
  const promptForAgent = condition === 'no-state' ? noStatePromptForAgent : withStatePromptForAgent;
  const driverCondition: 'pipeline-claim' | 'control' =
    condition === 'with-state' ? 'pipeline-claim' : 'control';

  const driver: AgentDriver = makeCliDriver({
    fixtureDir: FIXTURE_DIR,
    testCmd: 'node verify.js',
    maxBudgetUsd: 1.5,
    expectedFiles: [...TASK_IDS], // seeded into comm_state when pipeline-claim
    sharedDir: true,
    sequentialAgents: true, // agentA then agentB, shared comm_state DB
    // retry fixture: per-agent working dirs so B cannot filesystem-observe
    // A's report files. comm_state is the ONLY handoff channel between them.
    perAgentDirsInSequential: true,
    promptForAgent,
  });

  const task: WorkloadTask = {
    task_id: 'b5-cross-session',
    workload: 'b5-cross-session',
    target: FIXTURE_DIR,
    prompt: 'unused — see promptForAgent',
  };

  const run: MultiAgentRun = await driver.runOnce(task, N_AGENTS, driverCondition);
  const state = await readRunState(run.run_id);
  const total_cost_usd = run.agents.reduce((s, a) => s + (a.cost_usd ?? 0), 0);

  return {
    unique_reports: state.unique,
    duplicate_work_count: state.duplicates,
    tasks_by_A: state.byA,
    tasks_by_B: state.byB,
    wall_seconds: run.total_wall_ms / 1000,
    total_cost_usd,
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
  if (condition === 'with-state') {
    // CAS serializes: A claims task-1 + task-2 then exits; B sees them "done"
    // and claims task-3 + task-4. 4 unique reports, 0 duplicates.
    return {
      unique_reports: TASK_IDS.length,
      duplicate_work_count: 0,
      tasks_by_A: 2,
      tasks_by_B: 2,
      wall_seconds: 90 + rand() * 40,
      total_cost_usd: 0.6 + rand() * 0.3,
    };
  }
  // no-state (retry fixture): A does first 2 in its own dir. B spawns in a
  // DIFFERENT dir with a fresh queue.json (all pending) and no sight of A's
  // output. B picks the same first 2 items. Union of filenames = 2; both
  // wrote task-1 and task-2 so duplicates = 2.
  void rand();
  return {
    unique_reports: 2,
    duplicate_work_count: 2,
    tasks_by_A: 2,
    tasks_by_B: 2,
    wall_seconds: 80 + rand() * 30,
    total_cost_usd: 0.45 + rand() * 0.25,
  };
}

// -----------------------------------------------------------------------------
// Aggregation + PASS/FAIL
// -----------------------------------------------------------------------------

function aggregate(condition: Condition, runs: RunMetrics[]): CondAggregate {
  const unique = runs.map((r) => r.unique_reports);
  const dup = runs.map((r) => r.duplicate_work_count);
  const byA = runs.map((r) => r.tasks_by_A);
  const byB = runs.map((r) => r.tasks_by_B);
  const wall = runs.map((r) => r.wall_seconds);
  const cost = runs.map((r) => r.total_cost_usd);

  let passed: boolean;
  let failure_reason: string | undefined;
  if (runs.length === 0) {
    passed = false;
    failure_reason = 'no replicates completed';
  } else if (condition === 'with-state') {
    // Safety invariant: CAS must yield zero duplicates every replicate AND
    // the team must collectively complete all 4 tasks on the mean.
    const noDup = dup.every((x) => x === 0);
    const uniqueStats = statsOf(unique);
    passed = noDup && uniqueStats.mean === TASK_IDS.length;
    if (!noDup) {
      failure_reason = `with-state produced DUPLICATE work: max=${Math.max(...dup)} (safety invariant: must be 0 on every replicate)`;
    } else if (!passed) {
      failure_reason = `with-state unique_reports mean=${uniqueStats.mean.toFixed(2)} != ${TASK_IDS.length} (progress invariant — agents should cover all tasks)`;
    }
  } else {
    // no-state: expect observable duplication on mean. Fixture is adversarial
    // by design (same prompt text for B, same queue.json in pending state).
    const stats = statsOf(dup);
    passed = stats.mean > 0;
    if (!passed) {
      failure_reason = `no-state duplicate_work_count mean=${stats.mean.toFixed(2)} <= 0 (expected duplication — fixture may not be adversarial enough)`;
    }
  }

  return {
    condition,
    n: runs.length,
    per_run: runs,
    unique_reports: statsOf(unique),
    duplicate_work_count: statsOf(dup),
    tasks_by_A: statsOf(byA),
    tasks_by_B: statsOf(byB),
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
  const uniqueVals = a.per_run.map((r) => String(r.unique_reports)).join(', ');
  const dupVals = a.per_run.map((r) => String(r.duplicate_work_count)).join(', ');
  const byAVals = a.per_run.map((r) => String(r.tasks_by_A)).join(', ');
  const byBVals = a.per_run.map((r) => String(r.tasks_by_B)).join(', ');
  const lines = [
    `  --- ${a.condition} (n=${a.n}) [${verdict}] ---`,
    `    unique_reports        ${fmt(a.unique_reports, 2)}  (per-run: ${uniqueVals})`,
    `    duplicate_work_count  ${fmt(a.duplicate_work_count, 2)}  (per-run: ${dupVals})`,
    `    tasks_by_A            ${fmt(a.tasks_by_A, 2)}  (per-run: ${byAVals})`,
    `    tasks_by_B            ${fmt(a.tasks_by_B, 2)}  (per-run: ${byBVals})`,
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
  const fname = `b5-cross-session-${args.dryRun ? 'dryrun-' : ''}${Date.now()}.json`;
  const out = path.join(outDir, fname);
  await fsp.writeFile(
    out,
    JSON.stringify(
      {
        scenario: 'b5-cross-session',
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
      'usage: tsx bench/scenarios/b5-cross-session/driver.ts [--dry-run|--real] [--n=3] [--max-cost-usd=15] [--conditions=no-state,with-state]',
    );
    process.exit(2);
  }

  if (!fs.existsSync(FIXTURE_DIR) || !fs.existsSync(path.join(FIXTURE_DIR, 'queue.json'))) {
    console.error(`error: fixture missing at ${FIXTURE_DIR}`);
    process.exit(2);
  }

  const mode = args.dryRun ? 'DRY-RUN (synthetic)' : 'REAL';
  console.log(`=== Bench Tier B5 — Cross-session persistence (${mode}) ===`);
  console.log(
    `    n=${args.n} per condition   conditions=${args.conditions.join(',')}   max-cost-usd=$${args.maxCostUsd}`,
  );
  console.log(
    `    workload: 2 SEQUENTIAL agents (agentA then agentB); each capped at AT MOST 2 of ${TASK_IDS.length} tasks (${TASKS_HUMAN})`,
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
      label: `b14:${condition}`,
      run: async (rep) => {
        const r = args.dryRun
          ? synthesizeReplicate(condition, 0xb14 ^ (condition === 'with-state' ? 0x100 : 0) ^ rep)
          : await runReplicate(condition);
        console.log(
          `    [${condition} #${rep}/${args.n}] unique=${r.unique_reports}/${TASK_IDS.length} dup=${r.duplicate_work_count} A=${r.tasks_by_A} B=${r.tasks_by_B} wall=${r.wall_seconds.toFixed(1)}s cost=$${r.total_cost_usd.toFixed(3)}`,
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
