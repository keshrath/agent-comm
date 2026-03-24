import { describe, it, expect, beforeEach } from 'vitest';
import { EventBus } from '../../src/domain/events.js';
import type { CommEvent } from '../../src/types.js';

describe('EventBus', () => {
  let bus: EventBus;

  beforeEach(() => {
    bus = new EventBus();
  });

  it('delivers events to specific listeners', () => {
    const received: CommEvent[] = [];
    bus.on('agent:registered', (e) => received.push(e));
    bus.emit('agent:registered', { name: 'test' });
    expect(received).toHaveLength(1);
    expect(received[0].data).toEqual({ name: 'test' });
  });

  it('delivers events to wildcard listeners', () => {
    const received: CommEvent[] = [];
    bus.on('*', (e) => received.push(e));
    bus.emit('agent:registered');
    bus.emit('message:sent');
    expect(received).toHaveLength(2);
  });

  it('does not deliver events to unrelated listeners', () => {
    const received: CommEvent[] = [];
    bus.on('agent:registered', (e) => received.push(e));
    bus.emit('message:sent');
    expect(received).toHaveLength(0);
  });

  it('returns unsubscribe function', () => {
    const received: CommEvent[] = [];
    const unsub = bus.on('agent:registered', (e) => received.push(e));
    bus.emit('agent:registered');
    unsub();
    bus.emit('agent:registered');
    expect(received).toHaveLength(1);
  });

  it('does not crash when listener throws', () => {
    bus.on('agent:registered', () => {
      throw new Error('boom');
    });
    expect(() => bus.emit('agent:registered')).not.toThrow();
  });

  it('includes timestamp in events', () => {
    let event: CommEvent | null = null;
    bus.on('agent:registered', (e) => {
      event = e;
    });
    bus.emit('agent:registered');
    expect(event).not.toBeNull();
    expect(event!.timestamp).toBeDefined();
    expect(new Date(event!.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('removeAll clears all listeners', () => {
    const received: CommEvent[] = [];
    bus.on('agent:registered', (e) => received.push(e));
    bus.on('*', (e) => received.push(e));
    bus.removeAll();
    bus.emit('agent:registered');
    expect(received).toHaveLength(0);
  });
});
