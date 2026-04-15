// =============================================================================
// Unit tests for benchmark metric calculators.
//
// These verify the math is correct *before* spending tokens on real agent runs.
// =============================================================================

import { describe, it, expect } from 'vitest';
import {
  type MultiAgentRun,
  type AgentRun,
  runHasCollision,
  fileCollisionRate,
  normalizeSubgoal,
  jaccard,
  countDuplicateSubgoals,
  duplicateSubgoalRate,
  tokenOverheadRatio,
  parallelismRatio,
  aggregate,
} from './metrics.js';

function mkAgent(over: Partial<AgentRun> = {}): AgentRun {
  return {
    agent: 'a',
    files_edited: [],
    subgoals: [],
    tokens: 1000,
    wall_ms: 1000,
    tests_passed: true,
    ...over,
  };
}

function mkRun(over: Partial<MultiAgentRun> = {}): MultiAgentRun {
  return {
    run_id: 'r1',
    workload: 'w',
    condition: 'control',
    agents: [],
    total_wall_ms: 1000,
    merged_tests_passed: true,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// File collision
// ---------------------------------------------------------------------------

describe('file collision', () => {
  it('no overlap, no collision', () => {
    const run = mkRun({
      agents: [
        mkAgent({ agent: 'a', files_edited: ['x.ts'] }),
        mkAgent({ agent: 'b', files_edited: ['y.ts'] }),
      ],
    });
    expect(runHasCollision(run)).toBe(false);
  });

  it('overlap with passing merge is NOT a collision', () => {
    const run = mkRun({
      merged_tests_passed: true,
      agents: [
        mkAgent({ agent: 'a', files_edited: ['x.ts'] }),
        mkAgent({ agent: 'b', files_edited: ['x.ts'] }),
      ],
    });
    expect(runHasCollision(run)).toBe(false);
  });

  it('overlap with failing merge IS a collision', () => {
    const run = mkRun({
      merged_tests_passed: false,
      agents: [
        mkAgent({ agent: 'a', files_edited: ['x.ts'] }),
        mkAgent({ agent: 'b', files_edited: ['x.ts'] }),
      ],
    });
    expect(runHasCollision(run)).toBe(true);
  });

  it('failing merge without overlap is NOT counted as collision', () => {
    const run = mkRun({
      merged_tests_passed: false,
      agents: [
        mkAgent({ agent: 'a', files_edited: ['x.ts'] }),
        mkAgent({ agent: 'b', files_edited: ['y.ts'] }),
      ],
    });
    expect(runHasCollision(run)).toBe(false);
  });

  it('aggregates rate across runs', () => {
    const collide = mkRun({
      merged_tests_passed: false,
      agents: [
        mkAgent({ agent: 'a', files_edited: ['x'] }),
        mkAgent({ agent: 'b', files_edited: ['x'] }),
      ],
    });
    const clean = mkRun();
    expect(fileCollisionRate([collide, clean, clean, clean])).toBe(0.25);
  });
});

// ---------------------------------------------------------------------------
// Sub-goal normalization + duplicates
// ---------------------------------------------------------------------------

describe('subgoal normalization', () => {
  it('strips stopwords, punctuation, lowercase', () => {
    expect(normalizeSubgoal('Add a new test for the parser!')).toEqual(
      new Set(['add', 'new', 'test', 'parser']),
    );
  });

  it('jaccard of identical sets is 1', () => {
    const a = new Set(['x', 'y']);
    expect(jaccard(a, a)).toBe(1);
  });

  it('jaccard of disjoint sets is 0', () => {
    expect(jaccard(new Set(['a']), new Set(['b']))).toBe(0);
  });

  it('jaccard of partial overlap', () => {
    expect(jaccard(new Set(['a', 'b']), new Set(['b', 'c']))).toBeCloseTo(1 / 3);
  });
});

describe('duplicate sub-goal rate', () => {
  it('two agents proposing the same subgoal counts as duplicate', () => {
    const run = mkRun({
      agents: [
        mkAgent({ agent: 'a', subgoals: ['Add a parser test'] }),
        mkAgent({ agent: 'b', subgoals: ['add parser test'] }),
      ],
    });
    const c = countDuplicateSubgoals(run);
    expect(c.total).toBe(2);
    expect(c.duplicates).toBe(2);
  });

  it('same agent proposing twice is NOT a duplicate', () => {
    const run = mkRun({
      agents: [mkAgent({ agent: 'a', subgoals: ['add test', 'add test'] })],
    });
    expect(countDuplicateSubgoals(run).duplicates).toBe(0);
  });

  it('distinct subgoals are not duplicates', () => {
    const run = mkRun({
      agents: [
        mkAgent({ agent: 'a', subgoals: ['add parser test'] }),
        mkAgent({ agent: 'b', subgoals: ['fix database migration bug'] }),
      ],
    });
    expect(countDuplicateSubgoals(run).duplicates).toBe(0);
  });

  it('matches ToM paper baseline shape: 30% redundancy', () => {
    // 10 sub-goals total, 3 are duplicates across agents.
    const run = mkRun({
      agents: [
        mkAgent({
          agent: 'a',
          subgoals: ['add parser', 'fix migration', 'write docs', 'add lint', 'refactor io'],
        }),
        mkAgent({
          agent: 'b',
          // 3 of these collide with agent a
          subgoals: ['add parser', 'fix migration', 'write docs', 'optimize db', 'add cache'],
        }),
      ],
    });
    expect(duplicateSubgoalRate([run])).toBeCloseTo(6 / 10); // both sides count
  });
});

// ---------------------------------------------------------------------------
// Tradeoff axes
// ---------------------------------------------------------------------------

describe('tradeoff axes', () => {
  it('token overhead is total/best-passing', () => {
    const run = mkRun({
      agents: [
        mkAgent({ agent: 'a', tokens: 1000, tests_passed: true }),
        mkAgent({ agent: 'b', tokens: 3000, tests_passed: true }),
      ],
    });
    expect(tokenOverheadRatio(run)).toBe(4); // 4000 / 1000
  });

  it('parallelism ratio: 2 agents 1000ms each, 1000ms wall = 2.0', () => {
    const run = mkRun({
      total_wall_ms: 1000,
      agents: [mkAgent({ wall_ms: 1000 }), mkAgent({ wall_ms: 1000 })],
    });
    expect(parallelismRatio(run)).toBe(2);
  });

  it('parallelism ratio: serial run = 1.0', () => {
    const run = mkRun({
      total_wall_ms: 2000,
      agents: [mkAgent({ wall_ms: 1000 }), mkAgent({ wall_ms: 1000 })],
    });
    expect(parallelismRatio(run)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Aggregate
// ---------------------------------------------------------------------------

describe('units_per_dollar headline metric', () => {
  it('dedupes units across agents and divides by total cost', () => {
    const run = mkRun({
      agents: [
        mkAgent({
          agent: 'a',
          units_completed: ['fnA', 'fnB'],
          cost_usd: 0.1,
          tests_passed: true,
        }),
        mkAgent({
          agent: 'b',
          units_completed: ['fnB', 'fnC'], // fnB is duplicate
          cost_usd: 0.1,
          tests_passed: true,
        }),
      ],
    });
    const r = aggregate([run]);
    expect(r.mean_unique_units).toBe(3); // fnA, fnB, fnC — fnB deduped
    expect(r.mean_total_cost_usd).toBeCloseTo(0.2);
    expect(r.units_per_dollar).toBeCloseTo(15); // 3 / 0.2
  });

  it('returns 0 units_per_dollar when cost is missing', () => {
    const run = mkRun({
      agents: [mkAgent({ units_completed: ['fnA'], tests_passed: true })],
    });
    const r = aggregate([run]);
    expect(r.units_per_dollar).toBe(0);
  });
});

describe('aggregate', () => {
  it('produces a full report from a list of runs', () => {
    const runs = [
      mkRun({
        agents: [
          mkAgent({ agent: 'a', subgoals: ['x'], files_edited: ['f'] }),
          mkAgent({ agent: 'b', subgoals: ['y'], files_edited: ['g'] }),
        ],
      }),
    ];
    const r = aggregate(runs);
    expect(r.n_runs).toBe(1);
    expect(r.file_collision_rate).toBe(0);
    expect(r.duplicate_subgoal_rate).toBe(0);
    expect(r.merged_pass_rate).toBe(1);
    expect(r.individual_pass_rate).toBe(1);
  });

  it('throws on empty run list', () => {
    expect(() => aggregate([])).toThrow();
  });
});

// ---------------------------------------------------------------------------
// coverage_fraction — graded partial-success metric
// ---------------------------------------------------------------------------

describe('coverage_fraction', () => {
  function runWithUnits(units: string[]): MultiAgentRun {
    return mkRun({
      agents: [mkAgent({ agent: 'a', units_completed: units, tests_passed: false })],
    });
  }

  it('is null when expected_units is not provided', () => {
    const r = aggregate([runWithUnits(['u1', 'u2'])]);
    expect(r.expected_units).toBeNull();
    expect(r.coverage_fraction).toBeNull();
  });

  it('is null when expected_units is explicitly null', () => {
    const r = aggregate([runWithUnits(['u1', 'u2'])], { expected_units: null });
    expect(r.expected_units).toBeNull();
    expect(r.coverage_fraction).toBeNull();
  });

  it('is null when expected_units is 0 (no fake division by zero)', () => {
    const r = aggregate([runWithUnits(['u1'])], { expected_units: 0 });
    expect(r.expected_units).toBe(0);
    expect(r.coverage_fraction).toBeNull();
  });

  it('computes 4/6 = 0.67 for partial coverage', () => {
    const r = aggregate([runWithUnits(['u1', 'u2', 'u3', 'u4'])], { expected_units: 6 });
    expect(r.expected_units).toBe(6);
    expect(r.coverage_fraction).toBeCloseTo(4 / 6);
  });

  it('is 1.0 when all expected units are delivered', () => {
    const r = aggregate([runWithUnits(['u1', 'u2', 'u3', 'u4', 'u5', 'u6'])], {
      expected_units: 6,
    });
    expect(r.coverage_fraction).toBe(1);
  });

  it('is 0 when no units are delivered', () => {
    const r = aggregate([runWithUnits([])], { expected_units: 6 });
    expect(r.coverage_fraction).toBe(0);
  });

  it('is capped at 1.0 when units exceed expected', () => {
    const r = aggregate([runWithUnits(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'])], {
      expected_units: 6,
    });
    expect(r.coverage_fraction).toBe(1);
    // mean_unique_units itself is NOT clamped — coverage is the clamp, raw count stays.
    expect(r.mean_unique_units).toBe(8);
  });

  it('averages across runs before dividing', () => {
    const r = aggregate([runWithUnits(['u1', 'u2']), runWithUnits(['u3', 'u4', 'u5', 'u6'])], {
      expected_units: 6,
    });
    // mean unique = (2 + 4) / 2 = 3 → 3/6 = 0.5
    expect(r.mean_unique_units).toBe(3);
    expect(r.coverage_fraction).toBeCloseTo(0.5);
  });
});
