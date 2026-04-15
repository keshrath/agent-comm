#!/usr/bin/env node
// B15 verify — no-op. Metric extraction happens in the driver by reading
// analysis.md from the shared dir and checking whether it contains "PIVOTED".
// This script exists only so the cli driver's testCmd has something to spawn
// that exits 0.
console.log('PASSED_FNS=b15-noop');
process.exit(0);
