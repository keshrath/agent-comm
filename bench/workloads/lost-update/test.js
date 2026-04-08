// DO NOT EDIT — verifier for the lost-update workload. `node test.js`.
// Reads state.json and reports how many items are present. The bench
// expects 3 items (one per agent). If fewer are present, agents stomped
// on each other's writes — the classic lost-update race.

const fs = require('fs');

let state;
try {
  state = JSON.parse(fs.readFileSync('./state.json', 'utf8'));
} catch (e) {
  console.error('LOAD ERROR:', e.message);
  console.log('PASSED_FNS=');
  console.log('PASSED=0/3');
  process.exit(1);
}

const items = Array.isArray(state.items) ? state.items : [];
const expected = 3;

const slugs = items.map((it, i) => {
  const s = String(it).replace(/[^a-zA-Z0-9]/g, '_');
  return s || `item_${i}`;
});

console.log(`PASSED_FNS=${slugs.join(',')}`);
console.log(`PASSED=${items.length}/${expected}`);
if (items.length < expected) {
  console.error(
    `MISSING: only ${items.length}/${expected} items survived (lost ${expected - items.length} to race)`,
  );
  process.exit(1);
}
