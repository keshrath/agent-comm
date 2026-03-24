#!/usr/bin/env node

// =============================================================================
// agent-comm Stop hook
//
// Reminds the agent to say goodbye before stopping.
// =============================================================================

const msg = {
  reason: `Before stopping, send a brief summary of what you accomplished to the "general" channel:\nCall comm_channel_send with channel "general" and content summarizing your work.\nThen call comm_unregister to go offline cleanly.`,
};

console.log(JSON.stringify(msg));
