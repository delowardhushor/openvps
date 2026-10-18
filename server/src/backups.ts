import { AgentCallError, AgentUnavailableError, type AgentClient } from './agent-client.ts';
import type { Audit } from './audit.ts';
import type { Logger } from './logger.ts';
import type { BackupsStore, PlanRecord, RunKind, RunRecord } from './backups-store.ts';
import { nextRun, type ArtifactRef, type BackupJobSpec, type BackupJobView, type RestoreItem, type RestoreSpec, type S3Access } from './agent/backup-spec.ts';

/**
 * Runs backups for the panel: starts agent jobs, follows them to completion, records the
 * history, and starts scheduled plans when they are due. The agent owns the work; this
 * class only needs the panel's database, so a panel restart loses nothing (running jobs are
 * picked up again from the history table).
 */

const POLL_MS = 2000;
const SCHEDULE_CHECK_MS = 30_000;

interface BackupResultView {
  artifact?: string;
  sizeBytes?: number;
  warnings?: string[];
  restored?: unknown[];
}

export class BackupService {
  private readonly agent: AgentClient;
  private readonly audit: Audit;
  private readonly log: Logger;
  readonly store: BackupsStore;
  private timer: NodeJS.Timeout | null = null;
  private lastScheduleCheck = 0;
  private busy = false;

  constructor(deps: { agent: AgentClient; audit: Audit; log: Logger; store: BackupsStore }) {
    this.agent = deps.agent;
    this.audit = deps.audit;
    this.log = deps.log;
    this.store = deps.store;
  }

  // ---- building agent requests ----------------------------------------------------

  accessFor(plan: PlanRecord): S3Access | null {
    return plan.destination ? this.store.access(plan.destination) : null;
  }

  jobSpec(plan: PlanRecord): BackupJobSpec {
    return {
      plan: plan.name,
      sources: plan.sources,
      mongoUris: this.store.mongoUris(plan.name),
      local: plan.keepLocal,
      s3: this.accessFor(plan),
      retention: plan.retention,
    };
  }

  // ---- starting work --------------------------------------------------------------

  private async begin(plan: PlanRecord, kind: RunKind, trigger: 'manual' | 'schedule', actor: string, ip: string | null, artifact: string | null, call: () => Promise<BackupJobView>, auditAction: string): Promise<RunRecord> {
    const running = this.store.runningRuns().find((r) => r.plan === plan.name);
    if (running) {
      throw new AgentCallError('busy', `"${plan.name}" already has a ${running.kind} in progress.`);
    }
    let view: BackupJobView;
    try {
      view = await call();
    } catch (e) {
      this.audit.record({ actor, ip, action: auditAction, target: plan.name, outcome: 'failure', details: { trigger, error: (e as Error).message.slice(0, 300) } });
      throw e;
    }
    const run = this.store.createRun({ plan: plan.name, kind, trigger, jobId: view.id, artifact, actor });
    this.audit.record({ actor, ip, action: auditAction, target: plan.name, outcome: 'success', details: { trigger, run: run.id, artifact } });
    return run;
  }

  startBackup(plan: PlanRecord, trigger: 'manual' | 'schedule', actor: string, ip: string | null): Promise<RunRecord> {
    return this.begin(plan, 'backup', trigger, actor, ip, null, () => this.agent.call<BackupJobView>({ action: 'backup.run', params: { job: this.jobSpec(plan) } }), 'backup.run');
  }

  startRestore(plan: PlanRecord, ref: ArtifactRef, items: RestoreItem[], drop: boolean, actor: string, ip: string | null): Promise<RunRecord> {
    const restore: RestoreSpec = { ref, s3: ref.where === 's3' ? this.accessFor(plan) : null, items, mongoUris: this.store.mongoUris(plan.name), drop };
    return this.begin(plan, 'restore', 'manual', actor, ip, ref.name, () => this.agent.call<BackupJobView>({ action: 'backup.restore', params: { restore } }), 'backup.restore');
  }

  startVerify(plan: PlanRecord, ref: ArtifactRef, deep: boolean, actor: string, ip: string | null): Promise<RunRecord> {
    const s3 = ref.where === 's3' ? this.accessFor(plan) : null;
    return this.begin(plan, 'verify', 'manual', actor, ip, ref.name, () => this.agent.call<BackupJobView>({ action: 'backup.verify', params: { ref, s3, deep } }), 'backup.verify');
  }

  // ---- following jobs -------------------------------------------------------------

  /** Ask the agent how a running job is doing and record the outcome when it has finished. */
  async refresh(run: RunRecord): Promise<RunRecord> {
    if (run.status !== 'running' || !run.jobId) return run;
    let view: BackupJobView;
    try {
      view = await this.agent.call<BackupJobView>({ action: 'backup.job', params: { id: run.jobId } });
    } catch (e) {
      if (e instanceof AgentCallError && e.code === 'not_found') {
        return this.finish(run, { status: 'failed', message: 'The agent restarted while this was running, so the result is unknown. Check the backup list before relying on it.' });
      }
      if (!(e instanceof AgentUnavailableError)) this.log.warn('could not read backup job', { run: run.id, error: e as Error });
      return run;
    }
    if (view.status === 'running') {
      if (view.step !== run.step) this.store.setRunProgress(run.id, view.step);
      return this.store.getRun(run.id) ?? run;
    }
    const result = (view.result ?? {}) as BackupResultView;
    let message: string | null = null;
    if (view.status === 'failed') message = view.error?.message ?? 'The task failed.';
    else if (run.kind === 'backup') message = result.warnings?.length ? result.warnings.join(' ') : null;
    else if (run.kind === 'restore') message = `Restored ${result.restored?.length ?? 0} item(s).`;
    return this.finish(run, {
      status: view.status,
      message,
      artifact: result.artifact ?? null,
      sizeBytes: result.sizeBytes ?? null,
      result: view.result ?? undefined,
    });
  }

  private finish(run: RunRecord, f: { status: 'succeeded' | 'partial' | 'failed'; message: string | null; artifact?: string | null; sizeBytes?: number | null; result?: unknown }): RunRecord {
    const done = this.store.finishRun(run.id, f);
    this.audit.record({
      actor: run.actor,
      action: 'backup.finished',
      target: run.plan,
      outcome: f.status === 'failed' ? 'failure' : 'success',
      details: { run: run.id, kind: run.kind, status: f.status, trigger: run.trigger, artifact: done.artifact, error: f.status === 'failed' ? f.message?.slice(0, 300) : undefined },
    });
    this.store.pruneRuns();
    return done;
  }

  async poll(): Promise<void> {
    for (const r of this.store.runningRuns()) await this.refresh(r);
  }

  // ---- schedule -------------------------------------------------------------------

  /** Start every enabled plan whose time has come. A missed time (panel was off) runs once. */
  async schedule(now: number = Date.now()): Promise<number> {
    let started = 0;
    for (const plan of this.store.listPlans()) {
      if (!plan.enabled || plan.schedule.kind === 'manual' || plan.nextRunAt === null || plan.nextRunAt > now) continue;
      if (this.store.runningRuns().some((r) => r.plan === plan.name)) continue;
      const next = nextRun(plan.schedule, new Date(now))?.getTime() ?? null;
      try {
        await this.startBackup(plan, 'schedule', 'scheduler', null);
        started++;
      } catch (e) {
        if (e instanceof AgentCallError && e.code === 'busy') continue; // another task is running: try again shortly
        const message = e instanceof AgentUnavailableError ? 'The OpenVPS agent was not running at the scheduled time.' : (e as Error).message;
        this.log.warn('scheduled backup could not start', { plan: plan.name, error: message });
        this.store.createRun({ plan: plan.name, kind: 'backup', trigger: 'schedule', jobId: null, actor: 'scheduler', status: 'failed', message });
      }
      this.store.setNextRun(plan.name, next);
    }
    return started;
  }

  start(opts: { scheduler: boolean }): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.busy) return;
      this.busy = true;
      const now = Date.now();
      const work = async () => {
        await this.poll();
        if (opts.scheduler && now - this.lastScheduleCheck >= SCHEDULE_CHECK_MS) {
          this.lastScheduleCheck = now;
          await this.schedule(now);
        }
      };
      work()
        .catch((e: unknown) => this.log.error('backup scheduler error', { error: e as Error }))
        .finally(() => {
          this.busy = false;
        });
    }, POLL_MS);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
