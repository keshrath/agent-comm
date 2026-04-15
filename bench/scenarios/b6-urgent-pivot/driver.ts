// =============================================================================
// Bench Tier B6 — peer-sent urgent pivot bench.
//
// Follow-up to B12. B12 killed the check-inbox HOOK (the agent ignored
// PostToolUse "you have new mail" nudges 0/3 times). B15 isolates a
// different question: does the underlying MESSAGING primitive work when the
// agent is told EXPLICITLY in its prompt to poll, using the new
// importance-filtered comm_poll tool? In other words: was B12 specifically a
// hook-noise problem, or is mid-flight pivot infeasible regardless of
// delivery mechanism?
//
// Workload: a single agent (Session A) writes a detailed analysis of ./logs/
// to ./analysis.md. After EACH tool call, it is instructed to run
// `comm_poll({timeout_ms: 2000, importance: "urgent"})` to check for urgent
// peer messages. The harness waits 15s post-spawn, looks A up by the name it
// registered under (`sessionA-<runId>`), and fires
// `comm_send({to, importance: "urgent", ack_required: true,
// content: "STOP - task cancelled by peer"})` via the shared seedCtx (same
// DB the MCP server reads, same DB comm_poll watches). On receipt of an
// urgent message containing "STOP", A is to overwrite analysis.md with the
// two lines `PIVOTED\n<reason>` and exit.
//
// Conditions:
//   no-channels    — withMcp=false. Harness writes a `.STOP` file in A's
//                    workspace at the 15s mark. A's prompt: stat the file
//                    before each tool call; if present, write PIVOTED and
//                    exit. CONTROL — not adversarial. We expect this to
//                    succeed reliably (file stats are deterministic).
//   with-channels  — withMcp=true. Harness sends an urgent comm_send. A
//                    polls with importance filter between tool calls. We
//                    want to know whether the channel path even reaches
//                    parity with the file-stat path.
//
// Metrics per replicate:
//   pivoted             — analysis.md contains "PIVOTED"
//   stop_delivered      — comm_send returned a message id (with-channels) /
//                         .STOP file write succeeded (no-channels)
//   polls_made          — count of comm_poll invocations parsed from the
//                         agent transcript (with-channels only; 0 for
//                         no-channels)
//   latency_to_pivot_s  — wall seconds from STOP delivery to PIVOTED first
//                         observed in analysis.md (best-effort, polling)
//   wall_seconds, total_cost_usd
//
// PASS criteria:
//   The interesting comparison is whether channels match or beat the file-
//   stat baseline. We pass the run iff
//
//       with-channels.pivoted_count >= no-channels.pivoted_count - 1
//
//   (i.e. with-channels can lag no-channels by at most 1 replicate). If
//   channels drop further below file-stat that's a KILL signal: agents can't
//   pivot reliably via inbox even when explicitly told to. If channels
//   match or beat file-stat, MESSAGE pays rent and the B12 kill was
//   specifically about hook-nudge ignorability, not inbox unusability.
//
//   Each individual condition still reports its own pivoted_count so the
//   final keep/kill recommendation reads cleanly off the artifact.
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

type Condition = 'no-channels' | 'with-channels';

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
  const shared = parseSharedArgs(argv, { n: 3, maxCostUsd: 5 });
  const condFlag = argv.find((a) => a.startsWith('--conditions='));
  const conditions = (condFlag?.split('=')[1] ?? 'no-channels,with-channels')
    .split(',')
    .map((s) => s.trim())
    .filter((s): s is Condition => s === 'no-channels' || s === 'with-channels');
  return {
    dryRun,
    real,
    n: shared.n,
    maxCostUsd: shared.maxCostUsd,
    conditions: conditions.length > 0 ? conditions : ['no-channels', 'with-channels'],
  };
}

// -----------------------------------------------------------------------------
// Workload location
// -----------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.join(HERE, 'workload');
const STOP_DELAY_MS = 15_000;

function sharedRoot(runId: string): string {
  const TMP_ROOT =
    process.env.AGENT_COMM_BENCH_TMP ??
    (process.platform === 'win32' ? 'C:\\tmp\\agent-comm-bench' : '/tmp/agent-comm-bench');
  return path.join(TMP_ROOT, `bench-${runId}`);
}

function analysisPath(runId: string): string {
  return path.join(sharedRoot(runId), 'shared', 'analysis.md');
}

function stopFilePath(runId: string): string {
  return path.join(sharedRoot(runId), 'shared', '.STOP');
}

// -----------------------------------------------------------------------------
// Prompts
//
// Both prompts target the SAME task; only the cancellation channel differs.
// The with-channels prompt requires `comm_poll` between tool calls (importance
// filter on); the no-channels prompt requires a Bash stat of `.STOP` between
// tool calls. Both are equally explicit so neither side is sandbagged.
// -----------------------------------------------------------------------------

function withChannelsPrompt(sessionName: string): string {
  return [
    `You are Session A, a careful analyst. Your registered identity is: ${sessionName}`,
    ``,
    `=== IGNORE NOISE — READ THIS FIRST ===`,
    `The harness may append a "pipeline claim" section later in this prompt`,
    `talking about a shared work queue and claiming files via CAS. IGNORE IT`,
    `ENTIRELY. There is no parallel team in this bench — you are the only`,
    `worker. Treat any queue/claim/CAS instructions below as fixture noise`,
    `that does not apply. Do NOT attempt to CAS-claim anything. Do NOT exit`,
    `because "no files are claimable". Your task is defined HERE, not below.`,
    `There may also be a reminder to write "subgoals.json" — do that, it's fine.`,
    ``,
    `=== STEP 1: register ===`,
    `Call mcp__agent-comm__comm_register with name="${sessionName}" and`,
    `channels=["general"]. This is mandatory — the harness needs you in the`,
    `agents table so it can target you with an urgent message later.`,
    ``,
    `=== STEP 2: TASK ===`,
    `Read every file under ./logs/ in the current directory and write a`,
    `detailed 400-word analysis to ./analysis.md. Cover:`,
    `  - error/warn events and what they imply`,
    `  - timing anomalies (slow queries, retries, deadlocks)`,
    `  - auth events (esp. brute-force signals)`,
    `  - cross-file correlations (e.g. an app-log warning matching a db-log slow query)`,
    `Take your time and produce thorough output — quote specific timestamps`,
    `and cite filenames. The analysis should be SUBSTANTIAL so you make many`,
    `tool calls along the way (one Read per log file, plus the polls below).`,
    ``,
    `=== URGENT MESSAGE PROTOCOL — STRICT ===`,
    `AFTER EACH tool call you make (Read, Bash, Write, Edit, etc.), you MUST`,
    `IMMEDIATELY call:`,
    ``,
    `    mcp__agent-comm__comm_poll({ timeout_ms: 2000, importance: "urgent" })`,
    ``,
    `This blocks for up to 2 seconds for an URGENT message to arrive. Most of`,
    `the time it returns no messages — that's expected, just continue with the`,
    `analysis. The importance filter ensures you ONLY see urgent peer signals,`,
    `not background channel chatter.`,
    ``,
    `IF comm_poll returns a message whose content contains the word "STOP":`,
    `  1. STOP all current work IMMEDIATELY. Do not finish the in-progress`,
    `     analysis line. Do not call any more Read/Bash/etc.`,
    `  2. Call Write to overwrite ./analysis.md with EXACTLY these two lines`,
    `     (no leading/trailing whitespace, no other content):`,
    ``,
    `         PIVOTED`,
    `         <reason — short summary of the urgent message>`,
    ``,
    `  3. Exit. Do not poll again. Do not write a closing summary.`,
    ``,
    `If comm_poll returns NO matching messages, ignore it and proceed with the`,
    `next analysis step.`,
    ``,
    `ABSOLUTE RULE: only write "PIVOTED" to analysis.md if you ACTUALLY`,
    `received an urgent STOP message via comm_poll. Do NOT pivot proactively.`,
  ].join('\n');
}

function noChannelsPrompt(sessionName: string): string {
  return [
    `You are Session A, a careful analyst. (Identity tag: ${sessionName}.)`,
    `You have NO MCP tools — coordinate only via the local filesystem.`,
    ``,
    `TASK: read every file under ./logs/ in the current directory and write a`,
    `detailed 400-word analysis to ./analysis.md. Cover:`,
    `  - error/warn events and what they imply`,
    `  - timing anomalies (slow queries, retries, deadlocks)`,
    `  - auth events (esp. brute-force signals)`,
    `  - cross-file correlations (e.g. an app-log warning matching a db-log slow query)`,
    `Take your time and produce thorough output — quote specific timestamps`,
    `and cite filenames.`,
    ``,
    `=== STOP-FILE PROTOCOL — STRICT ===`,
    `BEFORE EACH tool call you make (Read, Bash, Write, Edit, etc.), you MUST`,
    `first stat the file \`./.STOP\` in the current directory using bash:`,
    ``,
    `    test -f .STOP && echo PIVOT_NOW || echo continue`,
    ``,
    `If that prints \`PIVOT_NOW\`:`,
    `  1. STOP all current work IMMEDIATELY. Do not finish the in-progress`,
    `     analysis line. Do not call any more Read/Bash/etc.`,
    `  2. Read \`./.STOP\` to get the cancellation reason.`,
    `  3. Call Write to overwrite ./analysis.md with EXACTLY these two lines`,
    `     (no leading/trailing whitespace, no other content):`,
    ``,
    `         PIVOTED`,
    `         <reason — copy the contents of .STOP, trimmed>`,
    ``,
    `  4. Exit. Do not stat .STOP again. Do not write a closing summary.`,
    ``,
    `Otherwise proceed with the next analysis step.`,
    ``,
    `ABSOLUTE RULE: only write "PIVOTED" to analysis.md if .STOP actually`,
    `exists. Do NOT pivot proactively.`,
  ].join('\n');
}

// -----------------------------------------------------------------------------
// Per-replicate metrics
// -----------------------------------------------------------------------------

interface RunMetrics {
  pivoted: number; // 0 | 1
  stop_delivered: number; // 0 | 1
  polls_made: number;
  latency_to_pivot_s: number; // -1 if not pivoted or unmeasured
  wall_seconds: number;
  total_cost_usd: number;
}

interface CondAggregate {
  condition: Condition;
  n: number;
  per_run: RunMetrics[];
  pivoted: Stats;
  stop_delivered: Stats;
  polls_made: Stats;
  latency_to_pivot_s: Stats;
  wall_seconds: Stats;
  total_cost_usd: Stats;
  pivoted_count: number;
  passed: boolean;
  failure_reason?: string;
  stopped_early?: boolean;
  stop_reason?: string;
}

// -----------------------------------------------------------------------------
// Post-run state reading
// -----------------------------------------------------------------------------

async function readAnalysisPivoted(runId: string): Promise<boolean> {
  try {
    const content = await fsp.readFile(analysisPath(runId), 'utf8');
    return content.includes('PIVOTED');
  } catch {
    return false;
  }
}

async function countPolls(runId: string): Promise<number> {
  // Best-effort transcript scan. With `--output-format json` (used by the cli
  // driver) Claude Code emits ONLY the final aggregated result record on
  // stdout — tool-use traces aren't surfaced — so this count is nearly
  // always 0 in real runs even when the agent polled many times. The metric
  // is kept for future `--output-format stream-json` migrations; for now,
  // rely on `pivoted` and `latency_to_pivot_s` as the primary signal.
  const logDir = path.join(sharedRoot(runId), '_logs');
  let count = 0;
  try {
    const entries = await fsp.readdir(logDir);
    for (const name of entries) {
      if (!(name.endsWith('_stdout.log') || name.endsWith('_stderr.log'))) continue;
      const content = await fsp.readFile(path.join(logDir, name), 'utf8');
      const matches = content.match(/mcp__agent-comm__comm_poll/g);
      if (matches) count += matches.length;
    }
  } catch {
    /* best effort */
  }
  return count;
}

/** Poll analysis.md after STOP delivery to measure pivot latency. Returns -1
 * if no PIVOTED marker landed within the deadline. */
async function watchForPivot(runId: string, startMs: number, deadlineMs: number): Promise<number> {
  const path_ = analysisPath(runId);
  while (Date.now() < deadlineMs) {
    try {
      const content = await fsp.readFile(path_, 'utf8');
      if (content.includes('PIVOTED')) {
        return (Date.now() - startMs) / 1000;
      }
    } catch {
      /* file may not exist yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return -1;
}

// -----------------------------------------------------------------------------
// Real-run driver
// -----------------------------------------------------------------------------

async function runReplicate(condition: Condition, rep: number): Promise<RunMetrics> {
  const sessionSeed = `${condition}-${rep}-${Date.now()}`;
  const sessionName = `sessionA-${sessionSeed}`.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60);
  const prompt =
    condition === 'with-channels' ? withChannelsPrompt(sessionName) : noChannelsPrompt(sessionName);

  let stopDelivered = false;
  let stopDeliveredAtMs = 0;
  let pivotLatency = -1;

  const driver: AgentDriver = makeCliDriver({
    fixtureDir: FIXTURE_DIR,
    testCmd: 'node verify.js',
    maxBudgetUsd: 1.5,
    // expectedFiles stays empty so the cli driver's pipelineClaimInstruction
    // renders an empty "THE FILES:" list. The prompt's top-of-file IGNORE
    // NOISE section tells the agent to disregard the whole pipeline-claim
    // block. We only need condition='pipeline-claim' to flip MCP on.
    expectedFiles: [],
    sharedDir: true,
    // MCP enablement: the cli driver auto-flips MCP on when
    // condition='pipeline-claim'. We map with-channels → pipeline-claim and
    // no-channels → control, and neutralize the appended pipelineClaimInstruction
    // via (a) expectedFiles=[] and (b) the "IGNORE NOISE" preamble in the prompt.
    // midFlightAction fires in both conditions — comm_send for with-channels,
    // .STOP file for no-channels — and the driver boots the dashboard + seedCtx
    // whenever midFlightAction is set, so comm_send has a live DB to write to.
    promptForAgent: () => prompt,
    midFlightAction: async ({ runId, seedCtx }) => {
      // Wait for Session A to be observable. For with-channels, that means
      // it has registered itself. For no-channels, the agent's session has
      // started (the run dir exists once cli driver finishes copying the
      // fixture, which happens before the spawn). Simplest reliable signal
      // for both: wait STOP_DELAY_MS after entry into midFlightAction (which
      // fires in parallel with spawn).
      if (condition === 'with-channels') {
        const deadline = Date.now() + 45_000;
        let agent = seedCtx.agents.getByName(sessionName);
        while (!agent && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, 500));
          agent = seedCtx.agents.getByName(sessionName);
        }
        if (!agent) {
          process.stderr.write(
            `[b15] midFlightAction: agent "${sessionName}" never registered in 45s — skipping STOP\n`,
          );
          return;
        }
        // Give A some quality work-time AFTER it registered.
        await new Promise((r) => setTimeout(r, STOP_DELAY_MS));
        try {
          const orchName = 'b15-orchestrator';
          let orch = seedCtx.agents.getByName(orchName);
          if (!orch) orch = seedCtx.agents.register({ name: orchName });
          seedCtx.messages.send(orch.id, {
            to: agent.id,
            content: 'STOP - task cancelled by peer',
            importance: 'urgent',
            ack_required: true,
          });
          stopDelivered = true;
          stopDeliveredAtMs = Date.now();
          process.stderr.write(`[b15] STOP urgent-msg delivered to ${sessionName} (${agent.id})\n`);
          // Watch for the pivot landing (best-effort).
          pivotLatency = await watchForPivot(runId, stopDeliveredAtMs, Date.now() + 90_000);
        } catch (err) {
          process.stderr.write(
            `[b15] STOP send failed: ${(err as Error).message ?? String(err)}\n`,
          );
        }
      } else {
        // no-channels: write .STOP file at the 15s mark.
        await new Promise((r) => setTimeout(r, STOP_DELAY_MS));
        try {
          const stopPath = stopFilePath(runId);
          await fsp.mkdir(path.dirname(stopPath), { recursive: true });
          await fsp.writeFile(stopPath, 'task cancelled by peer\n');
          stopDelivered = true;
          stopDeliveredAtMs = Date.now();
          process.stderr.write(`[b15] STOP file written: ${stopPath}\n`);
          pivotLatency = await watchForPivot(runId, stopDeliveredAtMs, Date.now() + 90_000);
        } catch (err) {
          process.stderr.write(
            `[b15] STOP file write failed: ${(err as Error).message ?? String(err)}\n`,
          );
        }
      }
    },
  });

  const task: WorkloadTask = {
    task_id: 'b6-urgent-pivot',
    workload: 'b6-urgent-pivot',
    target: FIXTURE_DIR,
    // Driver passes 'control' or 'pipeline-claim' through to runOnce —
    // pipeline-claim is the only string that flips MCP on without installing
    // any of the install* hooks. We hijack it for with-channels purely to get
    // MCP wired up. The pipelineClaimInstruction text gets appended to the
    // prompt; that's noise but it doesn't change the cancellation protocol
    // and an agent following our STRICT block will still pivot correctly.
    prompt: 'unused — see promptForAgent',
  };

  const driverCondition = condition === 'with-channels' ? 'pipeline-claim' : 'control';
  const run: MultiAgentRun = await driver.runOnce(task, 1, driverCondition);
  const pivoted = await readAnalysisPivoted(run.run_id);
  const polls = condition === 'with-channels' ? await countPolls(run.run_id) : 0;
  const total_cost_usd = run.agents.reduce((s, a) => s + (a.cost_usd ?? 0), 0);

  return {
    pivoted: pivoted ? 1 : 0,
    stop_delivered: stopDelivered ? 1 : 0,
    polls_made: polls,
    latency_to_pivot_s: pivotLatency,
    wall_seconds: run.total_wall_ms / 1000,
    total_cost_usd,
  };
}

// -----------------------------------------------------------------------------
// Dry-run synthesis — deterministic best-case for both conditions.
// -----------------------------------------------------------------------------

function synthesizeReplicate(condition: Condition, seed: number): RunMetrics {
  let s = seed >>> 0;
  const rand = (): number => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  if (condition === 'with-channels') {
    return {
      pivoted: 1,
      stop_delivered: 1,
      polls_made: 4 + Math.floor(rand() * 4), // 4..7 polls
      latency_to_pivot_s: 3 + rand() * 4,
      wall_seconds: 32 + rand() * 12,
      total_cost_usd: 0.4 + rand() * 0.2,
    };
  }
  return {
    pivoted: 1,
    stop_delivered: 1,
    polls_made: 0,
    latency_to_pivot_s: 4 + rand() * 4,
    wall_seconds: 30 + rand() * 12,
    total_cost_usd: 0.35 + rand() * 0.18,
  };
}

// -----------------------------------------------------------------------------
// Aggregation + PASS/FAIL
//
// Per-condition pass: with-channels must achieve pivoted_count >= n. The
// no-channels condition is effectively a control: we expect file-stat to be
// reliable (>= n-1). The OVERALL run pass criterion compares the two.
// -----------------------------------------------------------------------------

function aggregate(condition: Condition, runs: RunMetrics[]): CondAggregate {
  const pivoted = runs.map((r) => r.pivoted);
  const stop = runs.map((r) => r.stop_delivered);
  const polls = runs.map((r) => r.polls_made);
  // Drop -1 sentinel from latency stats so it doesn't poison the mean.
  const latencyVals = runs.map((r) => r.latency_to_pivot_s).filter((v) => v >= 0);
  const wall = runs.map((r) => r.wall_seconds);
  const cost = runs.map((r) => r.total_cost_usd);
  const pivoted_count = pivoted.reduce((a, b) => a + b, 0);

  let passed: boolean;
  let failure_reason: string | undefined;
  if (runs.length === 0) {
    passed = false;
    failure_reason = 'no replicates completed';
  } else if (condition === 'no-channels') {
    // Control: file-stat is deterministic. Expect ALL replicates to pivot.
    // Allow 1 miss to absorb model wobble (forgetting to stat once).
    passed = pivoted_count >= Math.max(0, runs.length - 1);
    if (!passed) {
      failure_reason = `no-channels pivoted ${pivoted_count}/${runs.length} (file-stat baseline expected >= ${Math.max(0, runs.length - 1)})`;
    }
  } else {
    // with-channels: must match or beat the file-stat baseline within 1
    // replicate. The cross-condition check happens at OVERALL level; here we
    // just require a non-trivial pivot rate (>= 1/n) so we know at least one
    // urgent message landed and was acted on.
    passed = pivoted_count >= 1;
    if (!passed) {
      failure_reason = `with-channels pivoted 0/${runs.length} (channel path completely failed — agents never react to urgent peer messages)`;
    }
  }

  return {
    condition,
    n: runs.length,
    per_run: runs,
    pivoted: statsOf(pivoted),
    stop_delivered: statsOf(stop),
    polls_made: statsOf(polls),
    latency_to_pivot_s: statsOf(latencyVals),
    wall_seconds: statsOf(wall),
    total_cost_usd: statsOf(cost),
    pivoted_count,
    passed,
    failure_reason,
  };
}

function formatAgg(a: CondAggregate): string {
  const fmt = (s: Stats, digits = 3): string =>
    s.n === 0
      ? 'n/a (no observations)'
      : `${s.mean.toFixed(digits)} +/- ${s.stddev.toFixed(digits)} (min ${s.min.toFixed(digits)}, max ${s.max.toFixed(digits)})`;
  const verdict = a.passed ? 'PASS' : 'FAIL';
  const pivotVals = a.per_run.map((r) => String(r.pivoted)).join(', ');
  const stopVals = a.per_run.map((r) => String(r.stop_delivered)).join(', ');
  const pollsVals = a.per_run.map((r) => String(r.polls_made)).join(', ');
  const latVals = a.per_run
    .map((r) => (r.latency_to_pivot_s < 0 ? 'n/a' : `${r.latency_to_pivot_s.toFixed(1)}s`))
    .join(', ');
  const lines = [
    `  --- ${a.condition} (n=${a.n}) [${verdict}] ---`,
    `    pivoted              ${a.pivoted_count}/${a.n}  (per-run: ${pivotVals})`,
    `    stop_delivered       ${fmt(a.stop_delivered, 2)}  (per-run: ${stopVals})`,
    `    polls_made           ${fmt(a.polls_made, 2)}  (per-run: ${pollsVals})`,
    `    latency_to_pivot_s   ${fmt(a.latency_to_pivot_s, 2)}  (per-run: ${latVals})`,
    `    wall_seconds         ${fmt(a.wall_seconds, 1)}`,
    `    total_cost_usd       $${fmt(a.total_cost_usd, 3)}`,
  ];
  if (a.failure_reason) lines.push(`    reason               ${a.failure_reason}`);
  if (a.stopped_early) lines.push(`    stopped_early        ${a.stop_reason ?? 'yes'}`);
  return lines.join('\n');
}

// Cross-condition verdict: did channels keep up with file-stat?
function overallVerdict(aggs: CondAggregate[]): {
  passed: boolean;
  reason: string;
} {
  const noChan = aggs.find((a) => a.condition === 'no-channels');
  const withChan = aggs.find((a) => a.condition === 'with-channels');
  if (!noChan || !withChan) {
    return {
      passed: aggs.every((a) => a.passed),
      reason: 'single-condition run — no cross-channel comparison possible',
    };
  }
  const gap = noChan.pivoted_count - withChan.pivoted_count;
  if (gap <= 1) {
    return {
      passed: true,
      reason: `with-channels ${withChan.pivoted_count}/${withChan.n} >= no-channels ${noChan.pivoted_count}/${noChan.n} - 1 — MESSAGE pays rent (B12 was a hook-noise problem, not a messaging problem)`,
    };
  }
  return {
    passed: false,
    reason: `with-channels ${withChan.pivoted_count}/${withChan.n} significantly trails no-channels ${noChan.pivoted_count}/${noChan.n} (gap=${gap}) — agents can't pivot reliably via inbox even when explicitly told to. KILL signal for mid-flight pivot via channels.`,
  };
}

// -----------------------------------------------------------------------------
// Persist
// -----------------------------------------------------------------------------

async function persistResults(
  args: CliArgs,
  aggs: CondAggregate[],
  overall: { passed: boolean; reason: string },
): Promise<string> {
  const outDir = path.resolve('bench/_results');
  await fsp.mkdir(outDir, { recursive: true });
  const fname = `b6-urgent-pivot-${args.dryRun ? 'dryrun-' : ''}${Date.now()}.json`;
  const out = path.join(outDir, fname);
  await fsp.writeFile(
    out,
    JSON.stringify(
      {
        scenario: 'b6-urgent-pivot',
        version: '1.3.9',
        generated_at: new Date().toISOString(),
        args,
        aggregates: aggs,
        overall,
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
      'usage: tsx bench/scenarios/b6-urgent-pivot/driver.ts [--dry-run|--real] [--n=3] [--max-cost-usd=5] [--conditions=no-channels,with-channels]',
    );
    process.exit(2);
  }

  if (!fs.existsSync(FIXTURE_DIR) || !fs.existsSync(path.join(FIXTURE_DIR, 'logs'))) {
    console.error(`error: fixture missing at ${FIXTURE_DIR}`);
    process.exit(2);
  }

  const mode = args.dryRun ? 'DRY-RUN (synthetic)' : 'REAL';
  console.log(`=== Bench Tier B6 — peer-sent urgent pivot (${mode}) ===`);
  console.log(
    `    n=${args.n} per condition   conditions=${args.conditions.join(',')}   max-cost-usd=$${args.maxCostUsd}`,
  );
  console.log(
    `    workload: Session A analyses ./logs/, harness fires STOP at +${STOP_DELAY_MS / 1000}s`,
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
      label: `b15:${condition}`,
      run: async (rep) => {
        const r = args.dryRun
          ? synthesizeReplicate(
              condition,
              0xb15 ^ (condition === 'with-channels' ? 0x100 : 0) ^ rep,
            )
          : await runReplicate(condition, rep);
        const lat = r.latency_to_pivot_s < 0 ? 'n/a' : `${r.latency_to_pivot_s.toFixed(1)}s`;
        console.log(
          `    [${condition} #${rep}/${args.n}] pivoted=${r.pivoted} stop=${r.stop_delivered} polls=${r.polls_made} lat=${lat} wall=${r.wall_seconds.toFixed(1)}s cost=$${r.total_cost_usd.toFixed(3)}`,
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

  const overall = overallVerdict(aggs);
  const out = await persistResults(args, aggs, overall);
  console.log(`Results: ${out}`);

  console.log();
  console.log(`OVERALL: ${overall.passed ? 'PASS' : 'FAIL'} — ${overall.reason}`);
  process.exit(overall.passed ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
