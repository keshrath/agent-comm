#!/usr/bin/env node
// =============================================================================
// agent-comm bash-guard hook (PreToolUse on Bash)
//
// Single hook that intercepts Bash tool calls, matches the command against a
// RULES table, and runs the appropriate coordination check. Each rule decides
// whether to ALLOW, WARN (allow but inject context), or BLOCK (exit 2 with
// stderr message that Claude surfaces to the model).
//
// This is the "force coordination at workspace-wide moments" layer. It catches
// the temporal-overlap failure modes that the file-coord hook can't see:
//
//   git commit  → staged files include another session's WIP → BLOCK
//   git push    → same as commit + branch ownership → BLOCK
//   npm install → package.json edited by another session → BLOCK
//   npm test    → another session has uncommitted edits in workspace → WARN
//   npm run build / tsc → same → WARN
//   prisma migrate / rails db:migrate → DB coordination needed → BLOCK
//   npm run dev / serve → port collision risk → WARN
//
// Adding a new scenario means adding ONE entry to RULES below. The framework
// is small and the hook stays single-purpose.
//
// Fail-soft: if the dashboard isn't reachable, the hook ALLOWS (never blocks
// real work because the bus is down). All checks have a 1.5s REST timeout.
// =============================================================================

import { spawnSync } from 'node:child_process';
import {
  AGENT_ID,
  call,
  ageString,
  ageMs,
  readStdinJson,
  listFilesEdited,
  filterEditsToWorkspace,
  filterEditsByOthers,
  normPath,
} from './_agent-comm-rest.mjs';
import { signalFailOpen, signalBlock } from './_fail-open.mjs';

// Probe REST once per invocation. If the dashboard can't be reached, every
// rule.check() would run on empty files-edited data — indistinguishable from
// "no conflict" — so we need an explicit fail-open signal.
async function probeRest() {
  const r = await call('GET', `/api/state?namespace=files-edited`, null);
  return r && r.status === 200;
}

// How recent is "recent" for warnings (10 minutes by default).
const RECENT_MS = parseInt(process.env.AGENT_COMM_RECENT_EDIT_MS ?? '600000', 10);

// ---------------------------------------------------------------------------
// Rule table — add a new entry here to enforce coordination on a new scenario
// ---------------------------------------------------------------------------

const RULES = [
  {
    name: 'git-commit',
    description: "block commits that include another session's WIP",
    match: (cmd) => /\bgit\s+commit\b/.test(cmd) && !/--help|-h\b/.test(cmd),
    check: checkStagedFilesAgainstOthers,
  },
  {
    name: 'git-push',
    description: 'warn before pushing if other sessions have local-only edits',
    match: (cmd) => /\bgit\s+push\b/.test(cmd) && !/--help|-h\b/.test(cmd),
    check: checkUnpushedAgainstOthers,
  },
  {
    name: 'pkg-install',
    description: 'block npm/pnpm/yarn install if another session is editing package.json',
    match: (cmd) => /\b(npm|pnpm|yarn)\s+(install|i|add|remove|rm|uninstall)\b/.test(cmd),
    check: checkPackageJsonOthers,
  },
  {
    name: 'tests',
    description: 'warn before running tests if another session has WIP in the workspace',
    match: (cmd) =>
      /\b(npm\s+test|pnpm\s+test|yarn\s+test|npm\s+run\s+test|vitest|jest|pytest|cargo\s+test|go\s+test)\b/.test(
        cmd,
      ),
    check: warnIfWorkspaceHasOtherWip,
  },
  {
    name: 'build',
    description: 'warn before build if another session has source-tree WIP',
    match: (cmd) =>
      /\b(npm\s+run\s+build|pnpm\s+run\s+build|yarn\s+build|tsc\b|cargo\s+build|go\s+build)\b/.test(
        cmd,
      ),
    check: warnIfWorkspaceHasOtherWip,
  },
  {
    name: 'migrations',
    description: 'block schema migrations if another session is migrating the same DB',
    match: (cmd) =>
      /\b(prisma\s+migrate|rails\s+db:migrate|alembic\s+upgrade|knex\s+migrate|drizzle-kit\s+migrate)\b/.test(
        cmd,
      ),
    check: checkMigrationsOthers,
  },
  {
    name: 'dev-server',
    description: 'warn before starting dev server if another session may already have one running',
    match: (cmd) => /\b(npm\s+run\s+dev|pnpm\s+dev|yarn\s+dev|next\s+dev|vite\b)/.test(cmd),
    check: warnIfWorkspaceHasOtherSession,
  },
];

// ---------------------------------------------------------------------------

function git(args, cwd) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (r.status !== 0) return null;
  return r.stdout;
}

function gitStaged(cwd) {
  const out = git(['diff', '--cached', '--name-only'], cwd);
  if (out == null) return null;
  return out.split('\n').filter(Boolean);
}

function gitModifiedTracked(cwd) {
  const out = git(['diff', '--name-only'], cwd);
  if (out == null) return [];
  return out.split('\n').filter(Boolean);
}

function commitUsesDashA(cmd) {
  if (/(^|\s)--all(\s|$|=)/.test(cmd)) return true;
  for (const tok of cmd.split(/\s+/)) {
    if (tok.startsWith('--')) continue;
    if (!tok.startsWith('-')) continue;
    if (/^-[A-Za-z]*a[A-Za-z]*$/.test(tok)) return true;
  }
  return false;
}

function gitUnpushed(cwd) {
  // Files with local changes (staged or unstaged) — proxy for "what could be in this push"
  const out = git(['diff', '--name-only', 'HEAD'], cwd);
  if (out == null) return null;
  return out.split('\n').filter(Boolean);
}

async function recentOtherEditsForFiles(workspace, files) {
  const all = await listFilesEdited();
  const ws = filterEditsToWorkspace(all, workspace);
  const other = filterEditsByOthers(ws, AGENT_ID);
  const recent = other.filter((e) => ageMs(e.when) <= RECENT_MS);
  // Normalized match — staged files are usually relative ('foo.ts'), recorded
  // edits are usually absolute ('C:/tmp/.../foo.ts'). Compare by normalized
  // path with both endsWith and substring fallbacks.
  const stagedNorm = files.map(normPath);
  return recent.filter((e) => {
    const f = normPath(e.file);
    return stagedNorm.some((s) => f === s || f.endsWith('/' + s) || f.endsWith(s));
  });
}

async function checkStagedFilesAgainstOthers(cmd, cwd) {
  const staged = gitStaged(cwd);
  if (staged == null) return { allow: true }; // not a git repo, nothing to check
  let effective = staged;
  if (commitUsesDashA(cmd)) {
    const modified = gitModifiedTracked(cwd);
    effective = [...new Set([...staged, ...modified])];
  }
  if (effective.length === 0) return { allow: true }; // empty commit
  const conflicts = await recentOtherEditsForFiles(cwd, effective);
  if (conflicts.length === 0) return { allow: true };
  const lines = conflicts
    .slice(0, 8)
    .map((c) => `  - ${c.file} (edited by ${c.editor}, ${ageString(c.when)})`)
    .join('\n');
  return {
    allow: false,
    reason:
      `BLOCKED: git commit includes ${conflicts.length} file(s) recently edited by other ` +
      `Claude session(s) in this workspace:\n${lines}\n\nThese may be WIP from another task. ` +
      `Inspect each with \`git diff <file>\` and confirm the changes belong to YOUR work, then either:\n` +
      `  (a) git restore <file> if the changes aren't yours\n` +
      `  (b) coordinate via mcp__agent-comm__comm_send with the other agent before committing\n` +
      `  (c) re-stage selectively with git add -p to isolate your work\n` +
      `Then re-run the commit. (To bypass this check intentionally, set AGENT_COMM_GUARD_BYPASS=1.)`,
  };
}

async function checkUnpushedAgainstOthers(_cmd, cwd) {
  const dirty = gitUnpushed(cwd);
  if (dirty == null || dirty.length === 0) return { allow: true };
  const conflicts = await recentOtherEditsForFiles(cwd, dirty);
  if (conflicts.length === 0) return { allow: true };
  const lines = conflicts
    .slice(0, 8)
    .map((c) => `  - ${c.file} (edited by ${c.editor}, ${ageString(c.when)})`)
    .join('\n');
  return {
    allow: false,
    reason:
      `BLOCKED: git push from a workspace where other Claude session(s) have recent local edits ` +
      `to files in your branch:\n${lines}\n\nIf you push now you may publish another session's WIP. ` +
      `Coordinate via mcp__agent-comm__comm_send first, or set AGENT_COMM_GUARD_BYPASS=1 to override.`,
  };
}

async function checkPackageJsonOthers(_cmd, cwd) {
  const all = await listFilesEdited();
  const ws = filterEditsToWorkspace(all, cwd);
  const other = filterEditsByOthers(ws, AGENT_ID);
  const recent = other.filter((e) => ageMs(e.when) <= RECENT_MS);
  const pkgEdits = recent.filter((e) =>
    /(?:^|[\\/])package\.json$|(?:^|[\\/])pnpm-lock\.yaml$|(?:^|[\\/])yarn\.lock$|(?:^|[\\/])package-lock\.json$/.test(
      e.file,
    ),
  );
  if (pkgEdits.length === 0) return { allow: true };
  const lines = pkgEdits
    .map((e) => `  - ${e.file} (edited by ${e.editor}, ${ageString(e.when)})`)
    .join('\n');
  return {
    allow: false,
    reason:
      `BLOCKED: another Claude session has recent edits to package files:\n${lines}\n\n` +
      `Running install now will produce a lockfile that may conflict with their changes. ` +
      `Coordinate via mcp__agent-comm__comm_send or wait for the other session to commit, then re-run.`,
  };
}

async function warnIfWorkspaceHasOtherWip(_cmd, cwd) {
  const all = await listFilesEdited();
  const ws = filterEditsToWorkspace(all, cwd);
  const other = filterEditsByOthers(ws, AGENT_ID);
  const recent = other.filter((e) => ageMs(e.when) <= RECENT_MS);
  if (recent.length === 0) return { allow: true };
  // Warning, not block — surface a system message via stderr but exit 0 so
  // the command runs. Claude Code shows hook stderr as a notification.
  const lines = recent
    .slice(0, 5)
    .map((e) => `  - ${e.file} (${e.editor}, ${ageString(e.when)})`)
    .join('\n');
  process.stderr.write(
    `agent-comm: NOTE — another Claude session has recent WIP in this workspace:\n${lines}\n` +
      `Tests/builds run now may pick up incomplete changes and produce flaky results.\n`,
  );
  return { allow: true };
}

async function warnIfWorkspaceHasOtherSession(_cmd, cwd) {
  // Lightweight: just check if any other agent is registered for this workspace.
  const { listWorkspaceAgents } = await import('./_agent-comm-rest.mjs');
  const all = await listWorkspaceAgents(cwd);
  const others = all.filter((a) => a.agent !== AGENT_ID);
  if (others.length === 0) return { allow: true };
  process.stderr.write(
    `agent-comm: NOTE — ${others.length} other Claude session(s) active in this workspace.\n` +
      `If you're starting a dev server, check that they aren't already running one on the same port.\n`,
  );
  return { allow: true };
}

async function checkMigrationsOthers(cmd, cwd) {
  // Reuse the WIP check but BLOCK rather than warn — migrations are destructive.
  const all = await listFilesEdited();
  const ws = filterEditsToWorkspace(all, cwd);
  const other = filterEditsByOthers(ws, AGENT_ID);
  const recent = other.filter((e) => ageMs(e.when) <= RECENT_MS);
  // Migrations specifically: also check for any migration-file edits
  const migrationEdits = recent.filter((e) =>
    /migrations?[\\/]|prisma[\\/]migrations|alembic|schema\.(prisma|sql|rb)/i.test(e.file),
  );
  if (migrationEdits.length === 0 && recent.length === 0) return { allow: true };
  const lines = (migrationEdits.length ? migrationEdits : recent.slice(0, 5))
    .map((e) => `  - ${e.file} (${e.editor}, ${ageString(e.when)})`)
    .join('\n');
  return {
    allow: false,
    reason:
      `BLOCKED: another Claude session has recent edits in this workspace:\n${lines}\n\n` +
      `Running schema migrations while another session is editing migration files or schema ` +
      `is destructive — both sessions may apply conflicting changes to the same DB. ` +
      `Coordinate via mcp__agent-comm__comm_send first, or set AGENT_COMM_GUARD_BYPASS=1 if you've manually verified safety.`,
  };
}

// ---------------------------------------------------------------------------
// Main dispatch
// ---------------------------------------------------------------------------

async function main() {
  if (process.env.AGENT_COMM_GUARD_BYPASS === '1') {
    process.exit(0);
  }
  const payload = await readStdinJson();
  const tool = payload.tool_name ?? payload.name ?? '';
  if (tool !== 'Bash') process.exit(0);
  const command = payload.tool_input?.command ?? payload.input?.command ?? '';
  if (!command || typeof command !== 'string') process.exit(0);
  const cwd = payload.cwd || payload.tool_input?.cwd || process.cwd();

  const matched = RULES.filter((r) => r.match(command));
  if (matched.length === 0) process.exit(0);

  // A matched rule with REST down means we'd run the check on empty data
  // and silently fall open. Surface that explicitly.
  const restAlive = await probeRest();
  if (!restAlive) {
    await signalFailOpen('bash-guard', 'dashboard-unreachable', {
      rules: matched.map((r) => r.name),
      command: command.slice(0, 200),
    });
    // Intentional: continue to exit 0 — we never block real work because the
    // bus is down.
    process.exit(0);
  }

  for (const rule of matched) {
    let result;
    let threw = false;
    try {
      result = await rule.check(command, cwd);
    } catch (err) {
      threw = true;
      await signalFailOpen('bash-guard', 'rule-check-threw', {
        rule: rule.name,
        error: err && err.message ? String(err.message).slice(0, 200) : 'unknown',
      });
      result = { allow: true };
    }
    void threw;
    if (result && result.allow === false) {
      // Surface the block as a first-class dashboard event. "target" is the
      // bash command (clamped) — the diagnostic reason lives in the preview.
      // reason "would-clobber-wip" covers the shape of every BLOCK outcome in
      // the RULES table today (commit/push include other-agent WIP, install
      // racing package.json edits, migrations racing schema). Future rules
      // can override by returning result.reason_code.
      await signalBlock('bash-guard', {
        tool: 'Bash',
        target: command.slice(0, 240),
        rule: rule.name,
        reason: result.reason_code ?? 'would-clobber-wip',
      });
      process.stderr.write(`[bash-guard:${rule.name}] ${result.reason}\n`);
      process.exit(2);
    }
  }
  process.exit(0);
}

main().catch(() => process.exit(0));

// Keep call referenced even though some checks use it transitively.
void call;
