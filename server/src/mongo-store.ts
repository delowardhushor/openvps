import type { Db } from './db/index.ts';
import type { SecretBox } from './secretbox.ts';
import { redactMongoUri } from './agent/backup-spec.ts';

export interface MongoConnectionRecord {
  id: number;
  name: string;
  /** The connection string with the password hidden. */
  uri: string;
  createdAt: number;
  updatedAt: number;
  lastOkAt: number | null;
  lastError: string | null;
}

interface Row {
  id: number;
  name: string;
  uri_sealed: string;
  created_at: number;
  updated_at: number;
  last_ok_at: number | null;
  last_error: string | null;
}

/** Saved MongoDB connections for the browser. Connection strings are sealed at rest. */
export class MongoStore {
  private readonly db: Db;
  private readonly box: SecretBox;
  constructor(db: Db, box: SecretBox) {
    this.db = db;
    this.box = box;
  }

  private record(r: Row): MongoConnectionRecord {
    return {
      id: r.id,
      name: r.name,
      uri: redactMongoUri(this.box.open(r.uri_sealed)),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastOkAt: r.last_ok_at,
      lastError: r.last_error,
    };
  }

  list(): MongoConnectionRecord[] {
    return (this.db.prepare('SELECT * FROM mongo_connections ORDER BY name').all() as unknown as Row[]).map((r) => this.record(r));
  }

  get(id: number): MongoConnectionRecord | null {
    const r = this.db.prepare('SELECT * FROM mongo_connections WHERE id = ?').get(id) as Row | undefined;
    return r ? this.record(r) : null;
  }

  byName(name: string): MongoConnectionRecord | null {
    const r = this.db.prepare('SELECT * FROM mongo_connections WHERE name = ?').get(name) as Row | undefined;
    return r ? this.record(r) : null;
  }

  /** The real connection string. Only for opening a connection, never for responses. */
  uri(id: number): string | null {
    const r = this.db.prepare('SELECT uri_sealed FROM mongo_connections WHERE id = ?').get(id) as { uri_sealed: string } | undefined;
    return r ? this.box.open(r.uri_sealed) : null;
  }

  create(name: string, uri: string): MongoConnectionRecord {
    const now = Date.now();
    const res = this.db
      .prepare('INSERT INTO mongo_connections (name, uri_sealed, created_at, updated_at) VALUES (?, ?, ?, ?)')
      .run(name, this.box.seal(uri), now, now);
    return this.get(Number(res.lastInsertRowid))!;
  }

  update(id: number, name: string, uri: string): MongoConnectionRecord {
    this.db
      .prepare('UPDATE mongo_connections SET name = ?, uri_sealed = ?, updated_at = ?, last_ok_at = NULL, last_error = NULL WHERE id = ?')
      .run(name, this.box.seal(uri), Date.now(), id);
    return this.get(id)!;
  }

  delete(id: number): boolean {
    return Number(this.db.prepare('DELETE FROM mongo_connections WHERE id = ?').run(id).changes) > 0;
  }

  markOk(id: number): void {
    this.db.prepare('UPDATE mongo_connections SET last_ok_at = ?, last_error = NULL WHERE id = ?').run(Date.now(), id);
  }

  markFailed(id: number, message: string): void {
    this.db.prepare('UPDATE mongo_connections SET last_error = ? WHERE id = ?').run(message.slice(0, 500), id);
  }
}
