// =============================================================================
// B14 cross-session verifier — `node verify.js`.
//
// Reads the shared run dir after two sequential agents (A then B) finished.
// A task is "completed" iff report-<id>.md exists AND contains non-whitespace.
//
// Every report MUST include a leading marker line like
//   `# report — written by agentA`
// so the verifier can tell who wrote it. The prompts instruct agents to emit
// this line. If the marker is missing, the report is still counted in
// unique_reports but attributed to "unknown".
//
// Duplicate-work detection: agents also append events to claims.jsonl. A
// "work" event is logged whenever an agent writes a report. If two agents
// logged work events for the same task (or both appear as authors of the
// same report's marker line across runs), that's duplicate work. The B14
// flow is sequential, so the second writer OVERWRITES the file — we cannot
// detect duplication from files alone. claims.jsonl is the source of truth.
//
// Reports:
//   PASSED_FNS=task-1_<ok>,task-2_<ok>,...  — per-item completion
//   UNIQUE_REPORTS=<n>                       — distinct report files with content
//   EXPECTED_TASKS=4
//   TASKS_BY_A=<n>                           — work events logged by agentA
//   TASKS_BY_B=<n>                           — work events logged by agentB
//   DUPLICATE_WORK_COUNT=<n>                 — tasks worked by >1 agent
//   PASSED=<unique_reports>/4
//
// Exit code is always 0 — the driver parses the metrics itself.
// =============================================================================

const fs = require('fs');
const path = require('path');

const EXPECTED_TASKS = ['task-1', 'task-2', 'task-3', 'task-4'];

const reports = {};
for (const id of EXPECTED_TASKS) {
  const p = path.join('.', `report-${id}.md`);
  try {
    const content = fs.readFileSync(p, 'utf8');
    if (content.trim().length > 0) reports[id] = content;
  } catch {
    /* missing */
  }
}

// Parse claims.jsonl: {"event":"work","agent":"agentA","task":"task-1","ts":"..."}
const taskWorkers = {}; // task-id -> Set of agent names
let tasksByA = 0;
let tasksByB = 0;
try {
  const raw = fs.readFileSync('./claims.jsonl', 'utf8');
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed);
      if (obj.event !== 'work') continue;
      if (typeof obj.agent !== 'string' || typeof obj.task !== 'string') continue;
      if (!EXPECTED_TASKS.includes(obj.task)) continue;
      if (!taskWorkers[obj.task]) taskWorkers[obj.task] = new Set();
      taskWorkers[obj.task].add(obj.agent);
      if (obj.agent === 'agentA') tasksByA += 1;
      else if (obj.agent === 'agentB') tasksByB += 1;
    } catch {
      /* skip malformed */
    }
  }
} catch {
  // No log — degrade gracefully.
}

let duplicateWorkCount = 0;
for (const id of EXPECTED_TASKS) {
  const workers = taskWorkers[id];
  if (workers && workers.size > 1) duplicateWorkCount += workers.size - 1;
}

const uniqueReports = Object.keys(reports).length;
const slugs = EXPECTED_TASKS.map((id) => `${id}_${reports[id] ? 1 : 0}`);

console.log(`PASSED_FNS=${slugs.join(',')}`);
console.log(`UNIQUE_REPORTS=${uniqueReports}`);
console.log(`EXPECTED_TASKS=${EXPECTED_TASKS.length}`);
console.log(`TASKS_BY_A=${tasksByA}`);
console.log(`TASKS_BY_B=${tasksByB}`);
console.log(`DUPLICATE_WORK_COUNT=${duplicateWorkCount}`);
console.log(`PASSED=${uniqueReports}/${EXPECTED_TASKS.length}`);
