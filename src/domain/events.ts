// =============================================================================
// agent-comm — Event bus
//
// Thin extension of agent-common's generic EventBus, parameterized to the
// agent-comm event vocabulary defined in ../types.ts.
// =============================================================================

import { EventBus as KitEventBus } from 'agent-common';
import type { EventType } from '../types.js';

export class EventBus extends KitEventBus<EventType> {}
