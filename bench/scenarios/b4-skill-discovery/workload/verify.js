// =============================================================================
// B10 skill-discovery verifier. Reads the coordinator's found-agent.txt from
// the shared workspace and emits metrics the driver picks up.
//
// Fields (driver reads them directly from the fs, so verify.js output is just
// informational for local debugging):
//   PASSED_FNS=<worker-name-or-empty>
//   FOUND=<contents>
// =============================================================================

const fs = require('fs');

let found = '';
try {
  found = fs.readFileSync('./found-agent.txt', 'utf8').trim();
} catch {
  /* missing — coordinator failed to write */
}

console.log(`PASSED_FNS=${found}`);
console.log(`FOUND=${found}`);
