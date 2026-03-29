// =============================================================================
// agent-comm — MCP input validation helpers
//
// Extracted from mcp.ts for reuse by the dispatch table in mcp-handlers.ts.
// =============================================================================

import type { AgentStatus, MessageImportance } from '../types.js';
import { ValidationError } from '../types.js';

export function requireString(args: Record<string, unknown>, key: string): string {
  const val = args[key];
  if (typeof val !== 'string' || !val.trim()) {
    throw new ValidationError(`"${key}" must be a non-empty string.`);
  }
  return val;
}

export function optString(args: Record<string, unknown>, key: string): string | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') throw new ValidationError(`"${key}" must be a string.`);
  return val;
}

export function requireNumber(args: Record<string, unknown>, key: string): number {
  const val = args[key];
  if (typeof val !== 'number') {
    throw new ValidationError(`"${key}" is required and must be a number.`);
  }
  return val;
}

export function optNumber(args: Record<string, unknown>, key: string): number | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'number') throw new ValidationError(`"${key}" must be a number.`);
  return val;
}

const VALID_IMPORTANCE = new Set<string>(['low', 'normal', 'high', 'urgent']);

export function optImportance(
  args: Record<string, unknown>,
  key: string,
): MessageImportance | undefined {
  const val = optString(args, key);
  if (val === undefined) return undefined;
  if (!VALID_IMPORTANCE.has(val)) {
    throw new ValidationError(`"${key}" must be one of: low, normal, high, urgent.`);
  }
  return val as MessageImportance;
}

const VALID_STATUS = new Set<string>(['online', 'idle', 'offline']);

export function optStatus(args: Record<string, unknown>, key: string): AgentStatus | undefined {
  const val = optString(args, key);
  if (val === undefined) return undefined;
  if (!VALID_STATUS.has(val)) {
    throw new ValidationError(`"${key}" must be one of: online, idle, offline.`);
  }
  return val as AgentStatus;
}

export function optStringOrNull(args: Record<string, unknown>, key: string): string | null {
  const val = args[key];
  if (val === null || val === undefined) return null;
  if (typeof val !== 'string') throw new ValidationError(`"${key}" must be a string or null.`);
  return val;
}

export function optBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
  const val = args[key];
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'boolean') throw new ValidationError(`"${key}" must be a boolean.`);
  return val;
}
