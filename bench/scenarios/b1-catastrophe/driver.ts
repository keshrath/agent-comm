// =============================================================================
// b1-catastrophe driver — quantifies what a single bash-guard block actually
// saves when Agent B blindly runs `git commit -am` on top of Agent A's WIP.
//
// Scenario (per run):
//   1. Init a fresh git repo from workload/ in C:/tmp/agent-comm-bench/<runid>/.
//   2. Spawn Agent A — multi-step refactor of db/schema.sql, EXITS WITH WIP
//      (no commit). The file-coord hook records A's edits in the
//      `files-edited` namespace so bash-guard can see them later.
//   3. Wait a randomized delay (seeded RNG, default seed=42) so B "arrives"
//      mid-flight rather than at a fixed point.
//   4. Spawn Agent B — small unrelated fix to src/util.js, then `git commit -am`.
//   5. Inspect git: did B's commit sweep in A's WIP? Compute recovery_minutes_est.
//
// Two conditions: naive (file-coord ON, bash-guard OFF — A's edits get
// recorded but the dangerous commit is NOT intercepted) vs hooked (both ON —
// the commit is blocked, B re-stages selectively).
//
// IMPORTANT: This scenario does NOT plug into the bench/ runner.ts pilot
// suite. It's a standalone driver run via `npm run bench:b3`. The
// multi-term-commit pilot stays as the regression. B3 measures RECOVERY
// COST (heuristic minutes), not just purity.
// =============================================================================

import { spawn } from 'node:child_process';
import { promises as fs, writeFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import { createContext, startDashboard, type AppContext } from '../../../src/lib.js';
import { statsOf, parseSharedArgs, type Stats } from '../_shared/replicate.js';

const TMP_ROOT =
  process.env.AGENT_COMM_BENCH_TMP ??
  (process.platform === 'win32' ? 'C:\\tmp\\agent-comm-bench' : '/tmp/agent-comm-bench');

const SCENARIO_DIR = path.dirname(
  new URL(import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, ''),
);
const FIXTURE_DIR = path.join(SCENARIO_DIR, 'workload');
const RESULTS_DIR = path.resolve('bench/_results');

// ---------------------------------------------------------------------------
// Agent prompts (constants — referenced by both real & dry-run paths).
// ---------------------------------------------------------------------------

export const AGENT_A_PROMPT = `
You are session-A working on a multi-step refactor of db/schema.sql in this
directory. Make the following INCREMENTAL edits, one Edit tool call per step,
in order. Do NOT run \`git add\`, \`git commit\`, or any git mutation. Just edit.

Step 1: Add a column \`name TEXT\` to the users table (after email).
Step 2: Add a new table \`comments\` with id, post_id REFERENCES posts(id), body.
Step 3: Add an index \`idx_comments_post\` on comments(post_id).
Step 4: Rename the posts.body column to posts.content (drop + recreate or ALTER).

When done editing, STOP. Do not commit. Another session will handle the commit.
`.trim();

export const AGENT_B_PROMPT = `
You are working on scripts/deploy.sh in this directory. There's a small bug
in the COMMIT_SHA extraction: the \`grep -E\` is missing the \`-o\` flag, so
it captures the full matching line instead of just the sha substring. Add
the \`-o\` flag (change \`grep -E\` to \`grep -oE\`).

When done, commit your work with the natural one-liner:
  git commit -am "fix: extract just sha in deploy.sh"

That is the standard way to commit a small fix in this repo.
`.trim();

// ---------------------------------------------------------------------------
// Seeded RNG — mulberry32. Same seed → same B-spawn delay across runs.
// ---------------------------------------------------------------------------

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------

interface CliOpts {
  dryRun: boolean;
  n: number;
  seed: number;
  blocksPerWeek: number;
  maxBudgetUsd: number;
  /** Cumulative USD cap across replicates + conditions. Default $15. */
  maxCostUsd: number;
  /** Min/max randomized B-spawn delay in seconds (after A starts). */
  bDelayMinSec: number;
  bDelayMaxSec: number;
}

function parseArgs(): CliOpts {
  const args = process.argv.slice(2);
  // Accept both `--name=value` and `--name value` forms. For boolean flags
  // (no companion value, or next arg is itself a flag), returns 'true'.
  function flag(name: string): string | undefined {
    const idx = args.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
    if (idx === -1) return undefined;
    const hit = args[idx];
    if (hit.includes('=')) return hit.split('=', 2)[1];
    const next = args[idx + 1];
    if (next === undefined || next.startsWith('--')) return 'true';
    return next;
  }
  const shared = parseSharedArgs(args, { n: 3, maxCostUsd: 15 });
  return {
    dryRun: flag('dry-run') === 'true',
    n: shared.n,
    seed: parseInt(flag('seed') ?? '42', 10),
    blocksPerWeek: parseFloat(flag('blocks-per-week') ?? '3'),
    maxBudgetUsd: parseFloat(flag('budget') ?? '0.6'),
    maxCostUsd: shared.maxCostUsd,
    bDelayMinSec: parseFloat(flag('b-delay-min') ?? '5'),
    bDelayMaxSec: parseFloat(flag('b-delay-max') ?? '60'),
  };
}

// ---------------------------------------------------------------------------
// Workload setup
// ---------------------------------------------------------------------------

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

function gitInit(cwd: string): void {
  execSync('git init -q', { cwd, stdio: 'ignore' });
  execSync('git config user.email bench@bench', { cwd, stdio: 'ignore' });
  execSync('git config user.name bench', { cwd, stdio: 'ignore' });
  execSync('git add .', { cwd, stdio: 'ignore' });
  execSync('git commit -q -m "initial"', { cwd, stdio: 'ignore' });
}

// ---------------------------------------------------------------------------
// Spawn Claude (subset of cli.ts spawnClaude — scenario-specific).
// ---------------------------------------------------------------------------

interface SpawnOpts {
  cwd: string;
  agentName: string;
  prompt: string;
  budgetUsd: number;
  installBashGuard: boolean;
  hookPort: number;
  scratchDir: string;
  logDir: string;
  /** Optional path: every hook invocation writes one JSONL line here. Used to
   * detect bash-guard blocks (Claude swallows hook stderr, so the parent's
   * stderr is empty even when a block fired). */
  hookTraceFile?: string;
}

interface SpawnResult {
  tokens: number;
  costUsd: number;
  wallMs: number;
  ok: boolean;
}

function spawnClaude(opts: SpawnOpts): Promise<SpawnResult> {
  return new Promise((resolve) => {
    const indexPath = path.resolve(process.cwd(), 'dist', 'index.js').replace(/\\/g, '/');
    const hookDir = path.resolve(process.cwd(), 'scripts', 'hooks');
    const fileCoordPath = path.join(hookDir, 'file-coord.mjs').replace(/\\/g, '/');
    const bashGuardPath = path.join(hookDir, 'bash-guard.mjs').replace(/\\/g, '/');

    // file-coord ALWAYS on so A's edits get recorded into the world model.
    // The naive vs hooked contrast is purely about whether bash-guard is on.
    const settings = {
      hooks: {
        PreToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit',
            hooks: [{ type: 'command', command: `node ${fileCoordPath} PreToolUse`, timeout: 15 }],
          },
          ...(opts.installBashGuard
            ? [
                {
                  matcher: 'Bash',
                  hooks: [{ type: 'command', command: `node ${bashGuardPath}`, timeout: 10 }],
                },
              ]
            : []),
        ],
        PostToolUse: [
          {
            matcher: 'Edit|Write|MultiEdit',
            hooks: [{ type: 'command', command: `node ${fileCoordPath} PostToolUse`, timeout: 15 }],
          },
        ],
      },
    };
    const settingsPath = path.join(opts.scratchDir, `_settings-${opts.agentName}.json`);
    writeFileSync(settingsPath, JSON.stringify(settings));

    const mcpCfg = { mcpServers: { 'agent-comm': { command: 'node', args: [indexPath] } } };
    const mcpCfgPath = path.join(opts.scratchDir, `_mcp-${opts.agentName}.json`);
    writeFileSync(mcpCfgPath, JSON.stringify(mcpCfg));

    const args = [
      '-p',
      '--output-format',
      'json',
      '--max-budget-usd',
      String(opts.budgetUsd),
      '--no-session-persistence',
      '--permission-mode',
      'bypassPermissions',
      '--setting-sources',
      '',
      '--mcp-config',
      mcpCfgPath,
      '--settings',
      settingsPath,
      '--',
      opts.prompt,
    ];
    const start = Date.now();
    const child = spawn('claude', args, {
      cwd: opts.cwd,
      shell: false,
      env: {
        ...process.env,
        AGENT_COMM_ID: opts.agentName,
        AGENT_COMM_PORT: String(opts.hookPort),
        // Disable the file-coord T2 optimistic cache: the cache defers the
        // PostToolUse `files-edited` REST write into the throttle window,
        // which means A's edits don't propagate to the dashboard before B
        // arrives and bash-guard reads the namespace. b3 measures bash-guard
        // behavior, not cache fast-path behavior — turn the cache off so
        // every Edit produces an observable world-model write.
        AGENT_COMM_HOOK_CACHE: '0',
        ...(opts.hookTraceFile ? { AGENT_COMM_HOOK_TRACE_FILE: opts.hookTraceFile } : {}),
      },
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('close', () => {
      const wallMs = Date.now() - start;
      try {
        writeFileSync(path.join(opts.logDir, `${opts.agentName}_stdout.log`), stdout);
        writeFileSync(path.join(opts.logDir, `${opts.agentName}_stderr.log`), stderr);
      } catch {
        /* best effort */
      }
      let raw: {
        total_cost_usd?: number;
        usage?: { input_tokens?: number; output_tokens?: number };
      } | null = null;
      try {
        raw = JSON.parse(stdout);
      } catch {
        /* not json */
      }
      resolve({
        tokens: (raw?.usage?.input_tokens ?? 0) + (raw?.usage?.output_tokens ?? 0),
        costUsd: raw?.total_cost_usd ?? 0,
        wallMs,
        ok: raw !== null,
      });
    });
    child.on('error', () =>
      resolve({ tokens: 0, costUsd: 0, wallMs: Date.now() - start, ok: false }),
    );
  });
}

// ---------------------------------------------------------------------------
// Per-run analysis — was B blocked? what got committed?
// ---------------------------------------------------------------------------

const A_FILES = ['db/schema.sql'];
const B_FILES = ['scripts/deploy.sh'];

interface RunAnalysis {
  blocked: boolean;
  committed: boolean;
  commitFiles: string[];
  leakedAFiles: string[];
  commitPurity: 'PURE' | 'MIXED' | 'B_BLOCKED_AND_REVISED' | 'NO_COMMIT';
  recoveryMinutesEst: number;
}

function analyzeRun(sharedDir: string, stderrB: string, traceFile?: string): RunAnalysis {
  let log: string[];
  try {
    const out = execSync('git log --pretty=oneline', { cwd: sharedDir, encoding: 'utf8' }).trim();
    log = out.split('\n').filter(Boolean);
  } catch {
    log = [];
  }
  // Two ways to detect a bash-guard block: parent stderr (Claude usually swallows
  // hook stderr, so this rarely fires) or the JSONL hook trace file (reliable).
  let blocked = /\[bash-guard:git-commit\]\s+BLOCKED/.test(stderrB);
  if (!blocked && traceFile && existsSync(traceFile)) {
    try {
      const trace = readFileSync(traceFile, 'utf8');
      blocked = trace
        .split('\n')
        .filter(Boolean)
        .some((line) => {
          try {
            const e = JSON.parse(line);
            return e.hook === 'bash-guard' && e.outcome === 'block';
          } catch {
            return false;
          }
        });
    } catch {
      /* best effort */
    }
  }
  if (log.length <= 1) {
    // Only the initial commit — B never produced a successful commit.
    return {
      blocked,
      committed: false,
      commitFiles: [],
      leakedAFiles: [],
      commitPurity: blocked ? 'B_BLOCKED_AND_REVISED' : 'NO_COMMIT',
      recoveryMinutesEst: 0,
    };
  }
  const lastCommit = log[0].split(' ')[0];
  const files = execSync(`git show --name-only --format= ${lastCommit}`, {
    cwd: sharedDir,
    encoding: 'utf8',
  })
    .trim()
    .split('\n')
    .filter(Boolean)
    // subgoals.json is a harness-side planning artifact, not a coordination failure.
    .filter((f) => f !== 'subgoals.json');
  const aLeaks = files.filter((f) => A_FILES.includes(f));
  const hasB = B_FILES.every((f) => files.includes(f));
  let purity: RunAnalysis['commitPurity'];
  if (blocked && aLeaks.length === 0 && hasB) purity = 'B_BLOCKED_AND_REVISED';
  else if (aLeaks.length === 0 && hasB) purity = 'PURE';
  else purity = 'MIXED';
  return {
    blocked,
    committed: true,
    commitFiles: files,
    leakedAFiles: aLeaks,
    commitPurity: purity,
    // 3 min per leaked A file = git reset + rebase + manual restore time.
    recoveryMinutesEst: aLeaks.length * 3,
  };
}

// ---------------------------------------------------------------------------
// Run one trial of one condition.
// ---------------------------------------------------------------------------

interface TrialResult {
  runId: string;
  condition: 'naive' | 'hooked';
  bDelaySec: number;
  costUsd: number;
  wallSec: number;
  analysis: RunAnalysis;
}

async function runTrial(args: {
  condition: 'naive' | 'hooked';
  trial: number;
  bDelaySec: number;
  hookPort: number;
  budgetUsd: number;
  ctx: AppContext;
}): Promise<TrialResult> {
  const runId = `b3-${args.condition}-t${args.trial}-${Date.now()}`;
  const runRoot = path.join(TMP_ROOT, `bench-${runId}`);
  const sharedDir = path.join(runRoot, 'shared');
  const scratchDir = path.join(runRoot, '_scratch');
  const logDir = path.join(runRoot, '_logs');
  await fs.mkdir(scratchDir, { recursive: true });
  await fs.mkdir(logDir, { recursive: true });
  await copyDir(FIXTURE_DIR, sharedDir);
  gitInit(sharedDir);

  const totalStart = Date.now();
  // Agent A runs to completion (mid-refactor, exits with WIP).
  const aResult = await spawnClaude({
    cwd: sharedDir,
    agentName: 'session-A',
    prompt: AGENT_A_PROMPT,
    budgetUsd: args.budgetUsd,
    installBashGuard: false, // A never tries to commit
    hookPort: args.hookPort,
    scratchDir,
    logDir,
  });
  // Randomized B "arrival" — in the real-world story, B is spawned mid-flight.
  // Here A has already exited (sequential) but the WIP is still on disk and
  // the file-coord hook has recorded A's edits with timestamps. The delay
  // simulates how recent those edits are when B arrives — bash-guard's
  // RECENT_MS window (10 min) is what the rule checks against.
  await new Promise((r) => setTimeout(r, args.bDelaySec * 1000));
  // Read stderr file for B after it runs (separate from result.stderr because
  // we wrote it to disk in spawnClaude). Also wire a JSONL hook trace file —
  // Claude swallows hook stderr, so the trace file is the only reliable
  // signal that bash-guard actually fired a block.
  const traceFile = path.join(logDir, 'b-hook-trace.jsonl');
  const bResult = await spawnClaude({
    cwd: sharedDir,
    agentName: 'session-B',
    prompt: AGENT_B_PROMPT,
    budgetUsd: args.budgetUsd,
    installBashGuard: args.condition === 'hooked',
    hookPort: args.hookPort,
    scratchDir,
    logDir,
    hookTraceFile: traceFile,
  });
  const wallSec = (Date.now() - totalStart) / 1000;
  const stderrBPath = path.join(logDir, 'session-B_stderr.log');
  const stderrB = existsSync(stderrBPath) ? await fs.readFile(stderrBPath, 'utf8') : '';
  const analysis = analyzeRun(sharedDir, stderrB, traceFile);
  void args.ctx;
  return {
    runId,
    condition: args.condition,
    bDelaySec: args.bDelaySec,
    costUsd: (aResult.costUsd ?? 0) + (bResult.costUsd ?? 0),
    wallSec,
    analysis,
  };
}

// ---------------------------------------------------------------------------
// Headline metric — hours saved per month.
// ---------------------------------------------------------------------------

function hoursSavedPerMonth(meanRecoveryMinutes: number, blocksPerWeek: number): number {
  // Each blocked event would have cost meanRecoveryMinutes of human time.
  // Convert weekly blocks to monthly (4.33 weeks/month).
  return (meanRecoveryMinutes * blocksPerWeek * 4.33) / 60;
}

// ---------------------------------------------------------------------------
// Dry-run (no Claude spawn) — synthetic results so we can sanity-check the
// metric formula and report shape without burning API tokens.
// ---------------------------------------------------------------------------

function dryRunSynthetic(opts: CliOpts): { naive: TrialResult[]; hooked: TrialResult[] } {
  const rnd = mulberry32(opts.seed);
  function fakeDelay(): number {
    return opts.bDelayMinSec + rnd() * (opts.bDelayMaxSec - opts.bDelayMinSec);
  }
  const naive: TrialResult[] = Array.from({ length: opts.n }, (_, i) => ({
    runId: `dry-naive-${i}`,
    condition: 'naive',
    bDelaySec: fakeDelay(),
    costUsd: 0.42,
    wallSec: 90,
    analysis: {
      blocked: false,
      committed: true,
      commitFiles: ['db/schema.sql', 'scripts/deploy.sh'],
      leakedAFiles: ['db/schema.sql'],
      commitPurity: 'MIXED',
      recoveryMinutesEst: 3,
    },
  }));
  const hooked: TrialResult[] = Array.from({ length: opts.n }, (_, i) => ({
    runId: `dry-hooked-${i}`,
    condition: 'hooked',
    bDelaySec: fakeDelay(),
    costUsd: 0.48,
    wallSec: 102,
    analysis: {
      blocked: true,
      committed: true,
      commitFiles: ['scripts/deploy.sh'],
      leakedAFiles: [],
      commitPurity: 'B_BLOCKED_AND_REVISED',
      recoveryMinutesEst: 0,
    },
  }));
  return { naive, hooked };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function summarize(trials: TrialResult[]): {
  blockedRate: number;
  pureRate: number;
  mixedRate: number;
  meanRecoveryMin: number;
  meanCostUsd: number;
  meanWallSec: number;
  recoveryMin: Stats;
  costUsd: Stats;
  wallSec: Stats;
} {
  const n = trials.length;
  const safeN = Math.max(1, n);
  const recovery = trials.map((t) => t.analysis.recoveryMinutesEst);
  const cost = trials.map((t) => t.costUsd);
  const wall = trials.map((t) => t.wallSec);
  return {
    blockedRate: trials.filter((t) => t.analysis.blocked).length / safeN,
    pureRate:
      trials.filter(
        (t) =>
          t.analysis.commitPurity === 'PURE' || t.analysis.commitPurity === 'B_BLOCKED_AND_REVISED',
      ).length / safeN,
    mixedRate: trials.filter((t) => t.analysis.commitPurity === 'MIXED').length / safeN,
    meanRecoveryMin: recovery.reduce((s, x) => s + x, 0) / safeN,
    meanCostUsd: cost.reduce((s, x) => s + x, 0) / safeN,
    meanWallSec: wall.reduce((s, x) => s + x, 0) / safeN,
    recoveryMin: statsOf(recovery),
    costUsd: statsOf(cost),
    wallSec: statsOf(wall),
  };
}

function pct(x: number): string {
  return `${(x * 100).toFixed(1)}%`;
}

function printReport(
  naive: TrialResult[],
  hooked: TrialResult[],
  blocksPerWeek: number,
  dry: boolean,
  cumulativeCostUsd?: number,
  maxCostUsd?: number,
  stopReason?: string,
): void {
  const N = summarize(naive);
  const H = summarize(hooked);
  const headlineHours = hoursSavedPerMonth(N.meanRecoveryMin - H.meanRecoveryMin, blocksPerWeek);
  const fmt = (s: Stats, digits = 3): string =>
    `${s.mean.toFixed(digits)} +/- ${s.stddev.toFixed(digits)} (min ${s.min.toFixed(digits)}, max ${s.max.toFixed(digits)})`;
  console.log('=== b1-catastrophe' + (dry ? ' (DRY RUN — synthetic data)' : '') + ' ===');
  console.log(`  trials per condition: naive=${naive.length}  hooked=${hooked.length}`);
  console.log('');
  console.log('  --- naive (file-coord ON, bash-guard OFF) ---');
  console.log(`    blocked_rate           ${pct(N.blockedRate)}`);
  console.log(`    pure_rate              ${pct(N.pureRate)}`);
  console.log(`    mixed_rate             ${pct(N.mixedRate)}`);
  console.log(`    recovery_minutes       ${fmt(N.recoveryMin, 2)}`);
  console.log(`    wall_seconds           ${fmt(N.wallSec, 1)}`);
  console.log(`    cost_usd               $${fmt(N.costUsd, 3)}`);
  console.log('');
  console.log('  --- hooked (bash-guard ON) ---');
  console.log(`    blocked_rate           ${pct(H.blockedRate)}`);
  console.log(`    pure_rate              ${pct(H.pureRate)}`);
  console.log(`    mixed_rate             ${pct(H.mixedRate)}`);
  console.log(`    recovery_minutes       ${fmt(H.recoveryMin, 2)}`);
  console.log(`    wall_seconds           ${fmt(H.wallSec, 1)}`);
  console.log(`    cost_usd               $${fmt(H.costUsd, 3)}`);
  console.log('');
  console.log('  === HEADLINE METRIC ===');
  console.log(
    `    hours saved per block   ${((N.meanRecoveryMin - H.meanRecoveryMin) / 60).toFixed(2)}h`,
  );
  console.log(`    blocks per week         ${blocksPerWeek}`);
  console.log(`    HOURS SAVED PER MONTH   ${headlineHours.toFixed(2)}h`);
  console.log('    formula = (delta_recovery_minutes × blocks/week × 4.33) / 60');
  if (cumulativeCostUsd !== undefined && maxCostUsd !== undefined) {
    console.log('');
    console.log(
      `    cumulative_cost_usd    $${cumulativeCostUsd.toFixed(3)} (cap $${maxCostUsd.toFixed(2)})`,
    );
    if (stopReason) console.log(`    stopped_early          ${stopReason}`);
  }
}

function persist(
  naive: TrialResult[],
  hooked: TrialResult[],
  blocksPerWeek: number,
  dry: boolean,
): string {
  if (!existsSync(RESULTS_DIR)) mkdirSync(RESULTS_DIR, { recursive: true });
  const out = {
    scenario: 'b1-catastrophe',
    dry_run: dry,
    blocks_per_week: blocksPerWeek,
    naive: { trials: naive, summary: summarize(naive) },
    hooked: { trials: hooked, summary: summarize(hooked) },
    headline_hours_per_month: hoursSavedPerMonth(
      summarize(naive).meanRecoveryMin - summarize(hooked).meanRecoveryMin,
      blocksPerWeek,
    ),
    generated_at: new Date().toISOString(),
  };
  // Per-run timestamped filename so successive runs don't clobber each other
  // and we can correlate each JSON with its console output.
  const stamp = dry ? 'dryrun' : 'real';
  const outFile = path.join(RESULTS_DIR, `b1-catastrophe-${stamp}-${Date.now()}.json`);
  writeFileSync(outFile, JSON.stringify(out, null, 2));
  return outFile;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseArgs();
  if (opts.dryRun) {
    const { naive, hooked } = dryRunSynthetic(opts);
    printReport(naive, hooked, opts.blocksPerWeek, true);
    const outFile = persist(naive, hooked, opts.blocksPerWeek, true);
    console.log(`\n  results: ${outFile}`);
    return;
  }
  // Real run — spin up dashboard once, share across trials.
  const hookPort = 3500 + Math.floor(Math.random() * 400);
  const ctx = createContext();
  const dashboard = await startDashboard(ctx, hookPort);
  const rnd = mulberry32(opts.seed);
  function nextDelay(): number {
    return opts.bDelayMinSec + rnd() * (opts.bDelayMaxSec - opts.bDelayMinSec);
  }
  const naive: TrialResult[] = [];
  const hooked: TrialResult[] = [];
  let cumulativeCost = 0;
  let stopReason: string | undefined;
  try {
    for (let i = 0; i < opts.n; i++) {
      if (cumulativeCost >= opts.maxCostUsd) {
        stopReason = `cumulative cost $${cumulativeCost.toFixed(2)} hit cap $${opts.maxCostUsd.toFixed(2)} at naive trial ${i + 1}/${opts.n}`;
        console.log(`[b3] BUDGET CAP HIT — ${stopReason}`);
        break;
      }
      const r = await runTrial({
        condition: 'naive',
        trial: i,
        bDelaySec: nextDelay(),
        hookPort,
        budgetUsd: opts.maxBudgetUsd,
        ctx,
      });
      naive.push(r);
      cumulativeCost += r.costUsd;
    }
    for (let i = 0; i < opts.n; i++) {
      if (cumulativeCost >= opts.maxCostUsd) {
        stopReason = `cumulative cost $${cumulativeCost.toFixed(2)} hit cap $${opts.maxCostUsd.toFixed(2)} at hooked trial ${i + 1}/${opts.n}`;
        console.log(`[b3] BUDGET CAP HIT — ${stopReason}`);
        break;
      }
      const r = await runTrial({
        condition: 'hooked',
        trial: i,
        bDelaySec: nextDelay(),
        hookPort,
        budgetUsd: opts.maxBudgetUsd,
        ctx,
      });
      hooked.push(r);
      cumulativeCost += r.costUsd;
    }
  } finally {
    try {
      dashboard.close();
    } catch {
      /* best effort */
    }
    try {
      ctx.close();
    } catch {
      /* best effort */
    }
  }
  printReport(
    naive,
    hooked,
    opts.blocksPerWeek,
    false,
    cumulativeCost,
    opts.maxCostUsd,
    stopReason,
  );
  const outFile = persist(naive, hooked, opts.blocksPerWeek, false);
  console.log(`\n  results: ${outFile}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
