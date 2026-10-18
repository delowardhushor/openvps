import type { Db } from './db/index.ts';
import type { SiteSpec } from './agent/sites-spec.ts';

export interface SiteRecord {
  name: string;
  spec: SiteSpec;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
}

interface Row {
  name: string;
  spec: string;
  created_at: number;
  updated_at: number;
  last_error: string | null;
}

export class SitesStore {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  private rec(r: Row): SiteRecord {
    return { name: r.name, spec: JSON.parse(r.spec) as SiteSpec, createdAt: r.created_at, updatedAt: r.updated_at, lastError: r.last_error };
  }

  list(): SiteRecord[] {
    return (this.db.prepare('SELECT * FROM sites ORDER BY name').all() as unknown as Row[]).map((r) => this.rec(r));
  }

  get(name: string): SiteRecord | null {
    const r = this.db.prepare('SELECT * FROM sites WHERE name = ?').get(name) as Row | undefined;
    return r ? this.rec(r) : null;
  }

  upsert(spec: SiteSpec): SiteRecord {
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO sites (name, spec, created_at, updated_at, last_error) VALUES (?, ?, ?, ?, NULL)
         ON CONFLICT(name) DO UPDATE SET spec = excluded.spec, updated_at = excluded.updated_at, last_error = NULL`,
      )
      .run(spec.name, JSON.stringify(spec), now, now);
    return this.get(spec.name)!;
  }

  setError(name: string, error: string | null): void {
    this.db.prepare('UPDATE sites SET last_error = ? WHERE name = ?').run(error ? error.slice(0, 2000) : null, name);
  }

  delete(name: string): boolean {
    return Number(this.db.prepare('DELETE FROM sites WHERE name = ?').run(name).changes) > 0;
  }
}
