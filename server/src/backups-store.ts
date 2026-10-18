import type { Db } from './db/index.ts';
import type { SecretBox } from './secretbox.ts';
import { redactMongoUri, type BackupSource, type Retention, type S3Access, type S3Secrets, type S3Target, type Schedule } from './agent/backup-spec.ts';

export interface PlanSpec {
  sources: BackupSource[];
  schedule: Schedule;
  retention: Retention;
  /** Keep a copy on this server. */
  keepLocal: boolean;
  /** Name of the S3 destination to copy to, or null. */
  destination: string | null;
}

export interface PlanRecord extends PlanSpec {
  name: string;
  enabled: boolean;
  nextRunAt: number | null;
  /** Connection strings with the password hidden, by MongoDB source name. */
  mongo: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface DestinationRecord {
  name: string;
  target: S3Target;
  /** First characters of the access key ID, to recognise which key is stored. */
  keyHint: string;
  createdAt: number;
  updatedAt: number;
  lastTestAt: number | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
}

export type RunKind = 'backup' | 'restore' | 'verify';
export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed';

export interface RunRecord {
  id: number;
  plan: string;
  kind: RunKind;
  trigger: 'manual' | 'schedule';
  jobId: string | null;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  artifact: string | null;
  sizeBytes: number | null;
  step: string | null;
  message: string | null;
  result: unknown;
  actor: string | null;
}

interface PlanRow {
  name: string;
  enabled: number;
  spec: string;
  mongo_sealed: string | null;
  next_run_at: number | null;
  created_at: number;
  updated_at: number;
}

interface DestRow {
  name: string;
  target: string;
  secrets_sealed: string;
  created_at: number;
  updated_at: number;
  last_test_at: number | null;
  last_test_ok: number | null;
  last_test_message: string | null;
}

interface RunRow {
  id: number;
  plan: string;
  kind: RunKind;
  trigger: 'manual' | 'schedule';
  job_id: string | null;
  status: RunStatus;
  started_at: number;
  finished_at: number | null;
  artifact: string | null;
  size_bytes: number | null;
  step: string | null;
  message: string | null;
  result: string | null;
  actor: string | null;
}

/** Backup plans, S3 destinations and run history. Connection strings and keys are sealed. */
export class BackupsStore {
  private readonly db: Db;
  private readonly box: SecretBox;
  constructor(db: Db, box: SecretBox) {
    this.db = db;
    this.box = box;
  }

  // ---- destinations -------------------------------------------------------------

  private destRecord(r: DestRow): DestinationRecord {
    const secrets = this.box.openJson<S3Secrets>(r.secrets_sealed);
    return {
      name: r.name,
      target: JSON.parse(r.target) as S3Target,
      keyHint: secrets.accessKeyId.slice(0, 4) + '…',
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      lastTestAt: r.last_test_at,
      lastTestOk: r.last_test_ok === null ? null : r.last_test_ok === 1,
      lastTestMessage: r.last_test_message,
    };
  }

  listDestinations(): DestinationRecord[] {
    return (this.db.prepare('SELECT * FROM backup_destinations ORDER BY name').all() as unknown as DestRow[]).map((r) => this.destRecord(r));
  }

  getDestination(name: string): DestinationRecord | null {
    const r = this.db.prepare('SELECT * FROM backup_destinations WHERE name = ?').get(name) as DestRow | undefined;
    return r ? this.destRecord(r) : null;
  }

  /** Decrypted settings and keys, for handing to the agent only. */
  access(name: string): S3Access | null {
    const r = this.db.prepare('SELECT * FROM backup_destinations WHERE name = ?').get(name) as DestRow | undefined;
    return r ? { target: JSON.parse(r.target) as S3Target, secrets: this.box.openJson<S3Secrets>(r.secrets_sealed) } : null;
  }

  createDestination(name: string, target: S3Target, secrets: S3Secrets): DestinationRecord {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO backup_destinations (name, target, secrets_sealed, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(name, JSON.stringify(target), this.box.sealJson(secrets), now, now);
    return this.getDestination(name)!;
  }

  updateDestination(name: string, target: S3Target, secrets: S3Secrets): DestinationRecord {
    this.db
      .prepare('UPDATE backup_destinations SET target = ?, secrets_sealed = ?, updated_at = ?, last_test_at = NULL, last_test_ok = NULL, last_test_message = NULL WHERE name = ?')
      .run(JSON.stringify(target), this.box.sealJson(secrets), Date.now(), name);
    return this.getDestination(name)!;
  }

  setDestinationTest(name: string, ok: boolean, message: string): void {
    this.db
      .prepare('UPDATE backup_destinations SET last_test_at = ?, last_test_ok = ?, last_test_message = ? WHERE name = ?')
      .run(Date.now(), ok ? 1 : 0, message.slice(0, 500), name);
  }

  deleteDestination(name: string): boolean {
    return Number(this.db.prepare('DELETE FROM backup_destinations WHERE name = ?').run(name).changes) > 0;
  }

  // ---- plans --------------------------------------------------------------------

  private planRecord(r: PlanRow): PlanRecord {
    const uris = r.mongo_sealed ? this.box.openJson<Record<string, string>>(r.mongo_sealed) : {};
    return {
      ...(JSON.parse(r.spec) as PlanSpec),
      name: r.name,
      enabled: r.enabled === 1,
      nextRunAt: r.next_run_at,
      mongo: Object.fromEntries(Object.entries(uris).map(([k, v]) => [k, redactMongoUri(v)])),
      createdAt: r.created_at,
      updatedAt: r.updated_at,
    };
  }

  listPlans(): PlanRecord[] {
    return (this.db.prepare('SELECT * FROM backup_plans ORDER BY name').all() as unknown as PlanRow[]).map((r) => this.planRecord(r));
  }

  getPlan(name: string): PlanRecord | null {
    const r = this.db.prepare('SELECT * FROM backup_plans WHERE name = ?').get(name) as PlanRow | undefined;
    return r ? this.planRecord(r) : null;
  }

  /** Decrypted connection strings, for handing to the agent only. */
  mongoUris(name: string): Record<string, string> {
    const r = this.db.prepare('SELECT mongo_sealed FROM backup_plans WHERE name = ?').get(name) as { mongo_sealed: string | null } | undefined;
    return r?.mongo_sealed ? this.box.openJson<Record<string, string>>(r.mongo_sealed) : {};
  }

  createPlan(name: string, enabled: boolean, spec: PlanSpec, uris: Record<string, string>, nextRunAt: number | null): PlanRecord {
    const now = Date.now();
    this.db
      .prepare('INSERT INTO backup_plans (name, enabled, spec, mongo_sealed, next_run_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name, enabled ? 1 : 0, JSON.stringify(spec), this.box.sealJson(uris), nextRunAt, now, now);
    return this.getPlan(name)!;
  }

  updatePlan(name: string, enabled: boolean, spec: PlanSpec, uris: Record<string, string>, nextRunAt: number | null): PlanRecord {
    this.db
      .prepare('UPDATE backup_plans SET enabled = ?, spec = ?, mongo_sealed = ?, next_run_at = ?, updated_at = ? WHERE name = ?')
      .run(enabled ? 1 : 0, JSON.stringify(spec), this.box.sealJson(uris), nextRunAt, Date.now(), name);
    return this.getPlan(name)!;
  }

  setNextRun(name: string, at: number | null): void {
    this.db.prepare('UPDATE backup_plans SET next_run_at = ? WHERE name = ?').run(at, name);
  }

  deletePlan(name: string): boolean {
    return Number(this.db.prepare('DELETE FROM backup_plans WHERE name = ?').run(name).changes) > 0;
  }

  plansUsing(destination: string): string[] {
    return this.listPlans().filter((p) => p.destination === destination).map((p) => p.name);
  }

  // ---- runs ---------------------------------------------------------------------

  private runRecord(r: RunRow): RunRecord {
    return {
      id: r.id,
      plan: r.plan,
      kind: r.kind,
      trigger: r.trigger,
      jobId: r.job_id,
      status: r.status,
      startedAt: r.started_at,
      finishedAt: r.finished_at,
      artifact: r.artifact,
      sizeBytes: r.size_bytes,
      step: r.step,
      message: r.message,
      result: r.result ? (JSON.parse(r.result) as unknown) : null,
      actor: r.actor,
    };
  }

  createRun(r: { plan: string; kind: RunKind; trigger: 'manual' | 'schedule'; jobId: string | null; artifact?: string | null; actor: string | null; status?: RunStatus; message?: string | null }): RunRecord {
    const now = Date.now();
    const status = r.status ?? 'running';
    const res = this.db
      .prepare('INSERT INTO backup_runs (plan, kind, trigger, job_id, status, started_at, finished_at, artifact, message, actor) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.plan, r.kind, r.trigger, r.jobId, status, now, status === 'running' ? null : now, r.artifact ?? null, r.message ?? null, r.actor);
    return this.getRun(Number(res.lastInsertRowid))!;
  }

  getRun(id: number): RunRecord | null {
    const r = this.db.prepare('SELECT * FROM backup_runs WHERE id = ?').get(id) as RunRow | undefined;
    return r ? this.runRecord(r) : null;
  }

  listRuns(opts: { plan?: string; limit?: number } = {}): RunRecord[] {
    const limit = Math.min(Math.max(opts.limit ?? 30, 1), 200);
    const rows = opts.plan
      ? this.db.prepare('SELECT * FROM backup_runs WHERE plan = ? ORDER BY id DESC LIMIT ?').all(opts.plan, limit)
      : this.db.prepare('SELECT * FROM backup_runs ORDER BY id DESC LIMIT ?').all(limit);
    return (rows as unknown as RunRow[]).map((r) => this.runRecord(r));
  }

  runningRuns(): RunRecord[] {
    return (this.db.prepare("SELECT * FROM backup_runs WHERE status = 'running' ORDER BY id").all() as unknown as RunRow[]).map((r) => this.runRecord(r));
  }

  setRunProgress(id: number, step: string): void {
    this.db.prepare('UPDATE backup_runs SET step = ? WHERE id = ?').run(step.slice(0, 300), id);
  }

  finishRun(id: number, f: { status: Exclude<RunStatus, 'running'>; message: string | null; artifact?: string | null; sizeBytes?: number | null; result?: unknown }): RunRecord {
    this.db
      .prepare('UPDATE backup_runs SET status = ?, finished_at = ?, message = ?, artifact = COALESCE(?, artifact), size_bytes = ?, result = ?, step = NULL WHERE id = ?')
      .run(f.status, Date.now(), f.message ? f.message.slice(0, 2000) : null, f.artifact ?? null, f.sizeBytes ?? null, f.result === undefined ? null : JSON.stringify(f.result), id);
    return this.getRun(id)!;
  }

  /** Keep the history table from growing forever. */
  pruneRuns(keep = 500): number {
    return Number(this.db.prepare("DELETE FROM backup_runs WHERE status != 'running' AND id NOT IN (SELECT id FROM backup_runs ORDER BY id DESC LIMIT ?)").run(keep).changes);
  }
}
