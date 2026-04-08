#!/usr/bin/env node

// =============================================================================
// agent-comm setup script
//
// Configures an MCP-compatible AI agent to use agent-comm.
// Currently supports: Claude Code (auto-detected via ~/.claude.json)
//
// What it does:
// - Builds the project if dist/ is missing
// - Registers the MCP server in the agent's config
// - Adds lifecycle hooks (start, prompt, stop) for Claude Code
// - Adds permission for mcp__agent-comm__* tools
//
// Usage: node scripts/setup.js [--agent claude|generic]
//   Default: auto-detects Claude Code, falls back to generic instructions
// =============================================================================

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_DIR = resolve(join(__dirname, '..'));
const HOME = homedir();
const CLAUDE_JSON = join(HOME, '.claude.json');
const SETTINGS_JSON = join(HOME, '.claude', 'settings.json');

const AGENT_FLAG = process.argv.find((_a, i, arr) => arr[i - 1] === '--agent') ?? 'auto';
const IS_CLAUDE = AGENT_FLAG === 'claude' || (AGENT_FLAG === 'auto' && existsSync(CLAUDE_JSON));

console.log('agent-comm setup\n');
console.log(`Agent type: ${IS_CLAUDE ? 'Claude Code' : 'Generic (manual MCP config)'}`);

// ---------------------------------------------------------------------------
// Build if needed
// ---------------------------------------------------------------------------

if (!existsSync(join(PROJECT_DIR, 'dist', 'index.js'))) {
  console.log('Building agent-comm...');
  execSync('npm run build', { cwd: PROJECT_DIR, stdio: 'inherit' });
  console.log('');
}

// ---------------------------------------------------------------------------
// Register MCP server
// ---------------------------------------------------------------------------

const distPath = join(PROJECT_DIR, 'dist', 'index.js');

console.log('Registering MCP server...');
if (IS_CLAUDE && existsSync(CLAUDE_JSON)) {
  const config = JSON.parse(readFileSync(CLAUDE_JSON, 'utf-8'));
  if (!config.mcpServers) config.mcpServers = {};

  config.mcpServers['agent-comm'] = {
    type: 'stdio',
    command: 'node',
    args: [distPath],
    env: {},
  };

  writeFileSync(CLAUDE_JSON, JSON.stringify(config, null, 2));
  console.log(`  Added agent-comm MCP server → ${distPath}`);
} else {
  console.log(`  Add this to your MCP client config:`);
  console.log(`  {`);
  console.log(`    "mcpServers": {`);
  console.log(`      "agent-comm": {`);
  console.log(`        "command": "node",`);
  console.log(`        "args": ["${distPath.replace(/\\/g, '/')}"]`);
  console.log(`      }`);
  console.log(`    }`);
  console.log(`  }`);
}

// ---------------------------------------------------------------------------

if (!IS_CLAUDE) {
  console.log(`
Setup complete!

Start the dashboard:  node dist/server.js
MCP server (stdio):   node dist/index.js
Dashboard URL:        http://localhost:3421
`);
  process.exit(0);
}

console.log('Configuring Claude Code hooks...');
if (existsSync(SETTINGS_JSON)) {
  const settings = JSON.parse(readFileSync(SETTINGS_JSON, 'utf-8'));

  if (!settings.permissions) settings.permissions = {};
  if (!settings.permissions.allow) settings.permissions.allow = [];
  if (!settings.permissions.allow.includes('mcp__agent-comm__*')) {
    settings.permissions.allow.push('mcp__agent-comm__*');
    console.log('  Added mcp__agent-comm__* permission');
  }

  if (!settings.hooks) settings.hooks = {};

  const hookDir = join(PROJECT_DIR, 'scripts', 'hooks');

  const sessionStartHook = {
    type: 'command',
    command: `node "${join(hookDir, 'session-start.js')}"`,
    timeout: 5,
  };

  const checkRegHook = {
    type: 'command',
    command: `node "${join(hookDir, 'check-registration.js')}"`,
    timeout: 10,
    once: true,
  };

  const stopHook = {
    type: 'command',
    command: `node "${join(hookDir, 'on-stop.js')}"`,
    timeout: 5,
  };

  function addHook(eventName, hook) {
    if (!settings.hooks[eventName]) settings.hooks[eventName] = [];
    const hookGroup = settings.hooks[eventName];

    const existing = hookGroup.find(
      (g) => g.hooks && g.hooks.some((h) => h.command && h.command.includes('agent-comm')),
    );
    if (existing) {
      console.log(`  ${eventName}: already configured`);
      return;
    }

    if (hookGroup.length > 0 && hookGroup[0].hooks) {
      hookGroup[0].hooks.push(hook);
    } else {
      hookGroup.push({ hooks: [hook] });
    }
    console.log(`  ${eventName}: added hook`);
  }

  addHook('SessionStart', sessionStartHook);
  addHook('UserPromptSubmit', checkRegHook);
  addHook('Stop', stopHook);

  // workspace-awareness hook — registers this session in the workspace and
  // injects context about other active sessions on session start. Solves the
  // "two terminals, same project, no idea about each other" pain.
  const workspaceAwarenessHook = {
    type: 'command',
    command: `node "${join(hookDir, 'workspace-awareness.mjs')}"`,
    timeout: 5,
  };
  function addNamedHook(eventName, hook, marker) {
    if (!settings.hooks[eventName]) settings.hooks[eventName] = [];
    const hookGroup = settings.hooks[eventName];
    const existing = hookGroup.find(
      (g) => g.hooks && g.hooks.some((h) => h.command && h.command.includes(marker)),
    );
    if (existing) {
      console.log(`  ${eventName} (${marker}): already configured`);
      return;
    }
    if (hookGroup.length > 0 && hookGroup[0].hooks) {
      hookGroup[0].hooks.push(hook);
    } else {
      hookGroup.push({ hooks: [hook] });
    }
    console.log(`  ${eventName}: added ${marker} hook`);
  }
  addNamedHook('SessionStart', workspaceAwarenessHook, 'workspace-awareness');

  // ----- file-coord hook (system-layer file lock enforcement) -----
  // Adds PreToolUse + PostToolUse hooks matched on Edit|Write|MultiEdit so
  // that parallel agents on the same shared file serialize via comm_state
  // CAS instead of clobbering each other. See bench/README.md (v7) for the
  // measurement showing this is 56% cheaper, 37% faster, and deterministic
  // compared to naive parallel multi-agent on shared files.
  const fileCoordPath = join(hookDir, 'file-coord.mjs');
  function addMatchedHook(eventName, matcher, command) {
    if (!settings.hooks[eventName]) settings.hooks[eventName] = [];
    const hookGroups = settings.hooks[eventName];
    const existing = hookGroups.find(
      (g) =>
        g.matcher === matcher &&
        g.hooks &&
        g.hooks.some((h) => h.command && h.command.includes('file-coord')),
    );
    if (existing) {
      console.log(`  ${eventName} (${matcher}): file-coord already configured`);
      return;
    }
    // 15s timeout — hook polls up to 10s for the lock, plus headroom for the
    // REST round trips on either side. MUST stay larger than the hook's
    // POLL_TIMEOUT_MS or Claude Code kills the hook mid-poll and the model
    // sees the kill as a tool-call failure (then retries, burning budget).
    hookGroups.push({
      matcher,
      hooks: [{ type: 'command', command, timeout: 15 }],
    });
    console.log(`  ${eventName} (${matcher}): added file-coord hook`);
  }

  // bash-guard hook — single PreToolUse on Bash that intercepts commit/
  // push/install/test/build/migrate/dev-server commands and blocks or warns
  // when they would conflict with another session's WIP. The rules table
  // inside scripts/hooks/bash-guard.mjs is easy to extend.
  const bashGuardPath = join(hookDir, 'bash-guard.mjs');
  function addBashGuardHook() {
    if (!settings.hooks.PreToolUse) settings.hooks.PreToolUse = [];
    const groups = settings.hooks.PreToolUse;
    const existing = groups.find(
      (g) =>
        g.matcher === 'Bash' &&
        g.hooks &&
        g.hooks.some((h) => h.command && h.command.includes('bash-guard')),
    );
    if (existing) {
      console.log('  PreToolUse (Bash): bash-guard already configured');
      return;
    }
    groups.push({
      matcher: 'Bash',
      hooks: [{ type: 'command', command: `node "${bashGuardPath}"`, timeout: 10 }],
    });
    console.log('  PreToolUse (Bash): added bash-guard hook');
  }
  addBashGuardHook();

  addMatchedHook('PreToolUse', 'Edit|Write|MultiEdit', `node "${fileCoordPath}" PreToolUse`);
  addMatchedHook('PostToolUse', 'Edit|Write|MultiEdit', `node "${fileCoordPath}" PostToolUse`);

  writeFileSync(SETTINGS_JSON, JSON.stringify(settings, null, 2));
  console.log('  Saved settings.json');
} else {
  console.log('  Warning: settings.json not found. Configure hooks manually.');
}

console.log(`
Setup complete!

Restart Claude Code to load the new MCP server. The agent will automatically:
  - Register on startup (SessionStart hook)
  - Join the "general" channel and announce its work
  - Check inbox for messages from other agents
  - Coordinate file edits via the file-coord PreToolUse/PostToolUse hook
    (parallel agents claim files via comm_state CAS before editing — see
    bench/README.md v7 for the measurement: 56% cheaper, 37% faster than
    naive parallel multi-agent on shared files)
  - Post a summary and unregister on stop

Dashboard: http://localhost:3421 (auto-starts on first MCP connection)

For other agents, see: https://github.com/keshrath/agent-comm#using-with-different-agents
`);
