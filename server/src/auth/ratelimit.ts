/**
 * Fixed-window, in-memory rate limiter keyed by an arbitrary string (e.g. client IP).
 * Single-process by design; OpenVPS runs as one service per server.
 */
export class RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  private readonly limit: number;
  private readonly windowMs: number;
  constructor(limit: number, windowMs: number) {
    this.limit = limit;
    this.windowMs = windowMs;
  }

  /** Count a hit. Returns whether it is allowed and how long until the window resets. */
  hit(key: string, now = Date.now()): { allowed: boolean; retryAfterMs: number; remaining: number } {
    let e = this.hits.get(key);
    if (!e || e.resetAt <= now) {
      e = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, e);
    }
    e.count++;
    if (this.hits.size > 50_000) this.sweep(now);
    return {
      allowed: e.count <= this.limit,
      retryAfterMs: Math.max(0, e.resetAt - now),
      remaining: Math.max(0, this.limit - e.count),
    };
  }

  reset(key: string): void {
    this.hits.delete(key);
  }

  sweep(now = Date.now()): void {
    for (const [k, v] of this.hits) if (v.resetAt <= now) this.hits.delete(k);
  }
}
