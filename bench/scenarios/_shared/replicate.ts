// =============================================================================
// Shared replicate + variance helper — single source of truth for every
// bench scenario that runs N replicates of a condition and reports
// mean/stddev/min/max across them, with an optional cumulative-cost cap so
// an expensive scenario can stop early instead of draining the wallet.
//
// Used by every bench scenario under bench/scenarios/. Each scenario supplies
// a per-replicate function that returns a numeric-keyed result object; this
// module handles:
//   - looping n times (with optional early-stop on budget)
//   - cumulative cost tracking
//   - producing a structured aggregate (mean/stddev/min/max per metric)
//   - harmonized CLI parsing for --n and --max-cost-usd
//
// Shape-agnostic: callers pick which keys are "numeric metrics" and which
// are passthrough (conditions, booleans, arrays). We only aggregate numeric
// keys that are present on every replicate; everything else rolls up as the
// raw per-replicate array.
// =============================================================================

export interface ReplicateLoopOpts<R> {
  /** How many replicates to attempt. Hard ceiling. */
  n: number;
  /** Cumulative USD budget across replicates. The loop stops BEFORE the
   * next replicate if running total already exceeds this value. 0 or
   * Infinity disables the cap. */
  maxCostUsd: number;
  /** Function that reads `r.total_cost_usd ?? r.cost_usd ?? 0` off each
   * replicate result. Provided so the shape of `R` stays free-form. */
  costOf: (r: R) => number;
  /** Per-iteration label (used in log output). */
  label: string;
  /** Called once per replicate. If it throws, the loop stops and re-throws. */
  run: (rep: number) => Promise<R>;
  /** Optional logger. Defaults to console.log. */
  log?: (msg: string) => void;
}

export interface ReplicateLoopResult<R> {
  /** All replicates that completed (length <= n). */
  completed: R[];
  /** Cumulative cost of the completed replicates. */
  totalCostUsd: number;
  /** True iff the budget cap stopped us before reaching n. */
  stoppedEarly: boolean;
  /** Reason we stopped early, if applicable. */
  stopReason?: string;
}

/** Run up to `n` replicates, stopping early if cumulative cost exceeds the
 * cap. Always returns whatever completed (partial results are still useful
 * for diagnosis). */
export async function runReplicates<R>(
  opts: ReplicateLoopOpts<R>,
): Promise<ReplicateLoopResult<R>> {
  const log = opts.log ?? ((m: string) => console.log(m));
  const completed: R[] = [];
  let totalCostUsd = 0;
  let stoppedEarly = false;
  let stopReason: string | undefined;
  const cap = Number.isFinite(opts.maxCostUsd) && opts.maxCostUsd > 0 ? opts.maxCostUsd : Infinity;

  for (let i = 0; i < opts.n; i++) {
    if (totalCostUsd >= cap) {
      stoppedEarly = true;
      stopReason = `cumulative cost $${totalCostUsd.toFixed(2)} hit cap $${cap.toFixed(2)} before replicate ${i + 1}/${opts.n}`;
      log(`[${opts.label}] BUDGET CAP HIT — ${stopReason}`);
      break;
    }
    const r = await opts.run(i + 1);
    completed.push(r);
    totalCostUsd += opts.costOf(r);
  }

  return { completed, totalCostUsd, stoppedEarly, stopReason };
}

// ---------------------------------------------------------------------------
// Stats helpers
// ---------------------------------------------------------------------------

export interface Stats {
  mean: number;
  stddev: number;
  min: number;
  max: number;
  n: number;
}

export function statsOf(xs: number[]): Stats {
  const n = xs.length;
  if (n === 0) return { mean: 0, stddev: 0, min: 0, max: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  // Population stddev (not sample) — matches existing b1 behavior. Bench is
  // descriptive, not inferential, so we don't want n-1 Bessel correction.
  const v = xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n;
  return {
    mean,
    stddev: Math.sqrt(v),
    min: Math.min(...xs),
    max: Math.max(...xs),
    n,
  };
}

export function formatStats(s: Stats, digits = 3): string {
  return `${s.mean.toFixed(digits)} +/- ${s.stddev.toFixed(digits)} (min ${s.min.toFixed(digits)}, max ${s.max.toFixed(digits)}, n=${s.n})`;
}

/** Aggregate a list of replicate records into a { metric: Stats } object,
 * picking only keys where every record carries a finite number. Other keys
 * are ignored (callers can pull per-replicate raw values from the input
 * list directly). */
export function aggregateNumeric<R extends Record<string, unknown>>(
  records: R[],
  metrics: Array<keyof R>,
): Record<string, Stats> {
  const out: Record<string, Stats> = {};
  for (const key of metrics) {
    const xs: number[] = [];
    for (const r of records) {
      const v = r[key];
      if (typeof v === 'number' && Number.isFinite(v)) xs.push(v);
    }
    if (xs.length === 0) continue;
    out[String(key)] = statsOf(xs);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Shared CLI flag parsing — every scenario supports the same --n and
// --max-cost-usd semantics.
// ---------------------------------------------------------------------------

export interface SharedArgs {
  /** Replicate count, default 5 for B1 / 3 for B2/B3 (callers pass the
   * default they want). */
  n: number;
  /** Cumulative cost cap in USD. Default $15; caller can override. */
  maxCostUsd: number;
}

/** Extract --n / --max-cost-usd (also accepts env: AGENT_COMM_BENCH_MAX_COST_USD).
 * Unrecognized args are ignored — the caller owns full argv parsing. */
export function parseSharedArgs(
  argv: string[],
  defaults: { n: number; maxCostUsd: number },
): SharedArgs {
  function flag(name: string): string | undefined {
    const eq = argv.find((a) => a.startsWith(`--${name}=`));
    if (eq) return eq.slice(name.length + 3);
    const idx = argv.indexOf(`--${name}`);
    if (idx >= 0 && argv[idx + 1] && !argv[idx + 1].startsWith('--')) return argv[idx + 1];
    return undefined;
  }
  const nRaw = flag('n');
  const n = nRaw ? Number(nRaw) : defaults.n;
  const capRaw = flag('max-cost-usd') ?? process.env.AGENT_COMM_BENCH_MAX_COST_USD;
  const maxCostUsd = capRaw ? Number(capRaw) : defaults.maxCostUsd;
  return {
    n: Number.isFinite(n) && n > 0 ? n : defaults.n,
    maxCostUsd: Number.isFinite(maxCostUsd) && maxCostUsd > 0 ? maxCostUsd : defaults.maxCostUsd,
  };
}
