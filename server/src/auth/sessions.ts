import type { Db } from '../db/index.ts';
import { hashToken, newToken } from './tokens.ts';

export interface SessionRow {
  id: string;
  user_id: number;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
}

export interface SessionPolicy {
  idleMs: number;
  absoluteMs: number;
}

/**
 * Server-side sessions. The browser holds an opaque random token in an
 * HttpOnly cookie; the database stores only its SHA-256 hash.
 * A session ends at whichever comes first: idle timeout or absolute lifetime.
 */
export class Sessions {
  private readonly db: Db;
  private readonly policy: SessionPolicy;
  constructor(db: Db, policy: SessionPolicy) {
    this.db = db;
    this.policy = policy;
  }

  create(userId: number, ip: string | null, userAgent: string | null): { token: string; row: SessionRow } {
    const token = newToken();
    const now = Date.now();
    const row: SessionRow = {
      id: hashToken(token),
      user_id: userId,
      created_at: now,
      last_seen_at: now,
      expires_at: now + this.policy.absoluteMs,
      ip,
      user_agent: userAgent ? userAgent.slice(0, 300) : null,
    };
    this.db
      .prepare(
        'INSERT INTO sessions (id, user_id, created_at, last_seen_at, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.user_id, row.created_at, row.last_seen_at, row.expires_at, row.ip, row.user_agent);
    return { token, row };
  }

  /** Validate a cookie token, sliding the idle window. Returns null if invalid or expired. */
  validate(token: string | undefined, now = Date.now()): SessionRow | null {
    if (!token || token.length < 20 || token.length > 100) return null;
    const id = hashToken(token);
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id) as SessionRow | undefined;
    if (!row) return null;
    if (row.expires_at <= now || row.last_seen_at + this.policy.idleMs <= now) {
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(id);
      return null;
    }
    // Avoid a write on every request: only bump last_seen every 30s.
    if (now - row.last_seen_at > 30_000) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(now, id);
      row.last_seen_at = now;
    }
    return row;
  }

  revoke(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(hashToken(token));
  }

  revokeById(id: string, userId: number): boolean {
    return Number(this.db.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').run(id, userId).changes) > 0;
  }

  revokeAllForUser(userId: number, exceptId?: string): number {
    const res = exceptId
      ? this.db.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').run(userId, exceptId)
      : this.db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);
    return Number(res.changes);
  }

  revokeAll(): number {
    return Number(this.db.prepare('DELETE FROM sessions').run().changes);
  }

  listForUser(userId: number): SessionRow[] {
    return this.db
      .prepare('SELECT * FROM sessions WHERE user_id = ? ORDER BY last_seen_at DESC')
      .all(userId) as unknown as SessionRow[];
  }

  pruneExpired(now = Date.now()): number {
    return Number(
      this.db
        .prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?')
        .run(now, now - this.policy.idleMs).changes,
    );
  }
}
