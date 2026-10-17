import type { Db } from './db/index.ts';
import { redact } from './redact.ts';

export type Outcome = 'success' | 'failure' | 'info';

export interface AuditEntry {
  actor?: string | null;
  ip?: string | null;
  action: string;
  target?: string | null;
  outcome: Outcome;
  details?: Record<string, unknown>;
}

export interface AuditRow {
  id: number;
  ts: number;
  actor: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  outcome: Outcome;
  details: Record<string, unknown> | null;
}

const ACTION = /^[a-z][a-z0-9_.]{1,63}$/;

export class Audit {
  private readonly db: Db;
  constructor(db: Db) {
    this.db = db;
  }

  record(e: AuditEntry): void {
    if (!ACTION.test(e.action)) throw new Error(`Invalid audit action "${e.action}"`);
    const details = e.details ? JSON.stringify(redact(e.details)).slice(0, 8000) : null;
    this.db
      .prepare('INSERT INTO audit_log (ts, actor, ip, action, target, outcome, details) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(Date.now(), e.actor ?? null, e.ip ?? null, e.action, e.target ?? null, e.outcome, details);
  }

  list(opts: { limit?: number; beforeId?: number; outcome?: Outcome; actionPrefix?: string } = {}): AuditRow[] {
    const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (opts.beforeId) {
      where.push('id < ?');
      params.push(opts.beforeId);
    }
    if (opts.outcome) {
      where.push('outcome = ?');
      params.push(opts.outcome);
    }
    if (opts.actionPrefix) {
      where.push("action LIKE ? ESCAPE '\\'");
      params.push(opts.actionPrefix.replace(/[\\%_]/g, (m) => '\\' + m) + '%');
    }
    const sql =
      'SELECT id, ts, actor, ip, action, target, outcome, details FROM audit_log' +
      (where.length ? ' WHERE ' + where.join(' AND ') : '') +
      ' ORDER BY id DESC LIMIT ?';
    params.push(limit);
    const rows = this.db.prepare(sql).all(...params) as unknown as (Omit<AuditRow, 'details'> & { details: string | null })[];
    return rows.map((r) => ({ ...r, details: r.details ? (JSON.parse(r.details) as Record<string, unknown>) : null }));
  }

  prune(retentionDays: number): number {
    const cutoff = Date.now() - retentionDays * 86_400_000;
    const res = this.db.prepare('DELETE FROM audit_log WHERE ts < ?').run(cutoff);
    return Number(res.changes);
  }
}
