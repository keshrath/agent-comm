// =============================================================================
// Hook script unit tests
//
// Spawns each script in scripts/hooks/ as a child process with crafted stdin
// and asserts the script fails open and emits shape-correct JSON for the
// Claude Code hook schema. Regression coverage for the v1.3.7 schema fix
// (missing hookEventName in check-registration.js and check-inbox.js).
// =============================================================================

import { describe, it, expect } from 'vitest';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const HOOKS_DIR = join(__dirname, '..', '..', 'scripts', 'hooks');

interface HookResult {
  code: number | null;
  stdout: string;
  stderr: string;
  json: unknown;
}

function runHook(
  script: string,
  stdinInput: unknown,
  { timeoutMs = 5000 }: { timeoutMs?: number } = {},
): Promise<HookResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(HOOKS_DIR, script)], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      reject(new Error(`hook ${script} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));

    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = stdout.trim();
      let json: unknown = null;
      if (trimmed) {
        try {
          json = JSON.parse(trimmed);
        } catch (err) {
          reject(new Error(`${script}: non-JSON stdout: ${trimmed}\n${(err as Error).message}`));
          return;
        }
      }
      resolve({ code, stdout: trimmed, stderr, json });
    });

    if (stdinInput !== null && stdinInput !== undefined) {
      child.stdin.write(typeof stdinInput === 'string' ? stdinInput : JSON.stringify(stdinInput));
    }
    child.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// check-registration.js (UserPromptSubmit)
// ---------------------------------------------------------------------------

describe('check-registration.js', () => {
  it('exits 0 on empty stdin', async () => {
    const { code, json } = await runHook('check-registration.js', '');
    expect(code).toBe(0);
    expect(json === null || (typeof json === 'object' && json !== null)).toBe(true);
  });

  it('exits 0 on non-JSON stdin', async () => {
    const { code, json } = await runHook('check-registration.js', 'garbage');
    expect(code).toBe(0);
    expect(json === null || (typeof json === 'object' && json !== null)).toBe(true);
  });

  it('never emits hookSpecificOutput without hookEventName', async () => {
    // Even if the hook has something to report, any hookSpecificOutput it
    // emits MUST carry hookEventName: 'UserPromptSubmit' — otherwise Claude
    // Code's schema validator rejects it.
    const { json } = await runHook('check-registration.js', {
      prompt: 'hi',
    });
    if (json && typeof json === 'object' && 'hookSpecificOutput' in json) {
      const hso = (json as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
      expect(hso.hookEventName).toBe('UserPromptSubmit');
      expect(typeof hso.additionalContext).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// check-inbox.js (PostToolUse)
// ---------------------------------------------------------------------------

describe('check-inbox.js', () => {
  it('exits 0 on empty stdin', async () => {
    const { code, json } = await runHook('check-inbox.js', '');
    expect(code).toBe(0);
    expect(json === null || (typeof json === 'object' && json !== null)).toBe(true);
  });

  it('exits 0 on non-JSON stdin', async () => {
    const { code, json } = await runHook('check-inbox.js', 'junk');
    expect(code).toBe(0);
    expect(json === null || (typeof json === 'object' && json !== null)).toBe(true);
  });

  it('skips nudge for agent-comm tool calls', async () => {
    const { json } = await runHook('check-inbox.js', {
      tool_name: 'mcp__agent-comm__comm_inbox',
      tool_input: {},
    });
    expect(json === null || (typeof json === 'object' && json !== null)).toBe(true);
  });

  it('never emits hookSpecificOutput without hookEventName', async () => {
    const { json } = await runHook('check-inbox.js', {
      tool_name: 'Read',
      tool_input: { file_path: '/tmp/x' },
    });
    if (json && typeof json === 'object' && 'hookSpecificOutput' in json) {
      const hso = (json as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
      expect(hso.hookEventName).toBe('PostToolUse');
      expect(typeof hso.additionalContext).toBe('string');
    }
  });
});

// ---------------------------------------------------------------------------
// session-start.js (SessionStart)
// ---------------------------------------------------------------------------

describe('session-start.js', () => {
  it('emits a SessionStart hookSpecificOutput', async () => {
    const { code, json } = await runHook('session-start.js', {});
    expect(code).toBe(0);
    const obj = json as { hookSpecificOutput?: { hookEventName?: string } };
    expect(obj.hookSpecificOutput?.hookEventName).toBe('SessionStart');
  });
});

// ---------------------------------------------------------------------------
// on-stop.js (Stop / SubagentStop)
// ---------------------------------------------------------------------------

describe('on-stop.js', () => {
  it('exits 0 on empty stdin', async () => {
    const { code } = await runHook('on-stop.js', '');
    expect(code).toBe(0);
  });

  it('exits 0 on non-JSON stdin', async () => {
    const { code } = await runHook('on-stop.js', 'not json');
    expect(code).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// bash-guard.mjs (PreToolUse:Bash)
// ---------------------------------------------------------------------------

describe('bash-guard.mjs', () => {
  it('exits 0 on empty stdin', async () => {
    const { code, json } = await runHook('bash-guard.mjs', '');
    expect(code).toBe(0);
    expect(json === null || (typeof json === 'object' && json !== null)).toBe(true);
  });

  it('exits 0 on non-JSON stdin', async () => {
    const { code, json } = await runHook('bash-guard.mjs', 'junk');
    expect(code).toBe(0);
    expect(json === null || (typeof json === 'object' && json !== null)).toBe(true);
  });

  it('passes through a harmless Bash command', async () => {
    const { code, json } = await runHook('bash-guard.mjs', {
      tool_name: 'Bash',
      tool_input: { command: 'ls -la' },
    });
    expect(code).toBe(0);
    // Either {} or a structured allow — just not a crash
    expect(json).toBeDefined();
  });

  it('never emits a malformed hookSpecificOutput', async () => {
    const { json } = await runHook('bash-guard.mjs', {
      tool_name: 'Bash',
      tool_input: { command: 'git commit' },
    });
    if (json && typeof json === 'object' && 'hookSpecificOutput' in json) {
      const hso = (json as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
      expect(hso.hookEventName).toBe('PreToolUse');
    }
  });
});

// ---------------------------------------------------------------------------
// file-coord.mjs (PreToolUse/PostToolUse on Edit|Write|MultiEdit)
// ---------------------------------------------------------------------------

describe('file-coord.mjs', () => {
  it('exits 0 on empty stdin (PreToolUse)', async () => {
    const { code } = await runHook('file-coord.mjs', '');
    expect(code).toBe(0);
  });

  it('exits 0 on non-JSON stdin', async () => {
    const { code, json } = await runHook('file-coord.mjs', 'junk');
    expect(code).toBe(0);
    expect(json === null || (typeof json === 'object' && json !== null)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Block-event emission (T3.A — _fail-open.mjs signalBlock helper)
//
// The signal helper MUST emit an AGENT_COMM_HOOK_BLOCK: stderr line every
// time a hook enforces a block, even when the dashboard is unreachable.
// Verifying the stderr surface here is enough — REST emission to /api/feed
// is exercised by the integration tests when the dashboard is alive.
// ---------------------------------------------------------------------------

describe('_fail-open.mjs signalBlock (T3.A)', () => {
  it('writes AGENT_COMM_HOOK_BLOCK stderr line with hook name and payload', async () => {
    const prevPort = process.env.AGENT_COMM_PORT;
    const prevId = process.env.AGENT_COMM_ID;
    process.env.AGENT_COMM_PORT = '1';
    process.env.AGENT_COMM_ID = 't3a-unit-test';

    const modUrl =
      'file:///' + join(HOOKS_DIR, '_fail-open.mjs').replace(/\\/g, '/') + '?t=' + Date.now();
    const mod = (await import(modUrl)) as {
      signalBlock: (h: string, p: Record<string, unknown>) => Promise<void>;
    };

    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = '';
    // @ts-expect-error patching for test capture
    process.stderr.write = (chunk: string | Buffer) => {
      captured += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    };
    try {
      await mod.signalBlock('test-hook', {
        tool: 'Edit',
        target: '/tmp/x',
        holder_agent: 'other',
        reason: 'held-by-other',
      });
    } finally {
      process.stderr.write = origWrite;
      if (prevPort === undefined) delete process.env.AGENT_COMM_PORT;
      else process.env.AGENT_COMM_PORT = prevPort;
      if (prevId === undefined) delete process.env.AGENT_COMM_ID;
      else process.env.AGENT_COMM_ID = prevId;
    }
    const match = captured.match(/^AGENT_COMM_HOOK_BLOCK: (\{.*\})$/m);
    expect(match).toBeTruthy();
    const payload = JSON.parse(match![1]);
    expect(payload.hook).toBe('test-hook');
    expect(payload.tool).toBe('Edit');
    expect(payload.target).toBe('/tmp/x');
    expect(payload.holder_agent).toBe('other');
    expect(payload.reason).toBe('held-by-other');
    expect(payload.blocked_agent).toBe('t3a-unit-test');
    expect(typeof payload.ts).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// workspace-awareness.mjs (SessionStart)
// ---------------------------------------------------------------------------

describe('workspace-awareness.mjs', () => {
  it('exits 0 on empty stdin', async () => {
    const { code } = await runHook('workspace-awareness.mjs', '');
    expect(code).toBe(0);
  });

  it('emits a SessionStart hookSpecificOutput when it has something to say', async () => {
    const { json } = await runHook('workspace-awareness.mjs', {
      workspace: { current_dir: process.cwd() },
    });
    if (json && typeof json === 'object' && 'hookSpecificOutput' in json) {
      const hso = (json as { hookSpecificOutput: Record<string, unknown> }).hookSpecificOutput;
      expect(hso.hookEventName).toBe('SessionStart');
    }
  });
});
