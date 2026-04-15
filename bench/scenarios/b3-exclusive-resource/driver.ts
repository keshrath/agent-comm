// =============================================================================
// Bench Tier B3 — Exclusive resource (comm_state TTL lock).
//
// Models the user's actual daily pattern: N Claude sessions must share one
// singleton resource (playwright instance). Fixture `fake-browser.js` fails
// with "already running" when invoked concurrently (PID-file race with a
// 500ms pre-sleep widening the window).
//
// Conditions:
//   - naive         : withMcp=false, no lock advice — agents race.
//   - resource-lock : withMcp=true, prompt instructs CAS-claim of
//                     comm_state(namespace="locks", key="fake-browser") before
//                     invoking the binary, and delete after.
//
// N=3 parallel agents, sharedDir=true, per-condition prompt via promptForAgent.
//
// Metrics (parsed from workload/invocations.jsonl via verify.js):
//   successes, failures, stomped, pid_file_leaked, wall_seconds, total_cost_usd
//
// PASS criteria:
//   - resource-lock: failures == 0 AND stomped == 0 AND pid_file_leaked == 0
//                    on every replicate (safety invariant for the lock).
//   - naive:         mean(failures + stomped) >= 1 (race is observable —
//                    if the fixture can't produce a race, the scenario is broken).
//
// Cost discipline: --dry-run synthesizes plausible numbers, --real requires
// explicit opt-in and respects a cumulative $--max-cost-usd cap (default $15).
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

type Condition = 'naive' | 'resource-lock';

interface CliArgs {
  dryRun: boolean;
  real: boolean;
  n: number;
  agents: number;
  maxCostUsd: number;
  conditions: Condition[];
}

function parseArgs(argv: string[]): CliArgs {
  const dryRun = argv.includes('--dry-run');
  const real = argv.includes('--real');
  const shared = parseSharedArgs(argv, { n: 1, maxCostUsd: 15 });
  const agentsFlag = argv.find((a) => a.startsWith('--agents='));
  const agentsRaw = agentsFlag ? Number(agentsFlag.split('=')[1]) : 3;
  const agents = Number.isFinite(agentsRaw) && agentsRaw >= 2 ? agentsRaw : 3;
  const condFlag = argv.find((a) => a.startsWith('--conditions='));
  const conditions = (condFlag?.split('=')[1] ?? 'naive,resource-lock')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Condition => s === 'naive' || s === 'resource-lock');
  return {
    dryRun,
    real,
    n: shared.n,
    agents,
    maxCostUsd: shared.maxCostUsd,
    conditions: conditions.length > 0 ? conditions : ['naive', 'resource-lock'],
  };
}

// -----------------------------------------------------------------------------
// Prompts
// -----------------------------------------------------------------------------

const NAIVE_PROMPT_TEMPLATE = (i: number, n: number): string =>
  `You are agent #${i} of ${n} in this shared directory. Your task is simple:

Run the command \`node fake-browser.js\` using the Bash tool. Then report
whatever it printed (stdout and exit status).

The binary takes a screenshot and must finish before you stop.

That's it — just run it and report.`;

const LOCK_PROMPT_TEMPLATE = (i: number, n: number): string =>
  `You are agent #${i} of ${n} in this shared directory. Your task is to run
\`node fake-browser.js\` — BUT the binary is a singleton. If two agents
invoke it concurrently, the second one fails with "already running".

You have access to comm_state (MCP tool). USE IT to serialize access.

PROCEDURE — follow exactly:

1. Claim the lock:
     mcp__agent-comm__comm_state action=cas namespace=locks key=fake-browser
     expected=null new_value="agent-${i}" ttl_seconds=60
   If success=true, you hold the lock — go to step 3.
   If success=false, another agent holds it — go to step 2.

2. Poll for release. Wait ~2 seconds, then try again:
     mcp__agent-comm__comm_state action=cas namespace=locks key=fake-browser
     expected=null new_value="agent-${i}" ttl_seconds=60
   Repeat until success=true (max ~10 tries, back-off 2 seconds between tries).
   If you still can't get it after 10 tries, give up and report "timeout".

3. Run the binary:
     Bash: node fake-browser.js
   Wait for it to finish (it takes ~3 seconds).

4. Release the lock:
     mcp__agent-comm__comm_state action=delete namespace=locks key=fake-browser

5. Report the binary's output.

ABSOLUTE RULE: Do NOT invoke fake-browser.js unless you hold the lock via
the cas call in step 1 or 2. Running it without the lock WILL cause a
"already running" collision and is a FAILURE.`;

function promptForAgent(n: number, cond: Condition) {
  return (i: number): string =>
    cond === 'naive' ? NAIVE_PROMPT_TEMPLATE(i, n) : LOCK_PROMPT_TEMPLATE(i, n);
}

// -----------------------------------------------------------------------------
// Workload dir + verifier output parsing
// -----------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'workload');

interface VerifyState {
  successes: number;
  failures: number;
  stomped: number;
  total_invocations: number;
  pid_file_leaked: boolean;
}

async function readVerifyState(runId: string): Promise<VerifyState> {
  const TMP_ROOT =
    process.env.AGENT_COMM_BENCH_TMP ??
    (process.platform === 'win32' ? 'C:\\tmp\\agent-comm-bench' : '/tmp/agent-comm-bench');
  const sharedDir = path.join(TMP_ROOT, `bench-${runId}`, 'shared');
  const logPath = path.join(sharedDir, 'invocations.jsonl');
  const pidPath = path.join(sharedDir, 'browser.pid');
  const state: VerifyState = {
    successes: 0,
    failures: 0,
    stomped: 0,
    total_invocations: 0,
    pid_file_leaked: false,
  };
  try {
    const raw = await fsp.readFile(logPath, 'utf8');
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let obj: { outcome?: string };
      try {
        obj = JSON.parse(trimmed);
      } catch {
        continue;
      }
      state.total_invocations += 1;
      if (obj.outcome === 'done') state.successes += 1;
      else if (obj.outcome === 'already-running') state.failures += 1;
      else if (obj.outcome === 'done-but-stomped') {
        state.successes += 1;
        state.stomped += 1;
      }
    }
  } catch {
    /* no log — leave zeros */
  }
  state.pid_file_leaked = fs.existsSync(pidPath);
  return state;
}

// -----------------------------------------------------------------------------
// Per-replicate result
// -----------------------------------------------------------------------------

interface RunMetrics {
  successes: number;
  failures: number;
  stomped: number;
  pid_file_leaked: number; // 0 or 1
  total_invocations: number;
  wall_seconds: number;
  total_cost_usd: number;
}

async function runReplicate(cond: Condition, agents: number): Promise<RunMetrics> {
  // The CliDriver's `condition` field is its own enum ('control'|'pipeline-claim'
  // etc). We only need withMcp=true for resource-lock — installHook stays off.
  // Setting condition to 'pipeline-claim' would force the pipelineClaimInstruction
  // in every prompt, which we don't want. Trick: use `control` with a custom
  // promptForAgent, and flip withMcp by using installBashGuard=false but
  // withMcp is internally set when condition==='pipeline-claim' OR installHook
  // OR installBashGuard. None of those fit cleanly for "withMcp only".
  //
  // Workaround: use installBashGuard=true for resource-lock so withMcp flips on.
  // bash-guard warns on git commands (which we don't run), so it's a no-op here
  // apart from boot-time cost. We accept that small overhead; the alternative
  // is forking the driver.
  //
  // For naive: leave installBashGuard=false → withMcp=false (no MCP tools).
  const driver: AgentDriver = makeCliDriver({
    fixtureDir: FIXTURE_DIR,
    testCmd: 'node verify.js',
    maxBudgetUsd: 0.6,
    expectedFiles: ['invocations.jsonl'],
    sharedDir: true,
    installHook: false, // file-coord hook not relevant — we don't Edit shared files
    installBashGuard: cond === 'resource-lock', // toggles withMcp + boots dashboard
    promptForAgent: promptForAgent(agents, cond),
  });
  const task: WorkloadTask = {
    task_id: 'b3-exclusive-resource',
    workload: 'b3-exclusive-resource',
    target: FIXTURE_DIR,
    prompt: 'unused — see promptForAgent',
  };

  const t0 = Date.now();
  const run: MultiAgentRun = await driver.runOnce(task, agents, 'control');
  const wall_ms = run.total_wall_ms;
  const state = await readVerifyState(run.run_id);
  const total_cost_usd = run.agents.reduce((s, a) => s + (a.cost_usd ?? 0), 0);
  void t0; // kept for future hook-trace correlation
  return {
    successes: state.successes,
    failures: state.failures,
    stomped: state.stomped,
    pid_file_leaked: state.pid_file_leaked ? 1 : 0,
    total_invocations: state.total_invocations,
    wall_seconds: wall_ms / 1000,
    total_cost_usd,
  };
}

// -----------------------------------------------------------------------------
// Dry-run synthesis — deterministic per-condition numbers
// -----------------------------------------------------------------------------

function synthesizeReplicate(cond: Condition, seed: number): RunMetrics {
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  if (cond === 'resource-lock') {
    // Lock serializes: all 3 agents finish, no races, no leak.
    return {
      successes: 3,
      failures: 0,
      stomped: 0,
      pid_file_leaked: 0,
      total_invocations: 3,
      wall_seconds: 28 + rand() * 6, // serialized ~9s/agent + Claude overhead
      total_cost_usd: 0.9 + rand() * 0.2,
    };
  }
  // Naive: 3 agents race. Typical outcome — first one to check beats the
  // pre-sleep window, one or two collide.
  const failures = 1 + (rand() < 0.3 ? 1 : 0);
  const stomped = rand() < 0.4 ? 1 : 0;
  const successes = 3 - failures;
  return {
    successes,
    failures,
    stomped,
    pid_file_leaked: rand() < 0.2 ? 1 : 0,
    total_invocations: 3 + stomped, // stomped logs an extra line
    wall_seconds: 12 + rand() * 4,
    total_cost_usd: 0.25 + rand() * 0.1,
  };
}

// -----------------------------------------------------------------------------
// Aggregation + PASS/FAIL
// -----------------------------------------------------------------------------

interface CondAggregate {
  condition: Condition;
  n: number;
  per_run: RunMetrics[];
  successes: Stats;
  failures: Stats;
  stomped: Stats;
  pid_file_leaked: Stats;
  wall_seconds: Stats;
  total_cost_usd: Stats;
  passed: boolean;
  failure_reason?: string;
  stopped_early?: boolean;
  stop_reason?: string;
}

function aggregate(condition: Condition, runs: RunMetrics[]): CondAggregate {
  const successes = runs.map((r) => r.successes);
  const failures = runs.map((r) => r.failures);
  const stomped = runs.map((r) => r.stomped);
  const leaked = runs.map((r) => r.pid_file_leaked);
  const wall = runs.map((r) => r.wall_seconds);
  const cost = runs.map((r) => r.total_cost_usd);

  let passed: boolean;
  let failure_reason: string | undefined;
  if (runs.length === 0) {
    passed = false;
    failure_reason = 'no replicates completed';
  } else if (condition === 'resource-lock') {
    const badRun = runs.find((r) => r.failures > 0 || r.stomped > 0 || r.pid_file_leaked > 0);
    passed = !badRun;
    if (badRun) {
      failure_reason = `resource-lock had races — failures=${badRun.failures} stomped=${badRun.stomped} pid_leaked=${badRun.pid_file_leaked} (safety invariant: all must be 0)`;
    }
  } else {
    // naive — expect observable races on the mean.
    const combined = runs.map((r) => r.failures + r.stomped);
    const stats = statsOf(combined);
    passed = stats.mean >= 1;
    if (!passed) {
      failure_reason = `naive mean(failures+stomped)=${stats.mean.toFixed(2)} < 1 (fixture not contending — widen race window)`;
    }
  }

  return {
    condition,
    n: runs.length,
    per_run: runs,
    successes: statsOf(successes),
    failures: statsOf(failures),
    stomped: statsOf(stomped),
    pid_file_leaked: statsOf(leaked),
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
    `    successes            ${fmt(a.successes, 2)}  (per-run: ${perRun((r) => r.successes)})`,
    `    failures             ${fmt(a.failures, 2)}  (per-run: ${perRun((r) => r.failures)})`,
    `    stomped              ${fmt(a.stomped, 2)}  (per-run: ${perRun((r) => r.stomped)})`,
    `    pid_file_leaked      ${fmt(a.pid_file_leaked, 2)}  (per-run: ${perRun((r) => r.pid_file_leaked)})`,
    `    wall_seconds         ${fmt(a.wall_seconds, 1)}`,
    `    total_cost_usd       $${fmt(a.total_cost_usd, 3)}`,
  ];
  if (a.failure_reason) lines.push(`    reason               ${a.failure_reason}`);
  if (a.stopped_early) lines.push(`    stopped_early        ${a.stop_reason ?? 'yes'}`);
  return lines.join('\n');
}

// -----------------------------------------------------------------------------
// Persist
// -----------------------------------------------------------------------------

async function persistResults(args: CliArgs, aggs: CondAggregate[]): Promise<string> {
  const outDir = path.resolve('bench/_results');
  await fsp.mkdir(outDir, { recursive: true });
  const fname = `b3-exclusive-resource-${args.dryRun ? 'dryrun-' : ''}${Date.now()}.json`;
  const out = path.join(outDir, fname);
  await fsp.writeFile(
    out,
    JSON.stringify(
      {
        scenario: 'b3-exclusive-resource',
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
      'usage: tsx bench/scenarios/b3-exclusive-resource/driver.ts [--dry-run|--real] [--n=1] [--agents=3] [--max-cost-usd=12] [--conditions=naive,resource-lock]',
    );
    process.exit(2);
  }

  if (!fs.existsSync(FIXTURE_DIR) || !fs.existsSync(path.join(FIXTURE_DIR, 'fake-browser.js'))) {
    console.error(`error: fixture missing at ${FIXTURE_DIR}`);
    process.exit(2);
  }

  const mode = args.dryRun ? 'DRY-RUN (synthetic)' : 'REAL';
  console.log(`=== Bench Tier B3 — Exclusive resource (${mode}) ===`);
  console.log(
    `    n=${args.n} per condition   agents=${args.agents}   conditions=${args.conditions.join(',')}   max-cost-usd=$${args.maxCostUsd}`,
  );
  console.log(
    `    workload: ${args.agents} agents invoke singleton fake-browser.js concurrently; PID-file race with 500ms window`,
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
      label: `b9:${condition}`,
      run: async (rep) => {
        const r = args.dryRun
          ? synthesizeReplicate(condition, 0xb9 ^ (condition === 'resource-lock' ? 0x100 : 0) ^ rep)
          : await runReplicate(condition, args.agents);
        console.log(
          `    [${condition} #${rep}/${args.n}] succ=${r.successes} fail=${r.failures} stomped=${r.stomped} leaked=${r.pid_file_leaked} wall=${r.wall_seconds.toFixed(1)}s cost=$${r.total_cost_usd.toFixed(3)}`,
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
