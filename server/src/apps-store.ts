import type { Db } from './db/index.ts';
import type { SecretBox } from './secretbox.ts';
import type { AppSpec } from './agent/spec.ts';

export interface AppRecord {
  id: number;
  name: string;
  spec: AppSpec;
  envKeys: string[];
  createdAt: number;
  updatedAt: number;
  lastAppliedAt: number | null;
  lastError: string | null;
}

interface Row {
  id: number;
  name: string;
  spec: string;
  env_sealed: string | null;
  created_at: number;
  updated_at: number;
  last_applied_at: number | null;
  last_error: string | null;
}

/** Registered applications. Env values are sealed and only decrypted to hand to the agent. */
export class AppsStore {
  private readonly db: Db;
  private readonly box: SecretBox;
  constructor(db: Db, box: SecretBox) {
    this.db = db;
    this.box = box;
  }

  private toRecord(r: Row): AppRecord {
    return {
      id: r.id,
      name: r.name,
      spec: JSON.parse(r.spec) as AppSpec,
      envKeys: Object.keys(this.envOf(r)).sort(),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastAppliedAt: r.last_applied_at,
      lastError: r.last_error,
    };
  }

  private envOf(r: Row): Record<string, string> {
    return r.env_sealed ? this.box.openJson<Record<string, string>>(r.env_sealed) : {};
  }

  private row(name: string): Row | undefined {
    return this.db.prepare('SELECT * FROM apps WHERE name = ?').get(name) as Row | undefined;
  }

  list(): AppRecord[] {
    return (this.db.prepare('SELECT * FROM apps ORDER BY name').all() as unknown as Row[]).map((r) => this.toRecord(r));
  }

  get(name: string): AppRecord | null {
    const r = this.row(name);
    return r ? this.toRecord(r) : null;
  }

  /** Decrypted environment, for passing to the agent only. Never return this from the API. */
  env(name: string): Record<string, string> {
    const r = this.row(name);
    return r ? this.envOf(r) : {};
  }

  create(spec: AppSpec, env: Record<string, string>, applied: boolean): AppRecord {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO apps (name, spec, env_sealed, created_at, updated_at, last_applied_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(spec.name, JSON.stringify(spec), this.box.sealJson(env), now, now, applied ? now : null);
    return this.get(spec.name)!;
  }

  update(name: string, spec: AppSpec, env: Record<string, string>, applied: boolean): AppRecord {
    const now = Date.now();
    this.db
      .prepare(
        `UPDATE apps SET spec = ?, env_sealed = ?, updated_at = ?,
           last_applied_at = CASE WHEN ? THEN ? ELSE last_applied_at END, last_error = CASE WHEN ? THEN NULL ELSE last_error END
         WHERE name = ?`,
      )
      .run(JSON.stringify(spec), this.box.sealJson(env), now, applied ? 1 : 0, now, applied ? 1 : 0, name);
    return this.get(name)!;
  }

  markApplied(name: string, error: string | null): void {
    if (error) this.db.prepare('UPDATE apps SET last_error = ? WHERE name = ?').run(error.slice(0, 1000), name);
    else this.db.prepare('UPDATE apps SET last_applied_at = ?, last_error = NULL WHERE name = ?').run(Date.now(), name);
  }

  delete(name: string): boolean {
    return Number(this.db.prepare('DELETE FROM apps WHERE name = ?').run(name).changes) > 0;
  }
}
