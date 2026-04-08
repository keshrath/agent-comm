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
    `    total_cost_usd         $${r.mean_total_cost_usd.toFixed(3)}`,
    `    units_per_dollar       ${r.units_per_dollar.toFixed(2)}`,
    `    file_collision_rate    ${pct(r.file_collision_rate)}`,
    `    duplicate_subgoal_rate ${pct(r.duplicate_subgoal_rate)}`,
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

  // ----- v3 pilot: algos-6, harder per-unit work --------------------------
  // 6 algorithm-tier problems in 6 files. Each function is a non-trivial
  // implementation that requires real reasoning per case (CSV parsing, Roman
  // numerals, LCS, email validation, number formatting, word wrap). Goal:
  // raise per-function "real work" cost from ~$0.018 (v2 string-utils-6) to
  // $0.05-$0.15, putting us above the v2 crossover threshold of ~$0.0625
  // where locks should start beating duplication.
  const fixtureDir = path.resolve('bench/workloads/algos-6');
  const driver = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.8,
    expectedFiles: [
      'csv-parse.js',
      'format-number.js',
      'word-wrap.js',
      'roman.js',
      'lcs.js',
      'email-validate.js',
    ],
  });

  const task: WorkloadTask = {
    task_id: 'algos-6-pilot',
    workload: 'algos-6',
    target: 'bench/workloads/algos-6',
    prompt:
      'There are 6 TODO functions, each in its own file in this directory: ' +
      'csv-parse.js (parseRow), format-number.js (formatNumber), word-wrap.js ' +
      '(wordWrap), roman.js (toRoman), lcs.js (longestCommonSubstring), ' +
      'email-validate.js (isValidEmail). Each file contains a comment block ' +
      'with the full spec and examples — read it before implementing. Implement ' +
      'as many as you can within your budget. Verify by running `node test.js`. ' +
      'You are running in parallel with other agents on copies of the same fixture; ' +
      'follow any coordination instructions present.',
  };

  const N_RUNS = 2;
  console.log(
    `agent-comm bench (REAL driver) — v4: algos-6, N=3, 3 conditions, ${N_RUNS} runs/cond`,
  );
  console.log(
    `Per-agent budget cap: $0.80. Worst case total: 3*3*${N_RUNS} = ${3 * 3 * N_RUNS} agents × $0.80 = $${(3 * 3 * N_RUNS * 0.8).toFixed(2)}.\n`,
  );

  const reports = await runWorkload({
    workload: 'algos-6',
    tasks: [task],
    n_agents: 3,
    driver,
    conditions: ['control', 'bus-and-locks', 'pipeline-claim'],
    n_runs: N_RUNS,
  });

  for (const r of reports) console.log(formatReport(r), '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
