/**
 * Versioned, forward-only schema migrations (NFR 7.5).
 *
 * Rules for contributors:
 *  - Never edit a migration that has shipped in a release. Add a new one.
 *  - Versions must be strictly increasing integers.
 *  - Each migration runs inside a transaction together with its bookkeeping row.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial',
    sql: `
      CREATE TABLE users (
        id             INTEGER PRIMARY KEY,
        username       TEXT NOT NULL UNIQUE COLLATE NOCASE,
        password_hash  TEXT NOT NULL,
        role           TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('admin')),
        failed_logins  INTEGER NOT NULL DEFAULT 0,
        locked_until   INTEGER,
        last_login_at  INTEGER,
        created_at     INTEGER NOT NULL,
        updated_at     INTEGER NOT NULL
      );

      CREATE TABLE sessions (
        id            TEXT PRIMARY KEY,          -- sha256 of the cookie token, never the token itself
        user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        created_at    INTEGER NOT NULL,
        last_seen_at  INTEGER NOT NULL,
        expires_at    INTEGER NOT NULL,
        ip            TEXT,
        user_agent    TEXT
      );
      CREATE INDEX sessions_user ON sessions(user_id);

      CREATE TABLE settings (
        key    TEXT PRIMARY KEY,
        value  TEXT NOT NULL
      );

      CREATE TABLE audit_log (
        id       INTEGER PRIMARY KEY,
        ts       INTEGER NOT NULL,
        actor    TEXT,
        ip       TEXT,
        action   TEXT NOT NULL,
        target   TEXT,
        outcome  TEXT NOT NULL CHECK (outcome IN ('success', 'failure', 'info')),
        details  TEXT
      );
      CREATE INDEX audit_ts ON audit_log(ts);
      CREATE INDEX audit_action ON audit_log(action);
    `,
  },
  {
    version: 2,
    name: 'apps',
    sql: `
      CREATE TABLE apps (
        id               INTEGER PRIMARY KEY,
        name             TEXT NOT NULL UNIQUE,
        spec             TEXT NOT NULL,          -- JSON AppSpec (no secrets)
        env_sealed       TEXT,                   -- AES-256-GCM sealed JSON of env vars
        created_at       INTEGER NOT NULL,
        updated_at       INTEGER NOT NULL,
        last_applied_at  INTEGER,
        last_error       TEXT
      );
    `,
  },
];
