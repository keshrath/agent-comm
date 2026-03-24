// =============================================================================
// Test helpers — shared fixtures for all test suites
// =============================================================================

import { createContext, type AppContext } from '../src/context.js';

export function createTestContext(): AppContext {
  return createContext({ path: ':memory:' });
}
