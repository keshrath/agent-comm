// =============================================================================
// Real AgentDriver — spawns headless Claude Code subagents via the CLI.
//
// Each agent runs in an isolated tmp dir containing a copy of the workload
// fixture. The driver:
//   1. Copies the fixture to ~/.claude/tmp/bench-<run>/<agent>/
//   2. Spawns `claude -p --output-format json --max-budget-usd N` in parallel
//   3. Parses the JSON result for token usage
//   4. Diffs the agent's dir vs the fixture for files_edited
//   5. Reads the agent-emitted subgoals.json
//   6. Runs the workload's test command for pass/fail
//
// Cost discipline: every agent gets a hard budget cap. Each run is logged.
// =============================================================================

import { spawn } from 'node:child_process';
import { promises as fs, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { AgentDriver, WorkloadTask } from '../runner.js';
import type { AgentRun, MultiAgentRun } from '../metrics.js';
import {
  createContext,
  startDashboard,
  type AppContext,
  type DashboardServer,
} from '../../src/lib.js';

// Bench tmp lives OUTSIDE ~/.claude/ — Claude Code hard-blocks writes to paths
// under its own config dir even with --permission-mode bypassPermissions.
const TMP_ROOT =
  process.env.AGENT_COMM_BENCH_TMP ??
  (process.platform === 'win32' ? 'C:\\tmp\\agent-comm-bench' : '/tmp/agent-comm-bench');
void os; // keep import for future use

export interface CliDriverOptions {
  /** Path to the workload fixture directory (will be copied per agent). */
  fixtureDir: string;
  /** Shell command run in each agent's dir to verify pass/fail (e.g. `node test.js`). */
  testCmd: string;
  /** Per-agent USD budget cap. Hard limit. */
  maxBudgetUsd: number;
  /** Names of files in the fixture an agent is expected to edit. */
  expectedFiles: string[];
  /** When true, all agents share ONE working dir instead of getting per-agent
   * copies. Used for benchmarks that need real file race conditions. The driver
   * spawns an agent-comm dashboard server before the run so the file-coord
   * hook can talk to it via REST. */
  sharedDir?: boolean;
  /** When true, install the file-coord PreToolUse/PostToolUse hook in each
   * agent's --settings JSON. Forces claim-before-edit at the system layer. */
  installHook?: boolean;
  /** When true, install the bash-guard PreToolUse hook (matched on Bash) in
   * each agent's --settings JSON. Intercepts git commit / npm install / etc.
   * and blocks/warns based on the world model. */
  installBashGuard?: boolean;
  /** When true, the driver runs `git init && git add . && git commit -m initial`
   * in the shared dir before any agent spawns. Used by the multi-term pilot. */
  gitInit?: boolean;
  /** Optional: per-agent prompt override. When set, agent i gets the result
   * of calling this with i (0-indexed); the task.prompt is unused. Use this
   * to assign distinct work to each agent so the bench isolates coordination
   * mechanics from decision-collision. */
  promptForAgent?: (agentIndex: number) => string;
  /** When true, agents are spawned ONE AT A TIME (sequentially) rather than
   * in parallel. The pipeline-claim seedCtx is reused across agents so they
   * share the same comm_state DB. Used to test async/cross-session handoff
   * — agent A completes some work and exits, agent B (new process, fresh
   * context) picks up the rest via comm_state. Only meaningful with
   * pipeline-claim condition. */
  sequentialAgents?: boolean;
}

const SUBGOAL_INSTRUCTION = `
Before doing any work, write a file called subgoals.json in the current
directory containing a JSON array of strings. Each string is one short sub-goal
you plan to accomplish. Example: ["implement camelToKebab", "verify with tests"].
Then implement whatever the task requires and run the tests.
`.trim();

function pipelineClaimInstruction(queueNamespace: string, files: string[]): string {
  return `
You are a worker in a parallel team. There is a shared work queue. You must
ONLY edit files you have successfully claimed via the queue. Editing any
unclaimed file is a FAILURE.

THE QUEUE: agent-comm namespace="${queueNamespace}". Each entry has key=<filename>
and value="pending" or value="<worker-id>" once claimed or "done" once finished.

THE FILES: ${files.join(', ')}

PROCEDURE — follow exactly, do not improvise:

LOOP:
  1. Pick any file from the list above whose entry you have NOT yet seen claimed.
  2. Atomically claim it:
     mcp__agent-comm__comm_state action=cas namespace=${queueNamespace} key=<file>
     expected="pending" new="<your-id>"
  3. If success=false, that file was already claimed by someone else. Pick a
     different file from the list and go back to step 2. If you've tried every
     file and none are claimable, EXIT immediately — do not edit anything.
  4. Implement the function in the file you successfully claimed.
  5. Run \`node test.js\` to verify (it's OK if other files still throw — only
     YOUR file needs to pass).
  6. Mark done:
     mcp__agent-comm__comm_state action=set namespace=${queueNamespace} key=<file>
     value="done"
  7. Go back to step 1.

ABSOLUTE RULE: Do not edit any file you have not successfully claimed via the
cas call in step 2. If cas returned success=false for a file, that file is
not yours — even if you think you can implement it faster.
`.trim();
}

async function copyDir(src: string, dst: string): Promise<void> {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) await copyDir(s, d);
    else await fs.copyFile(s, d);
  }
}

async function fileHash(p: string): Promise<string> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return '<missing>';
  }
}

async function diffEdited(fixtureDir: string, agentDir: string): Promise<string[]> {
  const edited: string[] = [];
  const entries = await fs.readdir(agentDir, { withFileTypes: true });
  for (const e of entries) {
    if (e.isDirectory()) continue;
    if (e.name === 'subgoals.json') continue;
    const fixtureContent = await fileHash(path.join(fixtureDir, e.name));
    const agentContent = await fileHash(path.join(agentDir, e.name));
    if (fixtureContent !== agentContent) edited.push(e.name);
  }
  return edited;
}

async function readSubgoals(agentDir: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(path.join(agentDir, 'subgoals.json'), 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed.filter((x) => typeof x === 'string');
  } catch {
    /* no subgoals file written */
  }
  return [];
}

interface ClaudeJsonResult {
  total_cost_usd?: number;
  usage?: { input_tokens?: number; output_tokens?: number };
  result?: string;
  is_error?: boolean;
}

interface SpawnOptions {
  agentDir: string;
  logDir: string;
  agentName: string;
  prompt: string;
  budgetUsd: number;
  withMcp: boolean;
  installHook: boolean;
  /** When true, also install the bash-guard PreToolUse(Bash) hook. */
  installBashGuard: boolean;
  /** Port the file-coord hook should hit (when installHook is true). */
  hookPort?: number;
  /** Output dir for per-agent settings/config files (so they don't pollute the
   * shared agent dir in sharedDir mode). */
  scratchDir: string;
}

function spawnClaude(
  opts: SpawnOptions,
): Promise<{ tokens: number; wall_ms: number; raw: ClaudeJsonResult | null; stderr: string }> {
  return new Promise((resolve) => {
    const {
      agentDir,
      logDir,
      agentName,
      prompt,
      budgetUsd,
      withMcp,
      installHook,
      installBashGuard,
      hookPort,
      scratchDir,
    } = opts;
    const args = [
      '-p',
      '--output-format',
      'json',
      '--max-budget-usd',
      String(budgetUsd),
      '--no-session-persistence',
      '--permission-mode',
      'bypassPermissions',
    ];
    if (withMcp) {
      // Point at the locally-built agent-comm so the agent has comm_* tools.
      // Path must be in OS-native form with forward slashes — node.exe on
      // Windows accepts C:/foo but NOT bash-style /c/foo paths.
      const indexPath = path.resolve(process.cwd(), 'dist', 'index.js').replace(/\\/g, '/');
      const cfgPath = path.join(scratchDir, `_mcp-cfg-${agentName}.json`);
      writeFileSync(
        cfgPath,
        JSON.stringify({
          mcpServers: {
            'agent-comm': { command: 'node', args: [indexPath] },
          },
        }),
      );
      args.push('--mcp-config', cfgPath);
    }
    if (installHook || installBashGuard) {
      // Write a per-agent settings.json that registers the requested hooks.
      const hookDir = path.resolve(process.cwd(), 'scripts', 'hooks');
      const fileCoordPath = path.join(hookDir, 'file-coord.mjs').replace(/\\/g, '/');
      const bashGuardPath = path.join(hookDir, 'bash-guard.mjs').replace(/\\/g, '/');
      const settingsPath = path.join(scratchDir, `_settings-${agentName}.json`);
      const preToolUse: Array<{
        matcher: string;
        hooks: Array<{ type: string; command: string; timeout?: number }>;
      }> = [];
      const postToolUse: Array<{
        matcher: string;
        hooks: Array<{ type: string; command: string; timeout?: number }>;
      }> = [];
      if (installHook) {
        // 15s timeout MUST stay larger than the hook's POLL_TIMEOUT_MS
        // (default 10s) or Claude Code kills the hook process mid-poll.
        preToolUse.push({
          matcher: 'Edit|Write|MultiEdit',
          hooks: [{ type: 'command', command: `node ${fileCoordPath} PreToolUse`, timeout: 15 }],
        });
        postToolUse.push({
          matcher: 'Edit|Write|MultiEdit',
          hooks: [{ type: 'command', command: `node ${fileCoordPath} PostToolUse`, timeout: 15 }],
        });
      }
      if (installBashGuard) {
        preToolUse.push({
          matcher: 'Bash',
          hooks: [{ type: 'command', command: `node ${bashGuardPath}`, timeout: 10 }],
        });
      }
      writeFileSync(
        settingsPath,
        JSON.stringify({
          hooks: {
            ...(preToolUse.length > 0 ? { PreToolUse: preToolUse } : {}),
            ...(postToolUse.length > 0 ? { PostToolUse: postToolUse } : {}),
          },
        }),
      );
      args.push('--settings', settingsPath);
    }
    // The `--` separator is REQUIRED: --mcp-config and --settings are variadic
    // and will otherwise consume the prompt.
    args.push('--', prompt);

    const start = Date.now();
    const child = spawn('claude', args, {
      cwd: agentDir,
      shell: false,
      env: {
        ...process.env,
        AGENT_COMM_ID: agentName,
        AGENT_COMM_PORT: String(hookPort ?? 3421),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', async () => {
      const wall_ms = Date.now() - start;
      let raw: ClaudeJsonResult | null = null;
      try {
        raw = JSON.parse(stdout);
      } catch {
        /* not valid json — leave null */
      }
      // Persist stdout/stderr to the LOG dir (not agent dir, so they don't
      // pollute the file-edit diff).
      try {
        await fs.writeFile(path.join(logDir, `${agentName}_stdout.log`), stdout);
        await fs.writeFile(path.join(logDir, `${agentName}_stderr.log`), stderr);
      } catch {
        /* best effort */
      }
      const tokens = (raw?.usage?.input_tokens ?? 0) + (raw?.usage?.output_tokens ?? 0);
      resolve({ tokens, wall_ms, raw, stderr });
    });
    child.on('error', () => {
      resolve({ tokens: 0, wall_ms: Date.now() - start, raw: null, stderr });
    });
  });
}

export function makeCliDriver(opts: CliDriverOptions): AgentDriver {
  return {
    async runOnce(task: WorkloadTask, n: number, condition): Promise<MultiAgentRun> {
      const runId = `${task.task_id}-${condition}-${Date.now()}`;
      const runRoot = path.join(TMP_ROOT, `bench-${runId}`);
      await fs.mkdir(runRoot, { recursive: true });

      const withMcp =
        condition === 'pipeline-claim' ||
        opts.installHook === true ||
        opts.installBashGuard === true;
      // Hook needs the dashboard REST server running.
      const needDashboard =
        opts.installHook === true ||
        opts.installBashGuard === true ||
        condition === 'pipeline-claim';

      // Pipeline-claim condition: pre-seed the work queue via direct lib
      // import. Workers will atomically claim entries via cas before editing.
      let queueNamespace = '';
      let seedCtx: AppContext | null = null;
      let dashboard: DashboardServer | null = null;
      // Use a per-run port so concurrent runs don't fight over 3421.
      const hookPort = 3500 + Math.floor(Math.random() * 400);
      if (condition === 'pipeline-claim') {
        queueNamespace = `bench-q-${runId}`;
        seedCtx = createContext();
        for (const file of opts.expectedFiles) {
          seedCtx.state.set(queueNamespace, file, 'pending', 'bench-driver', 3600);
        }
      }
      if (needDashboard) {
        // Reuse the seedCtx if we have one, otherwise spin up our own.
        if (!seedCtx) seedCtx = createContext();
        dashboard = await startDashboard(seedCtx, hookPort);
      }

      function buildPrompt(agentIndex: number): string {
        const base = opts.promptForAgent ? opts.promptForAgent(agentIndex) : task.prompt;
        const parts: string[] = [base, SUBGOAL_INSTRUCTION];
        if (condition === 'pipeline-claim') {
          parts.push(pipelineClaimInstruction(queueNamespace, opts.expectedFiles));
        }
        return parts.join('\n\n');
      }

      // Per-agent vs shared dir.
      const scratchDir = path.join(runRoot, '_scratch');
      await fs.mkdir(scratchDir, { recursive: true });
      const agentDirs: string[] = [];
      let sharedAgentDir = '';
      if (opts.sharedDir) {
        // ONE working dir, all agents cd into it.
        sharedAgentDir = path.join(runRoot, 'shared');
        await copyDir(opts.fixtureDir, sharedAgentDir);
        for (let i = 0; i < n; i++) agentDirs.push(sharedAgentDir);
      } else {
        for (let i = 0; i < n; i++) {
          const dir = path.join(runRoot, `a${i}`);
          await copyDir(opts.fixtureDir, dir);
          agentDirs.push(dir);
        }
      }

      // Optional: init a git repo in the shared dir before agents spawn.
      if (opts.gitInit && opts.sharedDir && sharedAgentDir) {
        try {
          const { execSync } = await import('node:child_process');
          execSync('git init -q', { cwd: sharedAgentDir, stdio: 'ignore' });
          execSync('git config user.email bench@bench', {
            cwd: sharedAgentDir,
            stdio: 'ignore',
          });
          execSync('git config user.name bench', { cwd: sharedAgentDir, stdio: 'ignore' });
          execSync('git add .', { cwd: sharedAgentDir, stdio: 'ignore' });
          execSync('git commit -q -m "initial"', { cwd: sharedAgentDir, stdio: 'ignore' });
        } catch (err) {
          process.stderr.write(
            `[bench] git init failed in ${sharedAgentDir}: ${(err as Error).message}\n`,
          );
        }
      }

      // Launch agents — parallel by default, sequential if requested.
      const logDir = path.join(runRoot, '_logs');
      await fs.mkdir(logDir, { recursive: true });
      const totalStart = Date.now();
      let results: Array<{
        tokens: number;
        wall_ms: number;
        raw: ClaudeJsonResult | null;
        stderr: string;
      }>;
      if (opts.sequentialAgents) {
        // One at a time. Each agent's PostToolUse releases its locks before
        // the next agent starts, so the second agent sees the first's effects
        // via comm_state.
        results = [];
        for (let i = 0; i < n; i++) {
          const r = await spawnClaude({
            agentDir: agentDirs[i],
            logDir,
            agentName: `a${i}`,
            prompt: buildPrompt(i),
            budgetUsd: opts.maxBudgetUsd,
            withMcp,
            installHook: opts.installHook === true,
            installBashGuard: opts.installBashGuard === true,
            hookPort,
            scratchDir,
          });
          results.push(r);
        }
      } else {
        results = await Promise.all(
          agentDirs.map((dir, i) =>
            spawnClaude({
              agentDir: dir,
              logDir,
              agentName: `a${i}`,
              prompt: buildPrompt(i),
              budgetUsd: opts.maxBudgetUsd,
              withMcp,
              installHook: opts.installHook === true,
              installBashGuard: opts.installBashGuard === true,
              hookPort,
              scratchDir,
            }),
          ),
        );
      }
      const total_wall_ms = Date.now() - totalStart;

      // Collect per-agent results.
      // In sharedDir mode, all agents work in the same directory and the
      // post-run state IS the merged result. We compute units_completed once
      // (from the shared dir) and then attribute to ALL agents collectively;
      // file collision is no longer the right metric (everything is "shared").
      const agents: AgentRun[] = [];
      if (opts.sharedDir) {
        const sharedTest = await runTest(sharedAgentDir, opts.testCmd);
        for (let i = 0; i < n; i++) {
          const r = results[i];
          agents.push({
            agent: `a${i}`,
            files_edited: [], // not meaningful in shared mode
            subgoals: [],
            tokens: r.tokens,
            wall_ms: r.wall_ms,
            tests_passed: sharedTest.passed,
            // Workload-level units (e.g. routes) — same for all agents because
            // it's the merged shared state. We split evenly across agents to
            // avoid the dedup logic over-counting.
            units_completed: i === 0 ? sharedTest.units : [],
            cost_usd: r.raw?.total_cost_usd,
          });
        }
      } else {
        for (let i = 0; i < n; i++) {
          const dir = agentDirs[i];
          const r = results[i];
          const files_edited = await diffEdited(opts.fixtureDir, dir);
          const subgoals = await readSubgoals(dir);
          const test = await runTest(dir, opts.testCmd);
          agents.push({
            agent: `a${i}`,
            files_edited,
            subgoals,
            tokens: r.tokens,
            wall_ms: r.wall_ms,
            tests_passed: test.passed,
            units_completed: test.units,
            cost_usd: r.raw?.total_cost_usd,
          });
        }
      }

      // Merged-tests proxy for v0: we don't actually merge worktrees. Instead,
      // a run "merges cleanly" only if all agents passed AND no two agents
      // edited the same file. Documented in bench/README.md.
      const fileToAgents = new Map<string, Set<string>>();
      for (const a of agents) {
        for (const f of a.files_edited) {
          if (!fileToAgents.has(f)) fileToAgents.set(f, new Set());
          fileToAgents.get(f)!.add(a.agent);
        }
      }
      const overlap = [...fileToAgents.values()].some((s) => s.size >= 2);
      const allPassed = agents.every((a) => a.tests_passed);
      const merged_tests_passed = allPassed && !overlap;

      // Tear down the dashboard and seed context (closes the DB handle).
      if (dashboard) {
        try {
          dashboard.close();
        } catch {
          /* best effort */
        }
      }
      if (seedCtx) {
        try {
          seedCtx.close();
        } catch {
          /* best effort */
        }
      }

      return {
        run_id: runId,
        workload: task.workload,
        condition,
        agents,
        total_wall_ms,
        merged_tests_passed,
      };
    },
  };
}

function runTest(dir: string, cmd: string): Promise<{ passed: boolean; units: string[] }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd: dir, shell: true });
    let stdout = '';
    child.stdout?.on('data', (d) => (stdout += d.toString()));
    child.stderr?.on('data', () => {});
    child.on('close', (code) => {
      // Parse `PASSED_FNS=foo,bar,baz` line if present (workloads with units).
      const m = /^PASSED_FNS=(.*)$/m.exec(stdout);
      const units = m ? m[1].split(',').filter((s) => s.length > 0) : [];
      resolve({ passed: code === 0, units });
    });
    child.on('error', () => resolve({ passed: false, units: [] }));
  });
}
