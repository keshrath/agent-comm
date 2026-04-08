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
}

const SUBGOAL_INSTRUCTION = `
Before doing any work, write a file called subgoals.json in the current
directory containing a JSON array of strings. Each string is one short sub-goal
you plan to accomplish. Example: ["implement camelToKebab", "verify with tests"].
Then implement whatever the task requires and run the tests.
`.trim();

const COORDINATION_INSTRUCTION = `
You are part of a team of agents working on this task in parallel. Use the
agent-comm MCP tools to coordinate:
1. Call comm_register with a unique name.
2. Before editing any file, claim it with:
   comm_state({ action: "set", namespace: "file-locks", key: "<filename>", value: "<your-name>", ttl_seconds: 600 })
   First check if it is already claimed with comm_state get — if so, pick a different file.
3. Release the lock with comm_state delete when you're done.
Avoid duplicating work other agents are doing.
`.trim();

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

function spawnClaude(
  agentDir: string,
  logDir: string,
  agentName: string,
  prompt: string,
  budgetUsd: number,
  withMcp: boolean,
): Promise<{ tokens: number; wall_ms: number; raw: ClaudeJsonResult | null; stderr: string }> {
  return new Promise((resolve) => {
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
      const cfgPath = path.join(path.dirname(agentDir), `_mcp-cfg-${agentName}.json`);
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
    // The `--` separator is REQUIRED: --mcp-config is variadic and will
    // otherwise consume the prompt as another config path.
    args.push('--', prompt);

    const start = Date.now();
    const child = spawn('claude', args, { cwd: agentDir, shell: false });
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

      const withMcp = condition === 'bus-and-locks';
      const promptParts = [
        task.prompt,
        SUBGOAL_INSTRUCTION,
        ...(withMcp ? [COORDINATION_INSTRUCTION] : []),
      ];
      const prompt = promptParts.join('\n\n');

      // Prepare per-agent dirs in parallel.
      const agentDirs: string[] = [];
      for (let i = 0; i < n; i++) {
        const dir = path.join(runRoot, `a${i}`);
        await copyDir(opts.fixtureDir, dir);
        agentDirs.push(dir);
      }

      // Launch all agents in parallel.
      const logDir = path.join(runRoot, '_logs');
      await fs.mkdir(logDir, { recursive: true });
      const totalStart = Date.now();
      const results = await Promise.all(
        agentDirs.map((dir, i) =>
          spawnClaude(dir, logDir, `a${i}`, prompt, opts.maxBudgetUsd, withMcp),
        ),
      );
      const total_wall_ms = Date.now() - totalStart;

      // Collect per-agent results.
      const agents: AgentRun[] = [];
      for (let i = 0; i < n; i++) {
        const dir = agentDirs[i];
        const r = results[i];
        const files_edited = await diffEdited(opts.fixtureDir, dir);
        const subgoals = await readSubgoals(dir);
        const tests_passed = await runTest(dir, opts.testCmd);
        agents.push({
          agent: `a${i}`,
          files_edited,
          subgoals,
          tokens: r.tokens,
          wall_ms: r.wall_ms,
          tests_passed,
        });
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

function runTest(dir: string, cmd: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd, { cwd: dir, shell: true });
    child.on('close', (code) => resolve(code === 0));
    child.on('error', () => resolve(false));
  });
}
