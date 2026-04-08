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
}

export async function runWorkload(opts: RunWorkloadOptions): Promise<BenchReport[]> {
  const conditions = opts.conditions ?? ['control', 'bus-only', 'bus-and-locks'];
  const reports: BenchReport[] = [];

  for (const condition of conditions) {
    const runs: MultiAgentRun[] = [];
    for (const task of opts.tasks) {
      const run = await opts.driver.runOnce(task, opts.n_agents, condition);
      runs.push(run);
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
    `    file_collision_rate    ${pct(r.file_collision_rate)}`,
    `    duplicate_subgoal_rate ${pct(r.duplicate_subgoal_rate)}`,
    `    individual_pass_rate   ${pct(r.individual_pass_rate)}`,
    `    merged_pass_rate       ${pct(r.merged_pass_rate)}`,
    `    mean_token_overhead    ${r.mean_token_overhead.toFixed(2)}x`,
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

  // ----- Real pilot: camel-to-kebab, 2 agents, 2 conditions, 1 run -----
  const fixtureDir = path.resolve('bench/workloads/camel-to-kebab');
  const driver = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.8,
    expectedFiles: ['camel.js', 'kebab.js'],
  });

  const task: WorkloadTask = {
    task_id: 'camel-to-kebab-pilot',
    workload: 'camel-to-kebab',
    target: 'bench/workloads/camel-to-kebab',
    prompt:
      'There are two TODO functions in this directory: camelToKebab in camel.js and ' +
      'kebabToCamel in kebab.js. Implement them and verify by running `node test.js`. ' +
      'You may implement only one if another agent is handling the other.',
  };

  console.log('agent-comm bench (REAL driver) — pilot: camel-to-kebab, N=2, 1 run/cond');
  console.log('Per-agent budget cap: $0.80. Worst case total: $3.20.\n');

  const reports = await runWorkload({
    workload: 'camel-to-kebab',
    tasks: [task],
    n_agents: 2,
    driver,
    conditions: ['control', 'bus-and-locks'],
  });

  for (const r of reports) console.log(formatReport(r), '\n');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
