#!/usr/bin/env node
// =============================================================================
// agent-comm workspace-awareness hook (SessionStart)
//
// Registers this Claude session as a worker in the current workspace and
// injects context about OTHER active sessions in the same workspace, plus
// recent file edits by other sessions, so the agent doesn't form its plan
// unaware of who else is here.
//
// Companion: bash-guard.mjs intercepts dangerous Bash commands (git commit,
// npm test, npm install, etc.) and blocks/warns when they would conflict
// with another session's WIP. Together they close the loop on the
// "two terminals, same workspace, no awareness" temporal-overlap problem.
//
// Storage: writes to comm_state namespace `workspace-agents` with key
// `<workspace_hash>:<agent_id>` and value JSON {workspace, agent, started_at}.
// TTL 4 hours; the existing on-stop.js hook handles cleanup on session end.
// =============================================================================

import { basename } from 'node:path';
import {
  AGENT_ID,
  WORKSPACE_NS,
  call,
  workspaceHash,
  ageString,
  readStdinJson,
  listWorkspaceAgents,
  listFilesEdited,
  filterEditsToWorkspace,
  filterEditsByOthers,
} from './_agent-comm-rest.mjs';
import { signalFailOpen } from './_fail-open.mjs';

const PORT = parseInt(process.env.AGENT_COMM_PORT ?? '3421', 10);
const TTL_SECONDS = parseInt(process.env.AGENT_COMM_WORKSPACE_TTL ?? '14400', 10); // 4h

async function main() {
  const payload = await readStdinJson();
  const workspace = payload.cwd || process.cwd();
  const wsHash = workspaceHash(workspace);
  const wsName = basename(workspace) || workspace;
  const myKey = `${wsHash}:${AGENT_ID}`;

  // Register self in workspace-agents.
  const startedAt = new Date().toISOString();
  const reg = await call(
    'POST',
    `/api/state/${encodeURIComponent(WORKSPACE_NS)}/${encodeURIComponent(myKey)}`,
    {
      value: JSON.stringify({ workspace, agent: AGENT_ID, started_at: startedAt }),
      updated_by: AGENT_ID,
      ttl_seconds: TTL_SECONDS,
    },
  );
  if (!reg) {
    // Dashboard unreachable — we can't register, can't list others, and can't
    // read file-edits. The SessionStart context will be empty and the user
    // has no indication coordination is broken. Surface it explicitly.
    await signalFailOpen('workspace-awareness', 'dashboard-unreachable', {
      workspace,
    });
    // Still emit a minimal SessionStart payload so Claude Code doesn't hang.
    const out = {
      systemMessage: `agent-comm: workspace ${wsName} (coordination offline)`,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: `agent-comm dashboard: http://localhost:${PORT} (UNREACHABLE — workspace coordination is OFFLINE; hooks are failing open)`,
      },
    };
    console.log(JSON.stringify(out));
    return;
  }

  const allAgents = await listWorkspaceAgents(workspace);
  const others = allAgents.filter((a) => a.agent !== AGENT_ID);

  const allEdits = await listFilesEdited();
  const wsEdits = filterEditsToWorkspace(allEdits, workspace);
  const otherEdits = filterEditsByOthers(wsEdits, AGENT_ID).slice(0, 5);

  // Factual discovery only. We deliberately do NOT inject prescriptive advice
  // ("Before editing files, check the dashboard...") — bench B12/B13 showed
  // the model treats such advisory text as flavor and ignores it during
  // focused work. Active enforcement (bash-guard, file-coord) handles the
  // safety contracts. This hook just surfaces the facts; what the agent does
  // with them is its own judgment, prompt-contract-driven.
  let context = `agent-comm dashboard: http://localhost:${PORT}\nworkspace: ${wsName} (${workspace})`;

  if (others.length > 0) {
    context += `\n\nOther Claude session(s) active in this workspace:`;
    for (const o of others) {
      context += `\n  - ${o.agent} (started ${ageString(o.started_at)})`;
    }
  }

  if (otherEdits.length > 0) {
    context += `\n\nRecent file edits in this workspace by other sessions:`;
    for (const e of otherEdits) {
      context += `\n  - ${e.file} — ${e.editor} (${ageString(e.when)})`;
    }
  }

  const out = {
    systemMessage: `agent-comm: workspace ${wsName} (${others.length} other session(s) active)`,
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  };
  console.log(JSON.stringify(out));
}

main().catch(() => process.exit(0));
