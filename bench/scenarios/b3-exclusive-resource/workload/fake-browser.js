// =============================================================================
// Fake singleton "browser" — simulates a playwright-like resource that fails
// if two agents invoke it concurrently. Detection via a PID file: if one
// already exists, we exit non-zero with "already running". Otherwise we write
// our PID, simulate work, then delete the PID file.
//
// Two important properties for B3:
//   1. PID-file check and PID-file write are NOT atomic — there is a
//      deliberate ~500ms pre-sleep between the two so parallel invocations
//      from the Claude CLI (each a separate node process) have a reliable
//      race window.
//   2. Every invocation appends one line to invocations.jsonl so the
//      verifier can see how many agents actually ran the binary, the
//      outcome, and when. The agent name is taken from AGENT_COMM_ID (set
//      by the bench CLI driver per agent).
// =============================================================================

const fs = require('fs');
const path = require('path');

const PID_FILE = path.join(__dirname, 'browser.pid');
const LOG_FILE = path.join(__dirname, 'invocations.jsonl');
const AGENT = process.env.AGENT_COMM_ID || 'unknown';
const PID = process.pid;
const startIso = new Date().toISOString();

function logLine(obj) {
  try {
    fs.appendFileSync(LOG_FILE, JSON.stringify(obj) + '\n');
  } catch {
    /* best effort */
  }
}

async function main() {
  // 1. Check for existing PID file (simulated singleton detection).
  if (fs.existsSync(PID_FILE)) {
    const holder = (() => {
      try {
        return fs.readFileSync(PID_FILE, 'utf8').trim();
      } catch {
        return '?';
      }
    })();
    logLine({
      agent: AGENT,
      pid: PID,
      outcome: 'already-running',
      holder,
      start: startIso,
    });
    console.error(`fake-browser: already running (pid=${holder})`);
    process.exit(2);
  }

  // 2. Deliberate pre-write sleep: widens the race window. Without this the
  //    node-spawn syscall overhead often serializes by accident, defeating the
  //    naive baseline. With 500ms, parallel invocations reliably collide.
  await new Promise((r) => setTimeout(r, 500));

  // 3. Claim the PID file. If two agents raced past step 1, both will write
  //    here; the last writer wins but both "think" they hold the resource.
  fs.writeFileSync(PID_FILE, String(PID));
  logLine({
    agent: AGENT,
    pid: PID,
    outcome: 'claim',
    start: startIso,
  });

  // 4. Simulate browser work.
  await new Promise((r) => setTimeout(r, 2500));

  // 5. Release — but only if it's still OUR pid (another agent may have
  //    overwritten). Either way we log the result.
  let releasedOk = false;
  try {
    const held = fs.readFileSync(PID_FILE, 'utf8').trim();
    if (held === String(PID)) {
      fs.unlinkSync(PID_FILE);
      releasedOk = true;
    }
  } catch {
    /* file vanished under us — someone else cleaned it */
  }
  logLine({
    agent: AGENT,
    pid: PID,
    outcome: releasedOk ? 'done' : 'done-but-stomped',
    end: new Date().toISOString(),
  });
  console.log('done');
}

main().catch((err) => {
  logLine({
    agent: AGENT,
    pid: PID,
    outcome: 'exception',
    error: String(err),
  });
  console.error('fake-browser: exception', err);
  process.exit(3);
});
