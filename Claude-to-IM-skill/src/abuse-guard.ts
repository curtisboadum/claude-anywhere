/**
 * @file abuse-guard.ts
 * @description Lightweight in-process abuse controls for the LLM providers:
 *   a global concurrency cap, a per-session token-bucket rate limit, and a helper
 *   to enforce a wall-clock session timeout via an AbortController.
 * @status New (harden/worktree-isolation). Covered by __tests__/abuse-guard.test.ts.
 * @issues Per-process only (single daemon); not distributed.
 * @todo none.
 */

function envInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** Global cap on concurrently-running sessions. */
export class ConcurrencyGate {
  private active = 0;
  constructor(private readonly limit: () => number) {}
  tryAcquire(): boolean {
    if (this.active >= this.limit()) return false;
    this.active += 1;
    return true;
  }
  release(): void {
    if (this.active > 0) this.active -= 1;
  }
  get inUse(): number {
    return this.active;
  }
}

/** Per-key token bucket: `perMin` requests per rolling minute. */
export class RateLimiter {
  private buckets = new Map<string, { tokens: number; updatedAt: number }>();
  constructor(private readonly perMin: () => number, private readonly now: () => number = Date.now) {}

  allow(key: string): boolean {
    const cap = this.perMin();
    const t = this.now();
    const b = this.buckets.get(key) ?? { tokens: cap, updatedAt: t };
    // Refill proportionally to elapsed time.
    const refill = ((t - b.updatedAt) / 60_000) * cap;
    b.tokens = Math.min(cap, b.tokens + refill);
    b.updatedAt = t;
    if (b.tokens < 1) {
      this.buckets.set(key, b);
      return false;
    }
    b.tokens -= 1;
    this.buckets.set(key, b);
    return true;
  }
}

// ── Singletons wired to env tunables (read lazily so tests can vary them) ──

export const concurrencyGate = new ConcurrencyGate(() => envInt('CTI_MAX_CONCURRENT', 3));
export const rateLimiter = new RateLimiter(() => envInt('CTI_RATE_PER_MIN', 20));

/** Wall-clock timeout for a single session, in milliseconds. */
export function sessionTimeoutMs(): number {
  return envInt('CTI_SESSION_TIMEOUT_SEC', 600) * 1000;
}
