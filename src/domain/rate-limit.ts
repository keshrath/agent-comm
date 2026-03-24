// =============================================================================
// agent-comm — Token-bucket rate limiter
//
// In-memory per-agent rate limiting using the token bucket algorithm.
// Each agent gets a bucket of 10 tokens (burst size) that refills at
// 1 token per second (60/min). Calls that exceed the limit are rejected
// with a 429 RATE_LIMITED error.
// =============================================================================

import { CommError } from '../types.js';

const BUCKET_CAPACITY = 10;
const REFILL_RATE = 1; // tokens per second

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class RateLimiter {
  private buckets = new Map<string, Bucket>();

  /** Consume one token. Throws CommError if the bucket is empty. */
  check(agentId: string): void {
    const now = Date.now();
    let bucket = this.buckets.get(agentId);

    if (!bucket) {
      bucket = { tokens: BUCKET_CAPACITY, lastRefill: now };
      this.buckets.set(agentId, bucket);
    }

    // Refill tokens based on elapsed time
    const elapsed = (now - bucket.lastRefill) / 1000;
    bucket.tokens = Math.min(BUCKET_CAPACITY, bucket.tokens + elapsed * REFILL_RATE);
    bucket.lastRefill = now;

    if (bucket.tokens < 1) {
      throw new CommError(`Rate limit exceeded for agent ${agentId}`, 'RATE_LIMITED', 429);
    }

    bucket.tokens -= 1;
  }

  /** Clear bucket state. If agentId is given, clear only that agent. */
  reset(agentId?: string): void {
    if (agentId) {
      this.buckets.delete(agentId);
    } else {
      this.buckets.clear();
    }
  }
}
