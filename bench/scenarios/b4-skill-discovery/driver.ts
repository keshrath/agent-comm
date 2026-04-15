// =============================================================================
// Bench Tier B4 — Skill-based agent discovery.
//
// Does `comm_agents action=discover skill=<id>` pay rent vs coordinators that
// must find the right worker without the skill registry?
//
// Setup: 4 passive worker agents are pre-seeded into the fresh per-run
// agent-comm DB via `preSeedState`. They are fixtures — never spawned, never
// reply. 1 coordinator subagent is spawned through the CliDriver and must
// write the tester's name to `found-agent.txt`.
//
// Conditions:
//   with-discover    — workers registered with human-readable names
//                      (worker-impl, worker-review, worker-test, worker-doc)
//                      AND skill rows (implement/review/test/doc). Prompt tells
//                      the coordinator to call
//                      `comm_agents({action:"discover", skill:"test"})`.
//                      Expected: deterministic hit on worker-test.
//   without-discover — workers registered with OPAQUE names (agent-<hex>)
//                      and NO skills on the registry row. The skill registry
//                      concept is effectively absent. Prompt forbids discover.
//                      Only `list`, inbox, send, broadcast are allowed.
//                      Workers are passive, so broadcasts get no reply.
//                      Coordinator must guess — ~25% random baseline.
//
// Metrics per replicate:
//   found_correct, found_any, discover_used, wall_seconds, total_cost_usd
//
// PASS criteria:
//   with-discover    : found_correct == true on EVERY replicate (3/3).
//   without-discover : mean(found_correct) <= 0.5 (well below 1.0).
//
// Dry-run synthesizes: with-discover 100% correct; without-discover ~25%.
// =============================================================================

import * as path from 'node:path';
import * as fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { makeCliDriver } from '../../drivers/cli.js';
import type { WorkloadTask, AgentDriver } from '../../runner.js';
import type { MultiAgentRun } from '../../metrics.js';
import { runReplicates, statsOf, parseSharedArgs, type Stats } from '../_shared/replicate.js';
import type { AppContext } from '../../../src/lib.js';

// -----------------------------------------------------------------------------
// CLI args
// -----------------------------------------------------------------------------

type Condition = 'with-discover' | 'without-discover';

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
  const conditions = (condFlag?.split('=')[1] ?? 'with-discover,without-discover')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Condition => s === 'with-discover' || s === 'without-discover');
  return {
    dryRun,
    real,
    n: shared.n,
    maxCostUsd: shared.maxCostUsd,
    conditions: conditions.length > 0 ? conditions : ['with-discover', 'without-discover'],
  };
}

// -----------------------------------------------------------------------------
// Scenario constants
// -----------------------------------------------------------------------------

interface WorkerSpec {
  readonly slot: 'impl' | 'review' | 'test' | 'doc';
  readonly skillId: string;
  readonly skillName: string;
  readonly tag: string;
}

const WORKERS: readonly WorkerSpec[] = [
  { slot: 'impl', skillId: 'implement', skillName: 'Implementation', tag: 'code' },
  { slot: 'review', skillId: 'review', skillName: 'Code Review', tag: 'code' },
  { slot: 'test', skillId: 'test', skillName: 'Testing', tag: 'verify' },
  { slot: 'doc', skillId: 'doc', skillName: 'Documentation', tag: 'docs' },
];

// The coordinator must find the tester — skill id "test". Kept implicit in
// the prompt + assignWorkers below so it isn't drift-prone across places.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'workload');

// -----------------------------------------------------------------------------
// Per-replicate worker assignment.
//
// with-discover    : names are fixed human-readable (`worker-<slot>`) and the
//                    registry row carries skills.
// without-discover : names are opaque (`agent-<hex>`) and the registry row
//                    carries NO skills — the coordinator has nothing to filter
//                    on except the 4 opaque strings.
// -----------------------------------------------------------------------------

interface AssignedWorker {
  registryName: string;
  skillId: string;
  skillName: string;
  tag: string;
  slot: WorkerSpec['slot'];
}

function assignWorkers(cond: Condition, runId: string): AssignedWorker[] {
  // Both conditions scope names + skill ids per runId. agent-comm's default
  // DB lives at ~/.agent-comm/agent-comm.db and is shared across bench
  // replicates (the driver's seedCtx doesn't override the path), so reusing
  // a stable "worker-test" name from one replicate to the next hits a
  // ConflictError on re-register. Per-run suffix makes the registration
  // collision-free AND isolates skill-id matching from any agents other
  // sessions happen to have left behind.
  const seedBase = hashString(runId);
  const runTag = toHex(seedBase, 5);
  if (cond === 'with-discover') {
    return WORKERS.map((w) => ({
      registryName: `worker-${w.slot}-${runTag}`,
      skillId: `${w.skillId}-${runTag}`,
      skillName: w.skillName,
      tag: `${w.tag}-${runTag}`,
      slot: w.slot,
    }));
  }
  // without-discover: opaque names, run-scoped, deterministic per runId.
  return WORKERS.map((w, i) => ({
    registryName: `agent-${toHex(seedBase + i * 0x9e3779b1, 5)}-${runTag}`,
    skillId: `${w.skillId}-${runTag}`, // not used by prompt but kept for schema symmetry
    skillName: w.skillName,
    tag: `${w.tag}-${runTag}`,
    slot: w.slot,
  }));
}

function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

function toHex(n: number, len: number): string {
  return (n >>> 0).toString(16).padStart(8, '0').slice(0, len);
}

// -----------------------------------------------------------------------------
// Prompts
// -----------------------------------------------------------------------------

function promptWithDiscover(testerSkillId: string): string {
  return [
    `You are the COORDINATOR. There are 4 worker agents registered in the`,
    `agent-comm registry, each with a distinct run-scoped skill id:`,
    ``,
    `  - implement-<run>  (tag: code-<run>)`,
    `  - review-<run>     (tag: code-<run>)`,
    `  - ${testerSkillId}  (tag: verify-<run>)   <-- the TESTER`,
    `  - doc-<run>        (tag: docs-<run>)`,
    ``,
    `YOUR TASK: find the worker agent whose skill id is "${testerSkillId}"`,
    `and write that agent's NAME (the "name" field of the agent record,`,
    `not its UUID) on the first line of a file called "found-agent.txt"`,
    `in the current directory.`,
    ``,
    `HOW: use the agent-comm MCP tool with the "discover" action and the`,
    `skill parameter set to the exact tester skill id:`,
    ``,
    `  mcp__agent-comm__comm_agents action="discover" skill="${testerSkillId}"`,
    ``,
    `This returns the single agent whose skill id matches. Read its "name"`,
    `field and write that exact string to found-agent.txt (no quotes, no`,
    `extra whitespace):`,
    ``,
    `  Write tool: path=found-agent.txt content=<the-name>`,
    ``,
    `Do NOT guess. Do NOT pick a name before calling discover. Do NOT use`,
    `action="list" — use action="discover" with the skill parameter.`,
    ``,
    `When found-agent.txt is written, run \`node verify.js\` and exit.`,
  ].join('\n');
}

function promptWithoutDiscover(workers: AssignedWorker[]): string {
  const names = workers.map((w) => w.registryName).join(', ');
  return [
    `You are the COORDINATOR. There are 4 worker agents registered in the`,
    `agent-comm registry. Their names are opaque:`,
    ``,
    `  ${names}`,
    ``,
    `One of them is the TESTER (the agent that does testing). The others do`,
    `implementation, review, or documentation. You do not know which name`,
    `maps to which role — the registry does NOT record skills for these`,
    `agents. No shared file maps names to roles.`,
    ``,
    `YOUR TASK: write the TESTER's name on the first line of`,
    `"found-agent.txt" in the current directory.`,
    ``,
    `CONSTRAINTS:`,
    `  - You can call mcp__agent-comm__comm_agents action="list" — it returns`,
    `    the 4 names above but NO skill information.`,
    `  - You CANNOT use action="discover" — that tool is off-limits for this`,
    `    run. Calling it counts as a FAILURE.`,
    `  - You may call comm_send / comm_broadcast / comm_inbox, but the`,
    `    workers are PASSIVE — they will not reply to messages. Do not wait`,
    `    for a reply longer than ~5 seconds; it will never come.`,
    `  - You cannot read any other metadata or use any other tool to deduce`,
    `    the mapping. There is no mapping to deduce.`,
    ``,
    `Since you have no information, pick one of the 4 names (any one) and`,
    `write it to found-agent.txt:`,
    ``,
    `  echo -n <the-name-you-picked> > found-agent.txt    (or Write tool)`,
    ``,
    `Then run \`node verify.js\` and exit. Do not agonize — a 25% random`,
    `guess is the expected floor for this condition.`,
  ].join('\n');
}

// -----------------------------------------------------------------------------
// Per-replicate result
// -----------------------------------------------------------------------------

interface RunMetrics {
  found_correct: number; // 0 or 1
  found_any: number; // 0 or 1
  discover_used: number; // 0 or 1
  wall_seconds: number;
  total_cost_usd: number;
  target_name: string;
  found_raw: string;
}

// -----------------------------------------------------------------------------
// Real run: driver + preSeed + post-run metric extraction
// -----------------------------------------------------------------------------

async function runReplicate(cond: Condition): Promise<RunMetrics> {
  // Per-run assignment: names and skill ids are run-scoped so replicates
  // don't collide in the shared ~/.agent-comm DB, and so skill-id matches
  // can't accidentally overlap with agents other sessions left around.
  let assigned: AssignedWorker[] = [];
  let targetName = '';
  let targetSkillId = '';

  const driver: AgentDriver = makeCliDriver({
    fixtureDir: FIXTURE_DIR,
    testCmd: 'node verify.js',
    maxBudgetUsd: 1.5,
    expectedFiles: ['found-agent.txt'],
    sharedDir: true,
    installHook: false,
    // installBashGuard toggles withMcp=true in the CliDriver without forcing
    // the pipeline-claim instruction into the prompt. The bash-guard hook is
    // a no-op for our workload (we don't run git / npm install). Same trick
    // used in b3-exclusive-resource.
    installBashGuard: true,
    promptForAgent: (_i) => {
      // promptForAgent is invoked AFTER preSeedState runs, so `assigned`,
      // `targetName`, and `targetSkillId` are populated by then. Verified
      // empirically via the CliDriver's ordering in runOnce (buildPrompt is
      // called just before spawn, which is after the preSeedState callback).
      return cond === 'with-discover'
        ? promptWithDiscover(targetSkillId)
        : promptWithoutDiscover(assigned);
    },
    preSeedState: async ({ runId, seedCtx }) => {
      assigned = assignWorkers(cond, runId);
      const tester = assigned.find((w) => w.slot === 'test');
      if (!tester) throw new Error('b10: no tester assigned');
      targetName = tester.registryName;
      targetSkillId = tester.skillId;
      for (const w of assigned) {
        const skills =
          cond === 'with-discover' ? [{ id: w.skillId, name: w.skillName, tags: [w.tag] }] : [];
        registerWorker(seedCtx, w.registryName, skills);
      }
    },
  });

  const task: WorkloadTask = {
    task_id: 'b4-skill-discovery',
    workload: 'b4-skill-discovery',
    target: FIXTURE_DIR,
    prompt: 'unused — see promptForAgent',
  };

  // Exactly ONE coordinator agent. Workers are fixtures inside the registry.
  const run: MultiAgentRun = await driver.runOnce(task, 1, 'control');

  const { foundRaw, foundCorrect, discoverUsed } = await readRunArtifacts(run.run_id, targetName);
  const total_cost_usd = run.agents.reduce((s, a) => s + (a.cost_usd ?? 0), 0);

  return {
    found_correct: foundCorrect ? 1 : 0,
    found_any: foundRaw.length > 0 ? 1 : 0,
    discover_used: discoverUsed ? 1 : 0,
    wall_seconds: run.total_wall_ms / 1000,
    total_cost_usd,
    target_name: targetName,
    found_raw: foundRaw,
  };
}

function registerWorker(
  seedCtx: AppContext,
  name: string,
  skills: Array<{ id: string; name: string; tags: string[] }>,
): void {
  try {
    seedCtx.agents.register({ name, capabilities: [], skills });
  } catch (err) {
    // Registration uses per-run DB (new file), so collisions shouldn't
    // happen in practice. If they do, surface the error — bench data is
    // worthless if workers aren't in the registry.
    throw new Error(`b10: failed to pre-register worker "${name}": ${(err as Error).message}`, {
      cause: err,
    });
  }
}

async function readRunArtifacts(
  runId: string,
  targetName: string,
): Promise<{ foundRaw: string; foundCorrect: boolean; discoverUsed: boolean }> {
  const TMP_ROOT =
    process.env.AGENT_COMM_BENCH_TMP ??
    (process.platform === 'win32' ? 'C:\\tmp\\agent-comm-bench' : '/tmp/agent-comm-bench');
  const runRoot = path.join(TMP_ROOT, `bench-${runId}`);
  const sharedDir = path.join(runRoot, 'shared');
  const logDir = path.join(runRoot, '_logs');

  let foundRaw = '';
  try {
    const content = await fsp.readFile(path.join(sharedDir, 'found-agent.txt'), 'utf8');
    foundRaw = content.trim().split(/\r?\n/)[0]?.trim() ?? '';
  } catch {
    /* missing */
  }
  const foundCorrect = foundRaw.length > 0 && foundRaw === targetName;

  // discover_used: scan a0_stdout.log for the string "discover" co-located
  // with a comm_agents tool invocation. Claude Code's -p JSON dumps the
  // transcript in the result field for some models; a looser substring match
  // is the safest heuristic across model versions.
  let discoverUsed = false;
  try {
    const stdout = await fsp.readFile(path.join(logDir, 'a0_stdout.log'), 'utf8');
    discoverUsed =
      /"action"\s*:\s*"discover"/i.test(stdout) || /comm_agents.*discover/i.test(stdout);
  } catch {
    /* log missing */
  }

  return { foundRaw, foundCorrect, discoverUsed };
}

// -----------------------------------------------------------------------------
// Dry-run synthesis — deterministic
// -----------------------------------------------------------------------------

function synthesizeReplicate(cond: Condition, seed: number): RunMetrics {
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  if (cond === 'with-discover') {
    return {
      found_correct: 1,
      found_any: 1,
      discover_used: 1,
      wall_seconds: 18 + rand() * 8,
      total_cost_usd: 0.08 + rand() * 0.05,
      target_name: 'worker-test',
      found_raw: 'worker-test',
    };
  }
  // without-discover: ~25% correct (1/4 random)
  const roll = rand();
  const correct = roll < 0.25 ? 1 : 0;
  return {
    found_correct: correct,
    found_any: 1,
    discover_used: 0,
    wall_seconds: 22 + rand() * 10,
    total_cost_usd: 0.09 + rand() * 0.06,
    target_name: 'agent-opaque',
    found_raw: correct ? 'agent-opaque' : 'agent-wrong',
  };
}

// -----------------------------------------------------------------------------
// Aggregation + PASS/FAIL
// -----------------------------------------------------------------------------

interface CondAggregate {
  condition: Condition;
  n: number;
  per_run: RunMetrics[];
  found_correct: Stats;
  found_any: Stats;
  discover_used: Stats;
  wall_seconds: Stats;
  total_cost_usd: Stats;
  passed: boolean;
  failure_reason?: string;
  stopped_early?: boolean;
  stop_reason?: string;
}

function aggregate(cond: Condition, runs: RunMetrics[]): CondAggregate {
  const fc = runs.map((r) => r.found_correct);
  const fa = runs.map((r) => r.found_any);
  const du = runs.map((r) => r.discover_used);
  const wall = runs.map((r) => r.wall_seconds);
  const cost = runs.map((r) => r.total_cost_usd);

  let passed: boolean;
  let failure_reason: string | undefined;
  if (runs.length === 0) {
    passed = false;
    failure_reason = 'no replicates completed';
  } else if (cond === 'with-discover') {
    // Safety invariant: discover must deterministically find the tester.
    passed = fc.every((x) => x === 1);
    if (!passed) {
      const misses = fc.filter((x) => x === 0).length;
      failure_reason = `with-discover missed the tester on ${misses}/${runs.length} replicates (safety invariant: discover must return the correct worker every time)`;
    }
  } else {
    // without-discover: mean correct <= 0.5. 25% random, so mean ~0.25;
    // allow some noise up to 0.5 (one lucky 2/3 replicates still passes).
    const stats = statsOf(fc);
    passed = stats.mean <= 0.5;
    if (!passed) {
      failure_reason = `without-discover mean(found_correct)=${stats.mean.toFixed(2)} > 0.5 — coordinator found the tester more often than random, suggesting an information leak (opaque names may be too suggestive, or list is returning skills)`;
    }
  }

  return {
    condition: cond,
    n: runs.length,
    per_run: runs,
    found_correct: statsOf(fc),
    found_any: statsOf(fa),
    discover_used: statsOf(du),
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
  const perRun = (pick: (r: RunMetrics) => number): string =>
    a.per_run.map((r) => pick(r).toString()).join(', ');
  const lines = [
    `  --- ${a.condition} (n=${a.n}) [${verdict}] ---`,
    `    found_correct       ${fmt(a.found_correct, 2)}  (per-run: ${perRun((r) => r.found_correct)})`,
    `    found_any           ${fmt(a.found_any, 2)}  (per-run: ${perRun((r) => r.found_any)})`,
    `    discover_used       ${fmt(a.discover_used, 2)}  (per-run: ${perRun((r) => r.discover_used)})`,
    `    wall_seconds        ${fmt(a.wall_seconds, 1)}`,
    `    total_cost_usd      $${fmt(a.total_cost_usd, 3)}`,
  ];
  if (a.failure_reason) lines.push(`    reason              ${a.failure_reason}`);
  if (a.stopped_early) lines.push(`    stopped_early       ${a.stop_reason ?? 'yes'}`);
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Persist
// -----------------------------------------------------------------------------

async function persistResults(args: CliArgs, aggs: CondAggregate[]): Promise<string> {
  const outDir = path.resolve('bench/_results');
  await fsp.mkdir(outDir, { recursive: true });
  const fname = `b4-skill-discovery-${args.dryRun ? 'dryrun-' : ''}${Date.now()}.json`;
  const out = path.join(outDir, fname);
  await fsp.writeFile(
    out,
    JSON.stringify(
      {
        scenario: 'b4-skill-discovery',
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
      'usage: tsx bench/scenarios/b4-skill-discovery/driver.ts [--dry-run|--real] [--n=3] [--max-cost-usd=15] [--conditions=with-discover,without-discover]',
    );
    process.exit(2);
  }

  if (!fs.existsSync(FIXTURE_DIR) || !fs.existsSync(path.join(FIXTURE_DIR, 'verify.js'))) {
    console.error(`error: fixture missing at ${FIXTURE_DIR}`);
    process.exit(2);
  }

  const mode = args.dryRun ? 'DRY-RUN (synthetic)' : 'REAL';
  console.log(`=== Bench Tier B4 — Skill-based agent discovery (${mode}) ===`);
  console.log(
    `    n=${args.n} per condition   conditions=${args.conditions.join(',')}   max-cost-usd=$${args.maxCostUsd}`,
  );
  console.log(`    workload: 1 coordinator + 4 passive pre-registered workers; find the tester`);
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
      label: `b10:${condition}`,
      run: async (rep) => {
        const r = args.dryRun
          ? synthesizeReplicate(
              condition,
              0xb10 ^ (condition === 'with-discover' ? 0x100 : 0) ^ rep,
            )
          : await runReplicate(condition);
        console.log(
          `    [${condition} #${rep}/${args.n}] correct=${r.found_correct} any=${r.found_any} discover_used=${r.discover_used} target="${r.target_name}" found="${r.found_raw}" wall=${r.wall_seconds.toFixed(1)}s cost=$${r.total_cost_usd.toFixed(3)}`,
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
