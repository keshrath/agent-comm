// =============================================================================
// B2 pipeline-claim verifier — `node verify.js`.
//
// Reads the shared run dir after N agents finished. A task is "completed"
// iff report-<id>.md exists AND contains non-whitespace content.
//
// Duplicate-work detection: each agent appends events to claims.jsonl. An
// "attempt" event is logged at the start of every claim try (outcome won/lost).
// A "work" event is logged whenever the agent writes report content for a
// task. If two DIFFERENT agents log work events for the same task, that's
// duplicate work.
//
// Reports:
//   PASSED_FNS=task-1_<ok>,task-2_<ok>,...         — per-item completion
//   UNIQUE_TASKS=<n>                               — distinct report files with content
//   EXPECTED_TASKS=4
//   CLAIMS_ATTEMPTED=<n>                           — total attempt events
//   CLAIMS_WON=<n>                                 — attempts with outcome="won"
//   DUPLICATE_WORK_COUNT=<n>                       — agents who did work on an already-claimed task
//   PASSED=<unique_tasks>/4
//
// Exit code is always 0 — the driver parses the metrics itself.
// =============================================================================

const fs = require('fs');
const path = require('path');

const EXPECTED_TASKS = ['task-1', 'task-2', 'task-3', 'task-4'];

// Scan the cwd (= shared run dir) for report-<id>.md files with content.
const reports = {};
for (const id of EXPECTED_TASKS) {
  const p = path.join('.', `report-${id}.md`);
  try {
    const content = fs.readFileSync(p, 'utf8');
    if (content.trim().length > 0) {
      reports[id] = content;
    }
  } catch {
    /* missing */
  }
}

// Parse claims.jsonl — one JSON line per event.
// Shape:  {"event":"attempt","agent":"a0","task":"task-1","outcome":"won"|"lost","ts":"..."}
//         {"event":"work","agent":"a0","task":"task-1","ts":"..."}
let claimsAttempted = 0;
let claimsWon = 0;
const taskWorkers = {}; // task-id -> Set of agent names who logged a work event

try {
  const raw = fs.readFileSync('./claims.jsonl', 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (typeof obj.agent !== 'string' || typeof obj.task !== 'string') continue;
      if (!EXPECTED_TASKS.includes(obj.task)) continue;
      if (obj.event === 'attempt') {
        claimsAttempted += 1;
        if (obj.outcome === 'won') claimsWon += 1;
      } else if (obj.event === 'work') {
        if (!taskWorkers[obj.task]) taskWorkers[obj.task] = new Set();
        taskWorkers[obj.task].add(obj.agent);
      }
    } catch {
      /* skip malformed */
    }
  }
} catch {
  // No claims log — duplicate detection degrades gracefully.
}

// Duplicate work: for each task, if more than one agent did work, the extras
// count as duplicates. (First agent on a task is "legitimate"; every
// additional agent is redundant.)
let duplicateWorkCount = 0;
for (const id of EXPECTED_TASKS) {
  const workers = taskWorkers[id];
  if (workers && workers.size > 1) {
    duplicateWorkCount += workers.size - 1;
  }
}

const uniqueTasks = Object.keys(reports).length;
const slugs = EXPECTED_TASKS.map((id) => `${id}_${reports[id] ? 1 : 0}`);

console.log(`PASSED_FNS=${slugs.join(',')}`);
console.log(`UNIQUE_TASKS=${uniqueTasks}`);
console.log(`EXPECTED_TASKS=${EXPECTED_TASKS.length}`);
console.log(`CLAIMS_ATTEMPTED=${claimsAttempted}`);
console.log(`CLAIMS_WON=${claimsWon}`);
console.log(`DUPLICATE_WORK_COUNT=${duplicateWorkCount}`);
console.log(`PASSED=${uniqueTasks}/${EXPECTED_TASKS.length}`);
