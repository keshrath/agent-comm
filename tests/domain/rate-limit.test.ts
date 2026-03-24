import { CommError } from '../../src/types.js';
import { RateLimiter } from '../../src/domain/rate-limit.js';

describe('RateLimiter', () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('allows first 10 calls (burst capacity)', () => {
    for (let i = 0; i < 10; i++) {
      expect(() => limiter.check('agent-a')).not.toThrow();
    }
  });

  it('rejects the 11th call with RATE_LIMITED / 429', () => {
    for (let i = 0; i < 10; i++) {
      limiter.check('agent-a');
    }
    try {
      limiter.check('agent-a');
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(CommError);
      const ce = err as CommError;
      expect(ce.code).toBe('RATE_LIMITED');
      expect(ce.statusCode).toBe(429);
    }
  });

  it('works again after reset()', () => {
    for (let i = 0; i < 10; i++) {
      limiter.check('agent-a');
    }
    expect(() => limiter.check('agent-a')).toThrow();
    limiter.reset();
    expect(() => limiter.check('agent-a')).not.toThrow();
  });

  it('different agents have independent buckets', () => {
    for (let i = 0; i < 10; i++) {
      limiter.check('agent-a');
    }
    expect(() => limiter.check('agent-a')).toThrow();
    expect(() => limiter.check('agent-b')).not.toThrow();
  });

  it('reset(agentId) clears only that agent', () => {
    for (let i = 0; i < 10; i++) {
      limiter.check('agent-a');
    }
    for (let i = 0; i < 10; i++) {
      limiter.check('agent-b');
    }
    expect(() => limiter.check('agent-a')).toThrow();
    expect(() => limiter.check('agent-b')).toThrow();

    limiter.reset('agent-a');

    expect(() => limiter.check('agent-a')).not.toThrow();
    expect(() => limiter.check('agent-b')).toThrow();
  });

  it('reset() with no args clears all agents', () => {
    for (let i = 0; i < 10; i++) {
      limiter.check('agent-a');
    }
    for (let i = 0; i < 10; i++) {
      limiter.check('agent-b');
    }
    limiter.reset();
    expect(() => limiter.check('agent-a')).not.toThrow();
    expect(() => limiter.check('agent-b')).not.toThrow();
  });
});
