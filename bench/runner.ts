// =============================================================================
// Bench runner — multi-term-commit regression pilot.
//
// This file runs the `multi-term-commit` regression (bash-guard cross-session
// stability). The broader evaluation suite lives under `bench/scenarios/`:
//
//   - Tier A   unit bench         (bench/unit/,  `npm run bench:unit`)
//   - Tier B1  catastrophe        (bench/scenarios/b1-catastrophe  — bash-guard)
//   - Tier B2  pipeline claim     (bench/scenarios/b2-pipeline-claim — CAS)
//   - Tier B3  exclusive lock     (bench/scenarios/b3-exclusive-resource — TTL locks)
//   - Tier B4  skill discovery    (bench/scenarios/b4-skill-discovery)
//   - Tier B5  cross-session      (bench/scenarios/b5-cross-session — persistence)
//   - Tier B6  urgent pivot       (bench/scenarios/b6-urgent-pivot — messaging)
//
// `npm run bench:run` runs the mock driver (no API spend, harness sanity check).
// `npm run bench:run -- --real` runs the live Claude CLI driver against the
// multi-term-commit regression pilot. Each run writes results to
// `bench/_results/latest.json` (read by the dashboard's `GET /api/bench`).
// =============================================================================

import * as path from 'node:path';
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { aggregate, type MultiAgentRun, type BenchReport } from './metrics.js';
import { makeCliDriver } from './drivers/cli.js';

// ---------------------------------------------------------------------------
// Bench results persistence (read by the dashboard /api/bench endpoint)
// ---------------------------------------------------------------------------

interface PersistedPilot {
  name: string;
  description: string;
  timestamp: string;
  conditions: Array<{ label: string; report: BenchReport }>;
}

interface PersistedResults {
  version: string;
  generated_at: string;
  pilots: PersistedPilot[];
}

const RESULTS_DIR = path.resolve('bench/_results');
const RESULTS_FILE = path.join(RESULTS_DIR, 'latest.json');

function loadResults(): PersistedResults {
  if (!existsSync(RESULTS_FILE)) {
    return { version: '1.3.1', generated_at: new Date().toISOString(), pilots: [] };
  }
  try {
    return JSON.parse(readFileSync(RESULTS_FILE, 'utf8')) as PersistedResults;
  } catch {
    return { version: '1.3.1', generated_at: new Date().toISOString(), pilots: [] };
  }
}

function recordPilot(pilot: PersistedPilot): void {
  mkdirSync(RESULTS_DIR, { recursive: true });
  const all = loadResults();
  // Replace existing pilot with the same name (latest result wins).
  const filtered = all.pilots.filter((p) => p.name !== pilot.name);
  filtered.push(pilot);
  // Sort by name for stable display.
  filtered.sort((a, b) => a.name.localeCompare(b.name));
  const out: PersistedResults = {
    version: '1.3.1',
    generated_at: new Date().toISOString(),
    pilots: filtered,
  };
  writeFileSync(RESULTS_FILE, JSON.stringify(out, null, 2));
}

export interface WorkloadTask {
  task_id: string;
  workload: string;
  // Repo/commit/issue identifier the agents will operate on.
  target: string;
  // Human-language goal handed to each agent.
  prompt: string;
}

export interface AgentDriver {
  /** Run N agents in parallel against a single task in a given condition. */
  runOnce(
    task: WorkloadTask,
    n: number,
    condition: MultiAgentRun['condition'],
  ): Promise<MultiAgentRun>;
}

export interface RunWorkloadOptions {
  workload: string;
  tasks: WorkloadTask[];
  n_agents: number;
  driver: AgentDriver;
  conditions?: MultiAgentRun['condition'][];
  /** Number of times to run each task per condition (for variance). Default 1. */
  n_runs?: number;
  /** Total units the workload expects a fully-successful team to deliver.
   * When set, the report's coverage_fraction = mean_unique_units / expected_units.
   * Pass `null` (or omit) for pilots where coverage doesn't apply. */
  expected_units?: number | null;
}

export async function runWorkload(opts: RunWorkloadOptions): Promise<BenchReport[]> {
  const conditions = opts.conditions ?? ['control'];
  const nRuns = opts.n_runs ?? 1;
  const reports: BenchReport[] = [];

  for (const condition of conditions) {
    const runs: MultiAgentRun[] = [];
    for (const task of opts.tasks) {
      for (let i = 0; i < nRuns; i++) {
        const run = await opts.driver.runOnce(task, opts.n_agents, condition);
        runs.push(run);
      }
    }
    reports.push(aggregate(runs, { expected_units: opts.expected_units ?? null }));
  }

  return reports;
}

// ---------------------------------------------------------------------------
// Mock driver — deterministic synthetic data for harness smoke-testing
// without burning API tokens. Distinguishes by condition so the metric
// pipeline gets non-trivial data to aggregate.
// ---------------------------------------------------------------------------

export const mockDriver: AgentDriver = {
  async runOnce(task, n, condition) {
    // pipeline-claim is the "good" condition; control collides.
    const isCoordinated = condition === 'pipeline-claim';
    return {
      run_id: `${task.task_id}-${condition}`,
      workload: task.workload,
      condition,
      total_wall_ms: 1000,
      merged_tests_passed: isCoordinated,
      agents: Array.from({ length: n }, (_, i) => ({
        agent: `a${i}`,
        files_edited: isCoordinated ? [`file-${i}.ts`] : ['shared.ts'],
        subgoals: [`unique-${i}`, ...(isCoordinated ? [] : ['shared-task'])],
        tokens: 1000,
        wall_ms: 1000,
        tests_passed: isCoordinated,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// CLI entrypoint — `npm run bench:run`
// ---------------------------------------------------------------------------

function formatReport(r: BenchReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  // Coverage line: only printed when the pilot declares expected_units. For
  // pilots where coverage isn't meaningful (multi-term-commit etc.) expected
  // is null and we omit the line entirely rather than print a fake 0%.
  const coverageLine =
    r.expected_units !== null && r.coverage_fraction !== null
      ? [
          `    coverage               ${r.mean_unique_units.toFixed(1)}/${r.expected_units} = ${pct(r.coverage_fraction)}`,
        ]
      : [];
  return [
    `  ${r.condition.padEnd(16)} n=${r.n_runs}`,
    `    unique_units           ${r.mean_unique_units.toFixed(1)}`,
    ...coverageLine,
    `    wall_seconds           ${r.mean_wall_seconds.toFixed(1)}s`,
    `    total_cost_usd         $${r.mean_total_cost_usd.toFixed(3)}`,
    `    units_per_dollar       ${r.units_per_dollar.toFixed(2)}`,
    `    file_collision_rate    ${pct(r.file_collision_rate)}`,
    `    individual_pass_rate   ${pct(r.individual_pass_rate)}`,
    `    mean_parallelism       ${r.mean_parallelism.toFixed(2)}x`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Regression pilot: multi-term-commit — temporal coordination across terminal
// sessions.
// ---------------------------------------------------------------------------
//
// The user's actual real-world pain: Session A in terminal 1 edits two files,
// then walks away. Session B starts in terminal 2 (same project), edits two
// other files, runs `git commit -am "B's work"`. WITHOUT the bash-guard hook,
// B's commit will include A's WIP because `git commit -am` stages all
// modified files. WITH the bash-guard hook, B's commit is BLOCKED with a
// message identifying the holder.
//
// The bench simulates this by spawning two agents SEQUENTIALLY in the same
// shared dir with file-coord installed (so A's edits get recorded). The
// hooked condition adds bash-guard to B; the naive condition does not.
//
// Headline metric: commit_purity = fraction of B's commits that contain ONLY
// B's intended files (baz.js, qux.js). Without bash-guard the commit will
// usually contain all 4 files (including foo.js, bar.js from A) — wrong
// attribution, mixed commit. With bash-guard B is blocked, model reacts,
// either restores A's files or stages selectively.

async function runMultiTerminalCommit(): Promise<void> {
  const fixtureDir = path.resolve('bench/workloads/multi-term');
  const expectedFiles = ['foo.js', 'bar.js', 'baz.js', 'qux.js'];
  const TASKS_BY_AGENT = [
    {
      files: ['foo.js', 'bar.js'],
      label: 'session-A',
      prompt:
        'You are session-A. Implement add(a,b) in foo.js (return a + b) and ' +
        'subtract(a,b) in bar.js (return a - b). DO NOT commit. Just edit ' +
        'the files and stop. Another agent will commit later.',
    },
    {
      files: ['baz.js', 'qux.js'],
      label: 'session-B',
      prompt:
        'You are working on baz.js and qux.js in this directory. Implement ' +
        'multiply(a,b) in baz.js (return a * b) and divide(a,b) in qux.js ' +
        '(return a / b). When done, commit your work with: ' +
        '`git commit -am "baz+qux"`. That is the natural way to commit your changes.',
    },
  ];

  const promptForAgent = (i: number) => TASKS_BY_AGENT[i % TASKS_BY_AGENT.length].prompt;
  const task: WorkloadTask = {
    task_id: 'multi-term-commit-pilot',
    workload: 'multi-term-commit',
    target: fixtureDir,
    prompt: 'unused — see promptForAgent',
  };

  const naive = makeCliDriver({
    fixtureDir,
    testCmd: 'true',
    maxBudgetUsd: 0.6,
    expectedFiles,
    sharedDir: true,
    sequentialAgents: true,
    gitInit: true,
    installHook: true, // file-coord installed so A's edits get recorded
    promptForAgent,
  });
  const hooked = makeCliDriver({
    fixtureDir,
    testCmd: 'true',
    maxBudgetUsd: 0.6,
    expectedFiles,
    sharedDir: true,
    sequentialAgents: true,
    gitInit: true,
    installHook: true,
    installBashGuard: true, // BOTH file-coord AND bash-guard
    promptForAgent,
  });

  console.log('=== multi-term-commit (2 sequential agents, shared git repo) ===');
  const naiveR = (
    await runWorkload({
      workload: 'multi-term-commit',
      tasks: [task],
      n_agents: 2,
      driver: naive,
      conditions: ['control'],
      n_runs: 1,
    })
  )[0];
  const naivePurity = await analyzeMultiTermCommit('naive');
  console.log('  --- naive (no bash-guard) ---');
  console.log(formatReport(naiveR));
  console.log(`    commit_purity          ${naivePurity.purityLabel}`);
  console.log(`    last_commit_files      ${naivePurity.commitFiles.join(', ') || '(no commit)'}`);

  const hookedR = (
    await runWorkload({
      workload: 'multi-term-commit',
      tasks: [task],
      n_agents: 2,
      driver: hooked,
      conditions: ['control'],
      n_runs: 1,
    })
  )[0];
  const hookedPurity = await analyzeMultiTermCommit('hooked');
  console.log('  --- hooked (bash-guard installed) ---');
  console.log(formatReport(hookedR));
  console.log(`    commit_purity          ${hookedPurity.purityLabel}`);
  console.log(`    last_commit_files      ${hookedPurity.commitFiles.join(', ') || '(no commit)'}`);
  console.log();

  recordPilot({
    name: 'multi-term-commit',
    description:
      "2 sequential agents, shared git repo. Session A edits foo+bar (no commit), Session B edits baz+qux and runs `git commit -am`. Naive condition lets B's commit include A's WIP; hooked condition blocks it.",
    timestamp: new Date().toISOString(),
    conditions: [
      {
        label: 'naive',
        report: { ...naiveR, mean_unique_units: naivePurity.purityScore * 2 },
      },
      {
        label: 'hooked',
        report: { ...hookedR, mean_unique_units: hookedPurity.purityScore * 2 },
      },
    ],
  });
}

interface PurityResult {
  commitFiles: string[];
  purityScore: number;
  purityLabel: string;
}

/** Analyze the most recent multi-term-commit run dir and compute B's commit purity. */
async function analyzeMultiTermCommit(condition: string): Promise<PurityResult> {
  // Find the most recent shared dir for this condition. The driver names them
  // bench-multi-term-commit-pilot-control-<timestamp>/shared/.
  const tmpRoot =
    process.env.AGENT_COMM_BENCH_TMP ??
    (process.platform === 'win32' ? 'C:\\tmp\\agent-comm-bench' : '/tmp/agent-comm-bench');
  const dirs = await import('node:fs').then((fs) =>
    fs.readdirSync(tmpRoot, { withFileTypes: true }),
  );
  const matching = dirs
    .filter((d) => d.isDirectory() && d.name.startsWith('bench-multi-term-commit-pilot-control-'))
    .map((d) => path.join(tmpRoot, d.name))
    .sort()
    .reverse();
  if (matching.length === 0) {
    return { commitFiles: [], purityScore: 0, purityLabel: 'no run dir found' };
  }
  const sharedDir = path.join(matching[0], 'shared');
  void condition;

  // Run `git log --pretty=oneline | head -1` then `git show --name-only --format=` on it.
  try {
    const { execSync } = await import('node:child_process');
    const log = execSync('git log --pretty=oneline', {
      cwd: sharedDir,
      encoding: 'utf8',
    }).trim();
    const lines = log.split('\n');
    if (lines.length <= 1) {
      // Only the initial commit — agent B never committed (likely blocked).
      return {
        commitFiles: [],
        purityScore: 0,
        purityLabel: 'B did not commit (blocked or failed)',
      };
    }
    const lastCommit = lines[0].split(' ')[0];
    const files = execSync(`git show --name-only --format= ${lastCommit}`, {
      cwd: sharedDir,
      encoding: 'utf8',
    })
      .trim()
      .split('\n')
      .filter(Boolean);
    // Pure if it contains baz.js and qux.js and NO files from A (foo.js,
    // bar.js). The SUBGOAL_INSTRUCTION driver prompt makes agents write a
    // subgoals.json planning artifact; its presence in B's commit is a
    // harness-side artifact, not a coordination failure, so we ignore it
    // when judging purity.
    const A_FILES = new Set(['foo.js', 'bar.js']);
    const B_FILES = new Set(['baz.js', 'qux.js']);
    const got = new Set(files);
    const hasAllB = [...B_FILES].every((f) => got.has(f));
    const leakedFromA = [...A_FILES].filter((f) => got.has(f));
    const isPure = hasAllB && leakedFromA.length === 0;
    return {
      commitFiles: files,
      purityScore: isPure ? 1 : 0,
      purityLabel: isPure
        ? `PURE (B's commit contains only B's files${got.has('subgoals.json') ? ' + subgoals.json' : ''})`
        : `MIXED (B's commit contains: ${files.join(', ')})`,
    };
  } catch (err) {
    return {
      commitFiles: [],
      purityScore: 0,
      purityLabel: `error analyzing: ${(err as Error).message}`,
    };
  }
}

async function main(): Promise<void> {
  const real = process.argv.includes('--real');

  if (!real) {
    const tasks: WorkloadTask[] = Array.from({ length: 5 }, (_, i) => ({
      task_id: `mock-${i}`,
      workload: 'mock',
      target: 'fixture',
      prompt: 'do the thing',
    }));
    const reports = await runWorkload({
      workload: 'mock',
      tasks,
      n_agents: 4,
      driver: mockDriver,
    });
    console.log('agent-comm bench (mock driver) — workload: mock, N=4\n');
    for (const r of reports) console.log(formatReport(r), '\n');
    console.log('Pass --real to run the multi-term-commit regression pilot.');
    return;
  }

  // Only the multi-term-commit regression pilot remains here. The v2
  // scenarios (B1/B2/B3/unit) live under bench/scenarios/ + bench/unit/
  // and have their own drivers + npm scripts.
  const pilotArg = process.argv.find((a) => a.startsWith('--pilot='))?.split('=')[1];
  const runAll = !pilotArg || pilotArg === 'all';

  if (runAll || pilotArg === 'multi-term' || pilotArg === 'multi-term-commit') {
    await runMultiTerminalCommit();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
