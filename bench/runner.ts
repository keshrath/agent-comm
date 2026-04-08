// =============================================================================
// Benchmark runner skeleton.
//
// Drives a workload through all four experimental cells (control, bus-only,
// bus-and-locks) and prints the aggregated report. The agent driver itself is
// pluggable — see AgentDriver below — so this file stays independent of how
// subagents are actually spawned (Claude Code SDK, child process, etc.).
//
// Wire a real driver in by passing it to runWorkload(). Until then, the
// `mockDriver` produces deterministic synthetic data so the harness can be
// exercised end-to-end without burning tokens.
// =============================================================================

import * as path from 'node:path';
import { aggregate, type MultiAgentRun, type BenchReport } from './metrics.js';
import { makeCliDriver } from './drivers/cli.js';

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
}

export async function runWorkload(opts: RunWorkloadOptions): Promise<BenchReport[]> {
  const conditions = opts.conditions ?? ['control', 'bus-only', 'bus-and-locks'];
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
    reports.push(aggregate(runs));
  }

  return reports;
}

// ---------------------------------------------------------------------------
// Mock driver — deterministic synthetic data for harness smoke-testing
// ---------------------------------------------------------------------------

export const mockDriver: AgentDriver = {
  async runOnce(task, n, condition) {
    // Pretend locks reduce duplication and collisions.
    const collide = condition !== 'bus-and-locks';
    const dupSubgoals = condition === 'control' ? ['add parser', 'fix migration'] : [];

    return {
      run_id: `${task.task_id}-${condition}`,
      workload: task.workload,
      condition,
      total_wall_ms: 1000,
      merged_tests_passed: !collide,
      agents: Array.from({ length: n }, (_, i) => ({
        agent: `a${i}`,
        files_edited: collide ? ['shared.ts'] : [`file-${i}.ts`],
        subgoals: [`unique-${i}`, ...dupSubgoals],
        tokens: 1000,
        wall_ms: 1000,
        tests_passed: !collide,
      })),
    };
  },
};

// ---------------------------------------------------------------------------
// CLI entrypoint — `npm run bench:run`
// ---------------------------------------------------------------------------

function formatReport(r: BenchReport): string {
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  return [
    `  ${r.condition.padEnd(16)} n=${r.n_runs}`,
    `    unique_units           ${r.mean_unique_units.toFixed(1)}`,
    `    wall_seconds           ${r.mean_wall_seconds.toFixed(1)}s`,
    `    total_cost_usd         $${r.mean_total_cost_usd.toFixed(3)}`,
    `    units_per_dollar       ${r.units_per_dollar.toFixed(2)}`,
    `    file_collision_rate    ${pct(r.file_collision_rate)}`,
    `    individual_pass_rate   ${pct(r.individual_pass_rate)}`,
    `    mean_parallelism       ${r.mean_parallelism.toFixed(2)}x`,
  ].join('\n');
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
    console.log('Pass --real to run live Claude Code subagents.');
    return;
  }

  // ----- v6 pilot: algos-12, scale up to make multi-agent's case --------
  // 12 algorithm-tier problems. At N=12 the per-agent fixed overhead amortizes
  // and parallelism should give multi-agent a clear wall-time win over solo
  // (crossover math from v5 says T_impl > 5.75s/function does it; algos-12 is
  // ~6-10s/function and N=12 makes solo serial work dominate).
  const fixtureDir = path.resolve('bench/workloads/algos-12');
  const expectedFiles = [
    'csv-parse.js',
    'format-number.js',
    'word-wrap.js',
    'roman.js',
    'lcs.js',
    'email-validate.js',
    'base64-encode.js',
    'base64-decode.js',
    'balanced-parens.js',
    'runlen-encode.js',
    'roman-from.js',
    'flatten.js',
  ];
  const driver = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.8,
    expectedFiles,
  });

  const task: WorkloadTask = {
    task_id: 'algos-12-pilot',
    workload: 'algos-12',
    target: 'bench/workloads/algos-12',
    prompt:
      'There are 12 TODO functions, each in its own file in this directory: ' +
      expectedFiles.join(', ') +
      '. Each file contains a comment block with the full spec and examples — ' +
      'read it before implementing. Implement as many as you can within your budget. ' +
      'Verify by running `node test.js`. You are running in parallel with other ' +
      'agents on copies of the same fixture; follow any coordination instructions present.',
  };

  // ----- v6: solo vs multi-agent on algos-12 -----------------------------
  // At N=12 functions, the per-agent overhead has more work to amortize against,
  // and parallelism should give multi-agent the wall-time win it lacked at N=6.
  // 1 run per condition for the pilot (~$6); replicate only if the result is
  // clear and we want statistical confidence.
  const N_RUNS = 1;

  const soloDriver = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 1.5,
    expectedFiles,
  });

  console.log(`agent-comm bench (REAL driver) — v6: algos-12, solo vs multi, ${N_RUNS} run/cond`);
  console.log(
    `Solo cap $1.50, multi cap $0.80. Worst case: ${1 * N_RUNS}*$1.50 + ${3 * 3 * N_RUNS}*$0.80 = $${(1 * N_RUNS * 1.5 + 3 * 3 * N_RUNS * 0.8).toFixed(2)}.\n`,
  );

  const soloReports = await runWorkload({
    workload: 'algos-12',
    tasks: [task],
    n_agents: 1,
    driver: soloDriver,
    conditions: ['control'],
    n_runs: N_RUNS,
  });
  const soloReport = { ...soloReports[0], condition: 'control' as const };

  const multiReports = await runWorkload({
    workload: 'algos-12',
    tasks: [task],
    n_agents: 3,
    driver,
    conditions: ['control', 'pipeline-claim'],
    n_runs: N_RUNS,
  });

  console.log('\n=== SOLO (1 agent, $1.50 cap) ===');
  console.log(formatReport(soloReport), '\n');
  console.log('=== MULTI (3 agents, $0.80 cap each) ===');
  for (const r of multiReports) console.log(formatReport(r), '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
