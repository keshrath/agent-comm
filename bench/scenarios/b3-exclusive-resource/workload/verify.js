// =============================================================================
// B3 exclusive-resource verifier — reads invocations.jsonl (written by fake-browser.js on every
// invocation) and reports:
//   SUCCESSES=<n>            agents that completed without "already running"
//   FAILURES=<n>             agents that hit "already running"
//   STOMPED=<n>              agents whose PID file was overwritten mid-run
//   TOTAL_INVOCATIONS=<n>
//   PID_FILE_LEAKED=<0|1>    did we leave a stale PID file behind?
//   PASSED_FNS=agent1,agent2 agents that succeeded (for the existing runner proto)
//
// Exit is always 0 — driver parses + decides pass/fail.
// =============================================================================

const fs = require('fs');
const path = require('path');

const LOG_FILE = path.join(__dirname, 'invocations.jsonl');
const PID_FILE = path.join(__dirname, 'browser.pid');

const byAgent = new Map();
let total = 0;
let successes = 0;
let failures = 0;
let stomped = 0;

try {
  const raw = fs.readFileSync(LOG_FILE, 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    total += 1;
    const agent = String(obj.agent ?? 'unknown');
    if (!byAgent.has(agent)) {
      byAgent.set(agent, { claims: 0, successes: 0, failures: 0, stomped: 0 });
    }
    const a = byAgent.get(agent);
    if (obj.outcome === 'claim') a.claims += 1;
    if (obj.outcome === 'done') {
      a.successes += 1;
      successes += 1;
    }
    if (obj.outcome === 'already-running') {
      a.failures += 1;
      failures += 1;
    }
    if (obj.outcome === 'done-but-stomped') {
      // Stomped = the agent's PID got overwritten before it cleaned up, but
      // the agent did finish its work. We count this as a concurrency issue
      // (not a clean success).
      a.stomped += 1;
      a.successes += 1;
      successes += 1;
      stomped += 1;
    }
  }
} catch {
  // No log file — nothing ran. Reported as all-zero.
}

const pidLeaked = fs.existsSync(PID_FILE) ? 1 : 0;

const passed = [];
for (const [agent, a] of byAgent.entries()) {
  if (a.successes > 0 && a.failures === 0 && a.stomped === 0) passed.push(agent);
}

console.log(`PASSED_FNS=${passed.join(',')}`);
console.log(`SUCCESSES=${successes}`);
console.log(`FAILURES=${failures}`);
console.log(`STOMPED=${stomped}`);
console.log(`TOTAL_INVOCATIONS=${total}`);
console.log(`PID_FILE_LEAKED=${pidLeaked}`);
