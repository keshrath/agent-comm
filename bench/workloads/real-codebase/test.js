// DO NOT EDIT — verifier for the real-codebase workload. `node test.js`.
// Tests the THREE distinct things the three agents are supposed to add:
//   1. is_active field on User type, defaulting to true, filtered in findUser
//   2. input validation in createUser (name + email)
//   3. error logging in db.js (console.error wrapper)
//
// Each check is independent. The bench reports PASSED_FNS=task1,task2,task3.

/* eslint-disable */
const { createUser, getUser } = require('./src/user.js');
const db = require('./src/db.js');
const types = require('./src/types.js');

const passed = [];
const errors = [];

// ---- Task 1: is_active field on User ----
try {
  db._reset();
  const u = types.makeUser('u1', 'Alice', 'alice@example.com');
  if (typeof u.is_active === 'boolean') {
    // Field exists. Now check createUser defaults it to true and findUser filters.
    db._reset();
    const created = createUser('u1', 'Alice', 'alice@example.com');
    if (created.is_active === true) {
      // Mark a user inactive directly and verify findUser hides it.
      db._reset();
      const active = createUser('u_active', 'A', 'a@x.io');
      const inactive = createUser('u_inactive', 'B', 'b@x.io');
      // Mark inactive directly via the underlying store.
      const stored = db.findUser('u_inactive');
      if (stored) stored.is_active = false;
      const stillActive = db.findUser('u_active');
      const shouldBeNull = db.findUser('u_inactive');
      if (stillActive && stillActive.id === 'u_active' && shouldBeNull === null) {
        passed.push('task1_is_active');
      } else {
        errors.push(
          `task1: findUser did not filter is_active=false (got ${shouldBeNull && shouldBeNull.id})`,
        );
      }
    } else {
      errors.push('task1: createUser did not default is_active=true');
    }
  } else {
    errors.push('task1: User type missing is_active field');
  }
} catch (e) {
  errors.push(`task1 THROW: ${e.message}`);
}

// ---- Task 2: validation in createUser ----
try {
  db._reset();
  let threwOnEmptyName = false;
  let threwOnBadEmail = false;
  try {
    createUser('u2', '', 'a@b.co');
  } catch (e) {
    threwOnEmptyName = true;
  }
  try {
    createUser('u3', 'Bob', 'not-an-email');
  } catch (e) {
    threwOnBadEmail = true;
  }
  if (threwOnEmptyName && threwOnBadEmail) {
    passed.push('task2_validation');
  } else {
    errors.push(
      `task2: missing validation (emptyName threw: ${threwOnEmptyName}, badEmail threw: ${threwOnBadEmail})`,
    );
  }
} catch (e) {
  errors.push(`task2 THROW: ${e.message}`);
}

// ---- Task 3: error logging in db.js ----
try {
  // Patch console.error to capture calls.
  const originalError = console.error;
  let errorLogCalls = 0;
  console.error = function (...args) {
    if (args[0] === '[db]' || (typeof args[0] === 'string' && args[0].includes('[db]'))) {
      errorLogCalls++;
    }
  };
  try {
    db.saveUser({}); // Should throw and log
  } catch {
    /* expected */
  }
  console.error = originalError;
  if (errorLogCalls > 0) {
    passed.push('task3_error_logging');
  } else {
    errors.push('task3: db.saveUser did not call console.error("[db]", ...) on failure');
  }
} catch (e) {
  errors.push(`task3 THROW: ${e.message}`);
}

for (const err of errors) console.error(err);
console.log(`PASSED_FNS=${passed.join(',')}`);
console.log(`PASSED=${passed.length}/3`);
if (passed.length < 3) process.exit(1);
