import type { Db } from '../db/index.ts';

export interface User {
  id: number;
  username: string;
  role: 'admin';
  password_hash: string;
  failed_logins: number;
  locked_until: number | null;
  last_login_at: number | null;
  created_at: number;
  updated_at: number;
}

export type PublicUser = Pick<User, 'id' | 'username' | 'role' | 'last_login_at' | 'created_at'>;

export const USERNAME = /^[a-zA-Z][a-zA-Z0-9_.-]{2,31}$/;

export function toPublic(u: User): PublicUser {
  return { id: u.id, username: u.username, role: u.role, last_login_at: u.last_login_at, created_at: u.created_at };
}

export class Users {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  count(): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  }

  byUsername(username: string): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE username = ?').get(username) as User | undefined;
  }

  byId(id: number): User | undefined {
    return this.db.prepare('SELECT * FROM users WHERE id = ?').get(id) as User | undefined;
  }

  all(): User[] {
    return this.db.prepare('SELECT * FROM users ORDER BY id').all() as unknown as User[];
  }

  create(username: string, passwordHash: string): User {
    const now = Date.now();
    const res = this.db
      .prepare('INSERT INTO users (username, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(username, passwordHash, 'admin', now, now);
    return this.byId(Number(res.lastInsertRowid))!;
  }

  setPassword(id: number, passwordHash: string): void {
    this.db
      .prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = NULL, updated_at = ? WHERE id = ?')
      .run(passwordHash, Date.now(), id);
  }

  recordFailure(id: number, maxAttempts: number, lockoutMs: number): { locked: boolean } {
    const u = this.byId(id);
    if (!u) return { locked: false };
    const failed = u.failed_logins + 1;
    const lockedUntil = failed >= maxAttempts ? Date.now() + lockoutMs : null;
    this.db
      .prepare('UPDATE users SET failed_logins = ?, locked_until = COALESCE(?, locked_until) WHERE id = ?')
      .run(lockedUntil ? 0 : failed, lockedUntil, id);
    return { locked: lockedUntil !== null };
  }

  recordSuccess(id: number): void {
    this.db
      .prepare('UPDATE users SET failed_logins = 0, locked_until = NULL, last_login_at = ? WHERE id = ?')
      .run(Date.now(), id);
  }

  unlock(id: number): void {
    this.db.prepare('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = ?').run(id);
  }

  isLocked(u: User, now = Date.now()): boolean {
    return u.locked_until !== null && u.locked_until > now;
  }
}
