// =============================================================================
// agent-comm Tier A — unit micro-benchmarks for primitives
//
// Pure in-process measurements. NO subagents, NO API spend, NO network beyond
// 127.0.0.1 to a throw-away dashboard we spawn ourselves. Designed to run in
// CI as part of `npm run check`.
//
// Four benches with hard pass/fail targets:
//
//   1. CAS latency (StateService.compareAndSwap, in-process, in-memory SQLite)
//      target  p50 < 8ms  / p95 < 30ms  over 10k ops
//
//   2. Hook cache-hit fast-path round-trip
//      Read+mutate+write the file-coord cache file. This is the path a hot
//      same-agent-same-file Edit takes when REST is skipped.
//      target  median < 1ms over 1k ops
//
//   3. Fail-open detection latency
//      Stand up a dashboard, kill it, time how long the same call() helper the
//      hook uses takes to give up.
//      target  < 500ms
//
//   4. SQLite write throughput
//      Direct INSERT into the messages table via createContext (in-memory).
//      target  ≥ 1000 ops/sec
//
// Each bench:
//   - warm-up phase (excluded from stats)
//   - measurement phase (perf_hooks.performance.now per op)
//   - asserts target with a 20% slack — fails the run if missed by > 20%
//
// Output:
//   - bench/_results/unit-latest.json (structured JSON, one entry per bench)
//   - human-readable table to stdout via console.log inside afterAll()
//
// Determinism note: this file deliberately uses small N's tuned to keep the
// whole run under ~10s on a modern laptop AND keep variance < 10% across
// repeated runs (verified by running 3x consecutively). If the targets ever
// start flapping, bump the warm-up or the measurement N rather than relaxing
// the target — flakiness is a worse signal than a tight number.
// =============================================================================

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { performance } from 'node:perf_hooks';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, type AppContext } from '../../src/context.js';
import { startDashboard } from '../../src/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Targets — keep close to the spec. Slack = 20% (the CI gate).
// ---------------------------------------------------------------------------

interface Target {
  metric: string; // human label
  value: number; // budget
  unit: string; // ms / ops_per_sec
  // direction: lower means smaller-is-better, higher means bigger-is-better
  direction: 'lower' | 'higher';
}

const SLACK = 1.2; // observed must be within 20% of target

interface BenchResult {
  name: string;
  description: string;
  n_ops: number;
  warmup_ops: number;
  duration_ms: number;
  // For latency benches:
  p50_ms?: number;
  p95_ms?: number;
  p99_ms?: number;
  mean_ms?: number;
  min_ms?: number;
  max_ms?: number;
  // For throughput benches:
  ops_per_sec?: number;
  // The pass/fail targets that were checked.
  targets: CheckedTarget[];
  pass: boolean;
}

interface CheckedTarget {
  metric: string;
  target: number;
  actual: number;
  unit: string;
  direction: 'lower' | 'higher';
  pass: boolean;
  slack: number;
}

function checkTarget(actual: number, t: Target): CheckedTarget {
  const c = check(actual, t);
  return {
    metric: t.metric,
    target: t.value,
    actual,
    unit: t.unit,
    direction: t.direction,
    pass: c.pass,
    slack: c.slack,
  };
}

const RESULTS: BenchResult[] = [];

function pct(samples: number[], p: number): number {
  // samples must be sorted ascending. p in (0,1].
  if (samples.length === 0) return 0;
  const idx = Math.min(samples.length - 1, Math.max(0, Math.ceil(p * samples.length) - 1));
  return samples[idx];
}

function summarize(samplesMs: number[]): {
  p50_ms: number;
  p95_ms: number;
  p99_ms: number;
  mean_ms: number;
  min_ms: number;
  max_ms: number;
} {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    p50_ms: pct(sorted, 0.5),
    p95_ms: pct(sorted, 0.95),
    p99_ms: pct(sorted, 0.99),
    mean_ms: sum / sorted.length,
    min_ms: sorted[0],
    max_ms: sorted[sorted.length - 1],
  };
}

function check(actual: number, t: Target): { pass: boolean; slack: number } {
  // For "lower is better": actual <= target * SLACK
  // For "higher is better": actual >= target / SLACK
  if (t.direction === 'lower') {
    const limit = t.value * SLACK;
    return { pass: actual <= limit, slack: SLACK };
  }
  const floor = t.value / SLACK;
  return { pass: actual >= floor, slack: SLACK };
}

function record(r: BenchResult): void {
  RESULTS.push(r);
}

// ---------------------------------------------------------------------------
// Output writer — runs once after all benches complete
// ---------------------------------------------------------------------------

afterAll(() => {
  const outDir = resolve(HERE, '..', '_results');
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, 'unit-latest.json');
  const payload = {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    benches: RESULTS,
  };
  writeFileSync(outPath, JSON.stringify(payload, null, 2));

  // Human-readable summary
  const lines: string[] = [];
  lines.push('');
  lines.push('===== agent-comm Tier A unit bench =====');
  for (const r of RESULTS) {
    lines.push(`  ${r.name}  (n=${r.n_ops})`);
    if (r.p50_ms !== undefined) {
      lines.push(
        `    p50=${r.p50_ms.toFixed(3)}ms  p95=${r.p95_ms!.toFixed(3)}ms  p99=${r.p99_ms!.toFixed(3)}ms  mean=${r.mean_ms!.toFixed(3)}ms`,
      );
    }
    if (r.ops_per_sec !== undefined) {
      lines.push(`    ${r.ops_per_sec.toFixed(0)} ops/sec`);
    }
    for (const t of r.targets) {
      const arrow = t.direction === 'lower' ? '<=' : '>=';
      const limit = t.direction === 'lower' ? t.target * t.slack : t.target / t.slack;
      const status = t.pass ? 'PASS' : 'FAIL';
      lines.push(
        `    [${status}] ${t.metric} ${arrow} ${limit.toFixed(2)} ${t.unit} (target ${t.target} ${t.unit}, actual ${t.actual.toFixed(3)} ${t.unit})`,
      );
    }
  }
  lines.push('');
  lines.push(`results: ${outPath}`);
  // eslint-disable-next-line no-console
  console.log(lines.join('\n'));
});

// ---------------------------------------------------------------------------
// Bench 1 — CAS latency
// ---------------------------------------------------------------------------

describe('CAS latency', () => {
  let ctx: AppContext;
  beforeAll(() => {
    ctx = createContext({ path: ':memory:' });
  });
  afterAll(() => {
    ctx.close();
  });

  it('compareAndSwap p50 < 8ms / p95 < 30ms over 10k ops', () => {
    const NS = 'bench-cas';
    const KEY = 'counter';
    const N_WARMUP = 500;
    const N_OPS = 10_000;
    const BREAK = process.env.AGENT_COMM_BENCH_BREAK === 'cas';
    function maybeBreak(): void {
      if (!BREAK) return;
      const until = performance.now() + 50;
      while (performance.now() < until) {
        /* busy-wait */
      }
    }

    // Seed
    ctx.state.set(NS, KEY, '0', 'bench');

    // Warm-up (excluded from stats — gives SQLite time to settle WAL pages,
    // and lets the v8 JIT warm the cas hot path).
    let cur = 0;
    for (let i = 0; i < N_WARMUP; i++) {
      const next = cur + 1;
      ctx.state.compareAndSwap(NS, KEY, String(cur), String(next), 'bench');
      cur = next;
    }

    // Reset for clean measurement
    ctx.state.set(NS, KEY, '0', 'bench');
    cur = 0;

    const measureN = BREAK ? 100 : N_OPS;
    const samples = new Array<number>(measureN);
    for (let i = 0; i < measureN; i++) {
      const next = cur + 1;
      const t0 = performance.now();
      const ok = ctx.state.compareAndSwap(NS, KEY, String(cur), String(next), 'bench');
      maybeBreak();
      const t1 = performance.now();
      samples[i] = t1 - t0;
      if (!ok) throw new Error(`CAS unexpectedly failed at i=${i}`);
      cur = next;
    }

    const stats = summarize(samples);
    const targets: Target[] = [
      { metric: 'p50', value: 8, unit: 'ms', direction: 'lower' },
      { metric: 'p95', value: 30, unit: 'ms', direction: 'lower' },
    ];
    const checked = [checkTarget(stats.p50_ms, targets[0]), checkTarget(stats.p95_ms, targets[1])];
    const pass = checked.every((c) => c.pass);
    record({
      name: 'cas-latency',
      description: 'StateService.compareAndSwap in-process, in-memory SQLite',
      n_ops: N_OPS,
      warmup_ops: N_WARMUP,
      duration_ms: samples.reduce((a, b) => a + b, 0),
      ...stats,
      targets: checked,
      pass,
    });

    expect(checked[0].pass, `CAS p50 ${stats.p50_ms.toFixed(3)}ms exceeds ${8 * SLACK}ms`).toBe(
      true,
    );
    expect(checked[1].pass, `CAS p95 ${stats.p95_ms.toFixed(3)}ms exceeds ${30 * SLACK}ms`).toBe(
      true,
    );
  });
});

// ---------------------------------------------------------------------------
// Bench 2 — Hook cache-hit fast-path round-trip
// ---------------------------------------------------------------------------
//
// We can't easily import the hook script (it's a CLI .mjs that reads stdin),
// so we replicate the exact cache primitive used by file-coord.mjs and
// measure that. The primitive is: readFileSync + JSON.parse + mutate +
// JSON.stringify + writeFileSync against a tiny per-agent JSON file in tmp.
// This is THE hot path that the cache-hit-self optimization saves us from
// having to do REST for.

describe('hook cache-hit fast-path', () => {
  const cacheDir = join(tmpdir(), `agent-comm-bench-cache-${process.pid}`);
  let cachePath: string;

  beforeAll(() => {
    mkdirSync(cacheDir, { recursive: true });
    cachePath = join(cacheDir, 'hook-cache.json');
    // Pre-seed with some entries to mirror real-world cache size
    const seed: Record<string, { holder: string; claimed_at: number; release_pending: boolean }> =
      {};
    for (let i = 0; i < 16; i++) {
      seed[`/repo/src/file-${i}.ts`] = {
        holder: 'bench-agent',
        claimed_at: Date.now(),
        release_pending: false,
      };
    }
    writeFileSync(cachePath, JSON.stringify(seed));
  });

  afterAll(() => {
    rmSync(cacheDir, { recursive: true, force: true });
  });

  it('cache read+mutate+write median < 1ms', () => {
    const N_WARMUP = 200;
    const N_OPS = 1_000;
    const FILE = '/repo/src/hot-file.ts';

    function fastPath(): void {
      const raw = readFileSync(cachePath, 'utf8');
      const cache = JSON.parse(raw) as Record<
        string,
        { holder: string; claimed_at: number; release_pending: boolean }
      >;
      const existing = cache[FILE];
      if (existing && existing.holder === 'bench-agent') {
        existing.claimed_at = Date.now();
        existing.release_pending = false;
        cache[FILE] = existing;
      } else {
        cache[FILE] = {
          holder: 'bench-agent',
          claimed_at: Date.now(),
          release_pending: false,
        };
      }
      writeFileSync(cachePath, JSON.stringify(cache));
    }

    for (let i = 0; i < N_WARMUP; i++) fastPath();

    const samples = new Array<number>(N_OPS);
    for (let i = 0; i < N_OPS; i++) {
      const t0 = performance.now();
      fastPath();
      const t1 = performance.now();
      samples[i] = t1 - t0;
    }

    const stats = summarize(samples);
    const targets: Target[] = [
      { metric: 'p50', value: 1, unit: 'ms', direction: 'lower' },
      { metric: 'p95', value: 3, unit: 'ms', direction: 'lower' },
    ];
    const checked = [checkTarget(stats.p50_ms, targets[0]), checkTarget(stats.p95_ms, targets[1])];
    const pass = checked.every((c) => c.pass);
    record({
      name: 'hook-cache-fast-path',
      description:
        'readFileSync + JSON.parse + mutate + JSON.stringify + writeFileSync (cache hit)',
      n_ops: N_OPS,
      warmup_ops: N_WARMUP,
      duration_ms: samples.reduce((a, b) => a + b, 0),
      ...stats,
      targets: checked,
      pass,
    });

    expect(
      checked[0].pass,
      `cache fast-path p50 ${stats.p50_ms.toFixed(3)}ms exceeds ${1 * SLACK}ms`,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bench 3 — Fail-open detection latency
// ---------------------------------------------------------------------------
//
// We replicate the EXACT call() helper used by file-coord.mjs (1.5s timeout,
// IPv4, JSON body) and measure how long it takes to resolve to null after
// the dashboard goes away. The hook treats a null response as fail-open, so
// this measures the ceiling on how long an Edit can stall when the bus is
// dead.

describe('fail-open detection latency', () => {
  let dashboard: Awaited<ReturnType<typeof startDashboard>> | null = null;
  let ctx: AppContext | null = null;
  let port = 0;

  // Pick a random high port to avoid collisions with the real dashboard if
  // it's running on 3421.
  function pickPort(): number {
    return 30000 + Math.floor(Math.random() * 30000);
  }

  beforeAll(async () => {
    ctx = createContext({ path: ':memory:' });
    port = pickPort();
    dashboard = await startDashboard(ctx, port);
  });

  afterAll(() => {
    if (dashboard) dashboard.close();
    if (ctx) ctx.close();
  });

  // Mirror of the call() helper from scripts/hooks/file-coord.mjs. Returning
  // null means "fail-open"; the hook then exits 0 and the Edit proceeds.
  function call(
    method: 'POST' | 'GET' | 'DELETE',
    path: string,
    body: object | null,
  ): Promise<{
    status: number;
    body: unknown;
  } | null> {
    return new Promise((resolve) => {
      const data = body ? JSON.stringify(body) : null;
      const req = request(
        {
          host: 'localhost',
          port,
          path,
          method,
          family: 4,
          headers: data
            ? {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(data),
              }
            : {},
          timeout: 1500,
        },
        (res) => {
          let buf = '';
          res.on('data', (c) => (buf += c));
          res.on('end', () => {
            try {
              resolve({ status: res.statusCode ?? 0, body: buf ? JSON.parse(buf) : null });
            } catch {
              resolve({ status: res.statusCode ?? 0, body: null });
            }
          });
        },
      );
      req.on('error', () => resolve(null));
      req.on('timeout', () => {
        req.destroy();
        resolve(null);
      });
      if (data) req.write(data);
      req.end();
    });
  }

  it('detects dashboard-down within 500ms', async () => {
    // Sanity check: dashboard is up
    const ok = await call('GET', '/health', null);
    expect(ok?.status).toBe(200);

    // Kill it
    if (dashboard) {
      dashboard.close();
      dashboard = null;
    }

    // Give the OS a moment to actually release the listening socket. Without
    // this, the next connect() can briefly see "connection refused" sooner
    // than a real dead-bus scenario would. We're measuring the hook-equivalent
    // path, which on Windows usually resolves via ECONNREFUSED on the next
    // connect attempt — that's what we want here.
    await new Promise((r) => setTimeout(r, 50));

    const N = 5;
    const samples = new Array<number>(N);
    for (let i = 0; i < N; i++) {
      const t0 = performance.now();
      const r = await call(
        'POST',
        `/api/state/file-locks/${encodeURIComponent('/repo/x.ts')}/cas`,
        {
          expected: null,
          new_value: 'bench',
          updated_by: 'bench',
          ttl_seconds: 300,
        },
      );
      const t1 = performance.now();
      samples[i] = t1 - t0;
      // Fail-open contract: call() must return null when the dashboard is
      // unreachable. If it returns anything else our test is wrong.
      expect(r).toBeNull();
    }

    const stats = summarize(samples);
    const targets: Target[] = [
      { metric: 'mean detection time', value: 500, unit: 'ms', direction: 'lower' },
    ];
    const checked = [checkTarget(stats.mean_ms, targets[0])];
    const pass = checked.every((c) => c.pass);
    record({
      name: 'fail-open-detection',
      description: 'time for hook call() helper to resolve null after dashboard dies',
      n_ops: N,
      warmup_ops: 0,
      duration_ms: samples.reduce((a, b) => a + b, 0),
      ...stats,
      targets: checked,
      pass,
    });

    expect(
      checked[0].pass,
      `fail-open mean ${stats.mean_ms.toFixed(3)}ms exceeds ${500 * SLACK}ms`,
    ).toBe(true);
  }, 30_000);
});

// ---------------------------------------------------------------------------
// Bench 4 — SQLite write throughput (messages table)
// ---------------------------------------------------------------------------
//
// Direct INSERT through MessageService.send into the messages table on an
// in-memory db. Mirrors the hot path the feed/messages domain takes when
// many agents are talking at once.

describe('SQLite write throughput', () => {
  let ctx: AppContext;
  let agentId: string;
  let channelId: string;

  beforeAll(() => {
    ctx = createContext({ path: ':memory:' });
    const agent = ctx.agents.register({ name: 'bench-writer' });
    agentId = agent.id;
    const channel = ctx.channels.create('bench-channel', agentId);
    channelId = channel.id;
    ctx.channels.join(channelId, agentId);
  });

  afterAll(() => {
    ctx.close();
  });

  it('messages.send >= 1000 ops/sec', () => {
    const N_WARMUP = 200;
    const N_OPS = 5_000;

    for (let i = 0; i < N_WARMUP; i++) {
      ctx.messages.send(agentId, { channel: channelId, content: `warmup-${i}` });
    }

    const t0 = performance.now();
    for (let i = 0; i < N_OPS; i++) {
      ctx.messages.send(agentId, { channel: channelId, content: `m-${i}` });
    }
    const t1 = performance.now();
    const elapsedMs = t1 - t0;
    const opsPerSec = (N_OPS / elapsedMs) * 1000;

    const targets: Target[] = [
      { metric: 'throughput', value: 1000, unit: 'ops/sec', direction: 'higher' },
    ];
    const checked = [checkTarget(opsPerSec, targets[0])];
    const pass = checked.every((c) => c.pass);
    record({
      name: 'sqlite-write-throughput',
      description: 'MessageService.send → INSERT into messages table (in-memory SQLite)',
      n_ops: N_OPS,
      warmup_ops: N_WARMUP,
      duration_ms: elapsedMs,
      mean_ms: elapsedMs / N_OPS,
      ops_per_sec: opsPerSec,
      targets: checked,
      pass,
    });

    expect(
      checked[0].pass,
      `SQLite throughput ${opsPerSec.toFixed(0)} ops/sec below ${(1000 / SLACK).toFixed(0)}`,
    ).toBe(true);
  });
});
