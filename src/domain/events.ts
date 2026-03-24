// =============================================================================
// agent-comm — Event bus
//
// In-process pub/sub for real-time notifications. The transport layer
// (WebSocket, SSE) subscribes to events and pushes them to connected clients.
// =============================================================================

import type { EventType, CommEvent } from '../types.js';

type EventHandler = (event: CommEvent) => void;

export class EventBus {
  private readonly listeners = new Map<EventType | '*', Set<EventHandler>>();

  emit(type: EventType, data: Record<string, unknown> = {}): void {
    const event: CommEvent = {
      type,
      timestamp: new Date().toISOString(),
      data,
    };

    const specific = this.listeners.get(type);
    if (specific) {
      for (const handler of specific) {
        try {
          handler(event);
        } catch {
          /* listeners must not crash the bus */
        }
      }
    }

    const wildcards = this.listeners.get('*');
    if (wildcards) {
      for (const handler of wildcards) {
        try {
          handler(event);
        } catch {
          /* ignore */
        }
      }
    }
  }

  on(type: EventType | '*', handler: EventHandler): () => void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  removeAll(): void {
    this.listeners.clear();
  }
}
