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

// ---------------------------------------------------------------------------
// Pilot 1: shared-routes — N agents adding routes to one shared file
// ---------------------------------------------------------------------------

async function runSharedRoutes(): Promise<void> {
  const fixtureDir = path.resolve('bench/workloads/shared-routes');
  const RESOURCES = ['users', 'posts', 'comments'];
  const promptForAgent = (i: number): string => {
    const resource = RESOURCES[i % RESOURCES.length];
    return (
      `You are agent #${i} (of 3) editing the SHARED file routes.js in this directory. ` +
      `Other agents are editing the same file in parallel right now. ` +
      `Your assigned resource is "${resource}". ` +
      `Add EXACTLY two route handlers below the AGENTS_ADD_ROUTES_HERE marker:\n` +
      `  addRoute("GET", "/api/${resource}", () => "ok");\n` +
      `  addRoute("POST", "/api/${resource}", () => "ok");\n` +
      `IMPORTANT: do not remove other agents' routes. The test \`node test.js\` passes ` +
      `only when ALL 6 routes (GET+POST for users, posts, comments) are present.`
    );
  };
  const task: WorkloadTask = {
    task_id: 'shared-routes-pilot',
    workload: 'shared-routes',
    target: fixtureDir,
    prompt: 'unused — see promptForAgent',
  };
  const naive = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.5,
    expectedFiles: ['routes.js'],
    sharedDir: true,
    promptForAgent,
  });
  const hooked = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.5,
    expectedFiles: ['routes.js'],
    sharedDir: true,
    installHook: true,
    promptForAgent,
  });

  console.log('=== shared-routes (3 agents adding routes to one file) ===');
  const naiveR = (
    await runWorkload({
      workload: 'shared-routes',
      tasks: [task],
      n_agents: 3,
      driver: naive,
      conditions: ['control'],
      n_runs: 1,
    })
  )[0];
  console.log('  --- naive (no hook) ---');
  console.log(formatReport(naiveR));
  const hookedR = (
    await runWorkload({
      workload: 'shared-routes',
      tasks: [task],
      n_agents: 3,
      driver: hooked,
      conditions: ['control'],
      n_runs: 1,
    })
  )[0];
  console.log('  --- hooked (file-coord PreToolUse hook installed) ---');
  console.log(formatReport(hookedR));
  console.log();
  recordPilot({
    name: 'shared-routes',
    description: '3 agents adding GET+POST routes to one shared routes.js file',
    timestamp: new Date().toISOString(),
    conditions: [
      { label: 'naive', report: naiveR },
      { label: 'hooked', report: hookedR },
    ],
  });
}

// ---------------------------------------------------------------------------
// Pilot 2: lost-update — N agents appending to a shared JSON list
// ---------------------------------------------------------------------------

async function runLostUpdate(): Promise<void> {
  const fixtureDir = path.resolve('bench/workloads/lost-update');
  const NAMES = ['alpha', 'beta', 'gamma'];
  const promptForAgent = (i: number): string => {
    const name = NAMES[i % NAMES.length];
    return (
      `You are agent #${i} (of 3) sharing the file state.json in this directory ` +
      `with two other parallel agents. The file contains {"items": []}. ` +
      `Your task: read state.json, append the string "${name}" to the items array, ` +
      `and write the result back. The end goal is for the final state.json to contain ` +
      `all 3 names ("alpha", "beta", "gamma"). Do not remove other agents' entries — ` +
      `if you see any items already there, preserve them and append yours after. ` +
      `Verify with \`node test.js\` (passes when items.length === 3).`
    );
  };
  const task: WorkloadTask = {
    task_id: 'lost-update-pilot',
    workload: 'lost-update',
    target: fixtureDir,
    prompt: 'unused — see promptForAgent',
  };
  const naive = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.4,
    expectedFiles: ['state.json'],
    sharedDir: true,
    promptForAgent,
  });
  const hooked = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.4,
    expectedFiles: ['state.json'],
    sharedDir: true,
    installHook: true,
    promptForAgent,
  });

  console.log('=== lost-update (3 agents appending to shared state.json) ===');
  const naiveR = (
    await runWorkload({
      workload: 'lost-update',
      tasks: [task],
      n_agents: 3,
      driver: naive,
      conditions: ['control'],
      n_runs: 1,
    })
  )[0];
  console.log('  --- naive (no hook) ---');
  console.log(formatReport(naiveR));
  const hookedR = (
    await runWorkload({
      workload: 'lost-update',
      tasks: [task],
      n_agents: 3,
      driver: hooked,
      conditions: ['control'],
      n_runs: 1,
    })
  )[0];
  console.log('  --- hooked (file-coord PreToolUse hook installed) ---');
  console.log(formatReport(hookedR));
  console.log();
  recordPilot({
    name: 'lost-update',
    description: '3 agents appending to one shared state.json (classic lost-update race)',
    timestamp: new Date().toISOString(),
    conditions: [
      { label: 'naive', report: naiveR },
      { label: 'hooked', report: hookedR },
    ],
  });
}

// ---------------------------------------------------------------------------
// Pilot 3: real-codebase — small TypeScript-style app with interlocking files
// ---------------------------------------------------------------------------

async function runRealCodebase(): Promise<void> {
  const fixtureDir = path.resolve('bench/workloads/real-codebase');
  const TASKS = [
    `Add an "is_active" boolean field to the User type in src/types.js. Update ` +
      `src/user.js createUser to default is_active to true. Update src/db.js findUser to ` +
      `only return users where is_active is true.`,
    `Add input validation to src/user.js createUser: throw new Error("missing name") ` +
      `if name is empty, throw new Error("invalid email") if email does not contain "@".`,
    `Add error logging to src/db.js: in saveUser and findUser, wrap the body in try/catch ` +
      `and console.error("[db]", err.message) before re-throwing.`,
  ];
  const promptForAgent = (i: number): string =>
    `You are agent #${i} (of 3) working on this small Node.js project. Other agents ` +
    `are editing the same files in parallel right now. Your assigned task:\n\n` +
    `  ${TASKS[i % TASKS.length]}\n\n` +
    `Read the files first to understand the structure. Make MINIMAL changes — only ` +
    `what's needed for your task. Other agents are touching some of the same files; ` +
    `do not remove their changes. Run \`node test.js\` to verify the project still ` +
    `works AND your task is complete.`;
  const task: WorkloadTask = {
    task_id: 'real-codebase-pilot',
    workload: 'real-codebase',
    target: fixtureDir,
    prompt: 'unused — see promptForAgent',
  };
  const naive = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.7,
    expectedFiles: ['src/types.js', 'src/db.js', 'src/user.js'],
    sharedDir: true,
    promptForAgent,
  });
  const hooked = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.7,
    expectedFiles: ['src/types.js', 'src/db.js', 'src/user.js'],
    sharedDir: true,
    installHook: true,
    promptForAgent,
  });

  console.log('=== real-codebase (3 agents on a small TS-style project) ===');
  const naiveR = (
    await runWorkload({
      workload: 'real-codebase',
      tasks: [task],
      n_agents: 3,
      driver: naive,
      conditions: ['control'],
      n_runs: 1,
    })
  )[0];
  console.log('  --- naive (no hook) ---');
  console.log(formatReport(naiveR));
  const hookedR = (
    await runWorkload({
      workload: 'real-codebase',
      tasks: [task],
      n_agents: 3,
      driver: hooked,
      conditions: ['control'],
      n_runs: 1,
    })
  )[0];
  console.log('  --- hooked (file-coord PreToolUse hook installed) ---');
  console.log(formatReport(hookedR));
  console.log();
  recordPilot({
    name: 'real-codebase',
    description:
      '3 agents adding interdependent features (type field, validation, logging) to a small Node.js project',
    timestamp: new Date().toISOString(),
    conditions: [
      { label: 'naive', report: naiveR },
      { label: 'hooked', report: hookedR },
    ],
  });
}

// ---------------------------------------------------------------------------
// Pilot 4: async/cross-session handoff — sequential agents share comm_state
// ---------------------------------------------------------------------------

async function runAsyncHandoff(): Promise<void> {
  // Two agents spawned SEQUENTIALLY, sharing a comm_state work queue. Agent A
  // gets a tight budget that lets it finish ~half the work, then exits. Agent B
  // (new process, fresh context) inspects the same comm_state queue and finishes
  // the remaining tasks. Tests that comm_state persistence works across agent
  // process lifetimes — the strongest theoretical use case for agent-comm.
  const fixtureDir = path.resolve('bench/workloads/algos-6');
  const expectedFiles = [
    'csv-parse.js',
    'format-number.js',
    'word-wrap.js',
    'roman.js',
    'lcs.js',
    'email-validate.js',
  ];
  const task: WorkloadTask = {
    task_id: 'async-handoff-pilot',
    workload: 'async-handoff',
    target: fixtureDir,
    prompt:
      'There are 6 TODO functions in this directory. The work queue is in agent-comm ' +
      'state (namespace pre-seeded by the bench driver). Use mcp__agent-comm__comm_state ' +
      "with action='cas' to claim ONE pending task at a time, implement it, mark it done, " +
      'then loop. Implement as many as you can within your budget. Other agents may have ' +
      'already completed some tasks (their state will be "done" — skip those).',
  };
  // Sequential mode = n_runs is the number of agents to run one after another.
  // Each "run" is a single agent. The pipeline-claim condition pre-seeds the
  // queue and uses the same comm_state DB across both runs.
  const driver = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.45,
    expectedFiles,
    sequentialAgents: true,
  });

  console.log('=== async-handoff (2 agents in sequence, sharing comm_state queue) ===');
  const report = (
    await runWorkload({
      workload: 'async-handoff',
      tasks: [task],
      n_agents: 2,
      driver,
      conditions: ['pipeline-claim'],
      n_runs: 1,
    })
  )[0];
  console.log('  --- pipeline-claim (sequential) ---');
  console.log(formatReport(report));
  console.log();
  recordPilot({
    name: 'async-handoff',
    description:
      '2 agents in sequence (not parallel) sharing a comm_state work queue — tests cross-session state continuity',
    timestamp: new Date().toISOString(),
    conditions: [{ label: 'pipeline-claim', report }],
  });
}

// ---------------------------------------------------------------------------
// Pilot 5: workspace-decision — multi agents, multi files, NO assignment
// ---------------------------------------------------------------------------
//
// The test that asks: "can agents in a shared workspace decide who does what
// without explicit pre-assignment?" Naive agents will all grab the same files
// (decision collision). With the file-coord hook, the second agent that tries
// to edit a claimed file gets BLOCKED with the holder's identity, which gives
// it the signal to pick a different file. This tests whether the hook ALONE
// enables decision coordination, without any explicit comm_send messaging.

async function runWorkspaceDecision(): Promise<void> {
  const fixtureDir = path.resolve('bench/workloads/algos-6');
  const expectedFiles = [
    'csv-parse.js',
    'format-number.js',
    'word-wrap.js',
    'roman.js',
    'lcs.js',
    'email-validate.js',
  ];
  // SAME prompt for all agents — no per-agent assignment. Agents must
  // discover via the file system and (if hook is installed) the lock signal
  // who is doing what.
  const promptForAgent = (i: number): string =>
    `You are agent #${i} (of 3) sharing this directory with two other parallel ` +
    `agents. There are 6 TODO functions, each in its own file: ${expectedFiles.join(', ')}. ` +
    `Your goal: implement as many UNIQUE functions as the team can. Pick any 2 ` +
    `functions, implement them, and verify with \`node test.js\`. CRITICAL: do NOT ` +
    `duplicate work other agents are doing — if your Edit fails or you see another ` +
    `agent has already worked on a file, pick a different one. The team is graded ` +
    `on UNIQUE functions completed, not on individual output.`;
  const task: WorkloadTask = {
    task_id: 'workspace-decision-pilot',
    workload: 'workspace-decision',
    target: fixtureDir,
    prompt: 'unused — see promptForAgent',
  };
  const naive = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.5,
    expectedFiles,
    sharedDir: true,
    promptForAgent,
  });
  const hooked = makeCliDriver({
    fixtureDir,
    testCmd: 'node test.js',
    maxBudgetUsd: 0.5,
    expectedFiles,
    sharedDir: true,
    installHook: true,
    promptForAgent,
  });

  console.log('=== workspace-decision (3 agents, 6 files, NO pre-assignment) ===');
  const naiveR = (
    await runWorkload({
      workload: 'workspace-decision',
      tasks: [task],
      n_agents: 3,
      driver: naive,
      conditions: ['control'],
      n_runs: 1,
    })
  )[0];
  console.log('  --- naive (no hook, no MCP) ---');
  console.log(formatReport(naiveR));
  const hookedR = (
    await runWorkload({
      workload: 'workspace-decision',
      tasks: [task],
      n_agents: 3,
      driver: hooked,
      conditions: ['control'],
      n_runs: 1,
    })
  )[0];
  console.log('  --- hooked (file-coord hook signals "held by X" on collision) ---');
  console.log(formatReport(hookedR));
  console.log();
  recordPilot({
    name: 'workspace-decision',
    description:
      '3 agents in a shared workspace with 6 files and NO pre-assignment — must discover who does what',
    timestamp: new Date().toISOString(),
    conditions: [
      { label: 'naive', report: naiveR },
      { label: 'hooked', report: hookedR },
    ],
  });
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

  // ----- v1.3.1 pilot suite: each scenario runs its own naive vs hooked -----
  // Selectable via --pilot=name. Default runs all four in sequence.
  const pilotArg = process.argv.find((a) => a.startsWith('--pilot='))?.split('=')[1];
  const runAll = !pilotArg || pilotArg === 'all';

  if (runAll || pilotArg === 'shared-routes') await runSharedRoutes();
  if (runAll || pilotArg === 'lost-update') await runLostUpdate();
  if (runAll || pilotArg === 'real-codebase') await runRealCodebase();
  if (runAll || pilotArg === 'async') await runAsyncHandoff();
  if (runAll || pilotArg === 'workspace-decision') await runWorkspaceDecision();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
