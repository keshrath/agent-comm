// DO NOT EDIT — verifier for the shared-routes workload. `node test.js`.
// Loads the SHARED routes.js, checks how many of the expected routes are
// registered, and emits a machine-parseable PASSED_FNS line for the bench.
//
// Each agent in the bench is supposed to add ONE route. The bench succeeds
// when ALL agents' routes are present in the final routes.js — i.e., no edit
// was lost to a race condition or overwrite.

const expectedRoutes = [
  ['GET', '/api/users'],
  ['POST', '/api/users'],
  ['GET', '/api/posts'],
  ['POST', '/api/posts'],
  ['GET', '/api/comments'],
  ['POST', '/api/comments'],
];

let routes;
try {
  ({ routes } = require('./routes.js'));
} catch (e) {
  console.error('LOAD ERROR:', e.message);
  console.log('PASSED_FNS=');
  console.log('PASSED=0/' + expectedRoutes.length);
  process.exit(1);
}

const present = [];
const missing = [];
for (const [method, path] of expectedRoutes) {
  const key = `${method} ${path}`;
  const found = routes.some((r) => r.method === method && r.path === path);
  if (found) present.push(key);
  else missing.push(key);
}

for (const m of missing) console.error(`MISSING: ${m}`);

// Use slugs (no spaces) so the bench's PASSED_FNS parsing works.
const slugs = present.map((k) => k.replace(/[^a-zA-Z0-9]/g, '_'));
console.log(`PASSED_FNS=${slugs.join(',')}`);
console.log(`PASSED=${present.length}/${expectedRoutes.length}`);
if (missing.length) process.exit(1);
