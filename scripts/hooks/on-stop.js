#!/usr/bin/env node

// =============================================================================
// agent-comm Stop hook
//
// Reminds the agent to say goodbye and clean up shared state before stopping.
// =============================================================================

const msg = {
  reason: `Before stopping:
1. Post a brief summary of what you accomplished to "general" via comm_send({ channel: "general" })
2. Clean up any shared state you own — especially locks via comm_state({ action: "delete" })
3. Call comm_agents({ action: "unregister" }) to go offline cleanly`,
};

console.log(JSON.stringify(msg));
