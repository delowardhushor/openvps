import { mkdirSync, chmodSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrations as allMigrations, type Migration } from './migrations.ts';

export type Db = DatabaseSync;

export const DB_FILENAME = 'openvps.db';

export function dbPath(dataDir: string): string {
  return join(dataDir, DB_FILENAME);
}

export function openDb(dataDir: string): Db {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true, mode: 0o750 });
  const file = dbPath(dataDir);
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
  `);
  try {
    chmodSync(file, 0o600);
  } catch {
    /* best effort; the installer also enforces permissions */
  }
  return db;
}

export function openMemoryDb(): Db {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  return db;
}

export function currentSchemaVersion(db: Db): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at INTEGER NOT NULL)`);
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_migrations').get() as { v: number | null };
  return row.v ?? 0;
}

export function transaction<T>(db: Db, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/**
 * Apply pending migrations. Refuses to run when the database is newer than
 * this build (e.g. after a downgrade) instead of guessing.
 */
export function migrate(db: Db, list: Migration[] = allMigrations): { from: number; to: number; applied: number[] } {
  for (let i = 1; i < list.length; i++) {
    if (list[i]!.version <= list[i - 1]!.version) throw new Error('Migrations must have increasing versions');
  }
  const from = currentSchemaVersion(db);
  const latest = list.at(-1)?.version ?? 0;
  if (from > latest) {
    throw new Error(
      `Database schema version ${from} is newer than this OpenVPS build supports (${latest}). ` +
        'Restore the pre-upgrade database backup or install a newer release.',
    );
  }
  const applied: number[] = [];
  for (const m of list) {
    if (m.version <= from) continue;
    transaction(db, () => {
      db.exec(m.sql);
      db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        Date.now(),
      );
    });
    applied.push(m.version);
  }
  return { from, to: Math.max(from, latest), applied };
}

export function getSetting(db: Db, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(db: Db, key: string, value: string): void {
  db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    value,
  );
}

export function deleteSetting(db: Db, key: string): void {
  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
}
