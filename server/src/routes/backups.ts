import { HttpError, obj, type Ctx, type Router } from '../http/core.ts';
import { agentError } from './apps.ts';
import { AgentUnavailableError } from '../agent-client.ts';
import { SpecError, type AgentRequest } from '../agent/spec.ts';
import {
  DESTINATION_NAME,
  MEMBER_FILE,
  PLAN_NAME,
  nextRun,
  parseArtifactRef,
  parseMongoUri,
  parseRetention,
  parseS3Secrets,
  parseS3Target,
  parseSchedule,
  parseSources,
  type ArtifactInfo,
  type ArtifactRef,
  type BackupJobView,
  type BackupStatus,
  type Manifest,
  type RestoreItem,
  type S3Access,
} from '../agent/backup-spec.ts';
import type { PlanRecord, PlanSpec } from '../backups-store.ts';
import type { AppContext } from '../context.ts';

function spec<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof SpecError) throw new HttpError(400, 'invalid_field', e.message, { field: e.field });
    throw e;
  }
}

export function registerBackupRoutes(r: Router, app: AppContext): void {
  const { backups } = app;
  const store = backups.store;

  const call = async <T>(req: AgentRequest): Promise<T> => {
    try {
      return await app.agent.call<T>(req);
    } catch (e) {
      agentError(e);
    }
  };
  const audit = (ctx: Ctx, action: string, target: string, outcome: 'success' | 'failure', details?: Record<string, unknown>) =>
    app.audit.record({ actor: ctx.user!.username, ip: ctx.ip, action, target, outcome, details });

  const planOf = (name: string | undefined): PlanRecord => {
    const p = name && PLAN_NAME.test(name) ? store.getPlan(name) : null;
    if (!p) throw new HttpError(404, 'not_found', 'Backup plan not found.');
    return p;
  };
  const destinationName = (v: string | undefined): string => {
    if (!v || !DESTINATION_NAME.test(v) || !store.getDestination(v)) throw new HttpError(404, 'not_found', 'Storage destination not found.');
    return v;
  };

  /** Folders to back up must be inside the configured roots (the agent re-checks and checks they exist). */
  const checkRoots = (spc: ReturnType<typeof parseSources>) => {
    const roots = app.config.backups.fileRoots;
    for (const s of spc) {
      if (s.type !== 'files') continue;
      const inside = roots.some((root) => s.path === root || s.path.startsWith(root.endsWith('/') ? root : root + '/'));
      if (!inside) throw new HttpError(400, 'invalid_field', `"${s.name}": folders to back up must be inside ${roots.join(' or ')}.`, { field: 'sources' });
    }
  };

  const nextAt = (enabled: boolean, schedule: PlanSpec['schedule']): number | null =>
    enabled ? (nextRun(schedule, new Date())?.getTime() ?? null) : null;

  /** Validate a plan from the UI; connection strings left blank keep their stored value. */
  const readPlan = (b: Record<string, unknown>, existing: PlanRecord | null) => {
    const sources = spec(() => parseSources(b.sources));
    checkRoots(sources);
    const given = typeof b.mongoUris === 'object' && b.mongoUris !== null ? (b.mongoUris as Record<string, unknown>) : {};
    const stored = existing ? store.mongoUris(existing.name) : {};
    const uris: Record<string, string> = {};
    for (const s of sources) {
      if (s.type !== 'mongodb') continue;
      const v = given[s.name];
      if (typeof v === 'string' && v.trim()) uris[s.name] = spec(() => parseMongoUri('mongoUris', v.trim()));
      else if (stored[s.name]) uris[s.name] = stored[s.name]!;
      else throw new HttpError(400, 'invalid_field', `Enter the connection string for "${s.name}".`, { field: 'mongoUris' });
    }
    const keepLocal = b.keepLocal !== false;
    const destination = typeof b.destination === 'string' && b.destination ? b.destination : null;
    if (destination && !store.getDestination(destination)) throw new HttpError(400, 'invalid_field', 'That storage destination does not exist.', { field: 'destination' });
    if (!keepLocal && !destination) throw new HttpError(400, 'invalid_field', 'Choose where to keep the backups: on this server, in cloud storage, or both.', { field: 'destination' });
    const schedule = spec(() => parseSchedule(b.schedule));
    const planSpec: PlanSpec = { sources, schedule, retention: spec(() => parseRetention(b.retention)), keepLocal, destination };
    const enabled = b.enabled !== false;
    return { planSpec, uris, enabled };
  };

  // ---- overview ---------------------------------------------------------------------

  r.get('/api/backups', async () => {
    await backups.poll().catch(() => undefined);
    let status: BackupStatus | null = null;
    let agent = { available: true, reason: null as string | null };
    try {
      status = await app.agent.call<BackupStatus>({ action: 'backup.status' });
    } catch (e) {
      if (!(e instanceof AgentUnavailableError)) agentError(e);
      agent = { available: false, reason: 'The OpenVPS agent is not running. On the server, run: sudo openvps provision' };
    }
    const runs = store.listRuns({ limit: 40 });
    const plans = store.listPlans().map((p) => {
      const mine = runs.filter((x) => x.plan === p.name);
      const lastBackup = store.listRuns({ plan: p.name, limit: 50 }).find((x) => x.kind === 'backup' && x.status !== 'running') ?? null;
      const lastGood = store.listRuns({ plan: p.name, limit: 50 }).find((x) => x.kind === 'backup' && (x.status === 'succeeded' || x.status === 'partial')) ?? null;
      return { ...p, running: mine.find((x) => x.status === 'running') ?? null, lastBackup, lastSuccessAt: lastGood?.finishedAt ?? null };
    });
    return {
      agent,
      status,
      plans,
      destinations: store.listDestinations().map((d) => ({ ...d, usedBy: store.plansUsing(d.name) })),
      runs,
      scheduler: app.config.backups.scheduler,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      serverTime: Date.now(),
    };
  });

  r.get('/api/backups/runs/:id', async (ctx) => {
    const id = Number(ctx.params.id);
    const run = Number.isInteger(id) ? store.getRun(id) : null;
    if (!run) throw new HttpError(404, 'not_found', 'Run not found.');
    const fresh = await backups.refresh(run);
    let log: string[] = [];
    if (fresh.status === 'running' && fresh.jobId) {
      try {
        log = (await app.agent.call<BackupJobView>({ action: 'backup.job', params: { id: fresh.jobId } })).log;
      } catch {
        /* progress is best-effort */
      }
    }
    return { run: fresh, log };
  });

  // ---- destinations -----------------------------------------------------------------

  const readDestination = (b: Record<string, unknown>, existing: S3Access | null) => {
    const target = spec(() => parseS3Target(b.target));
    const given = typeof b.secrets === 'object' && b.secrets !== null ? (b.secrets as Record<string, unknown>) : {};
    const blank = !given.accessKeyId && !given.secretAccessKey;
    if (blank && existing) return { target, secrets: existing.secrets };
    return { target, secrets: spec(() => parseS3Secrets(given)) };
  };

  r.post('/api/backups/destinations/test', async (ctx) => {
    const b = obj(ctx.body);
    // A name that is not saved yet just means "test these settings".
    const named = typeof b.name === 'string' && b.name ? store.access(b.name) : null;
    const access = readDestination(b, named);
    try {
      const res = await call<{ ok: true; ms: number }>({ action: 'backup.s3test', params: { s3: access } });
      if (named && typeof b.name === 'string' && b.target && JSON.stringify(access.target) === JSON.stringify(named.target)) {
        store.setDestinationTest(b.name, true, `Worked (${res.ms} ms).`);
      }
      return res;
    } catch (e) {
      if (named && typeof b.name === 'string' && e instanceof HttpError) store.setDestinationTest(b.name, false, e.message);
      throw e;
    }
  });

  r.post('/api/backups/destinations', (ctx) => {
    const b = obj(ctx.body);
    const name = typeof b.name === 'string' ? b.name : '';
    if (!DESTINATION_NAME.test(name)) throw new HttpError(400, 'invalid_field', 'Name: 2–40 characters, lowercase letters, digits and dashes, starting with a letter.', { field: 'name' });
    if (store.getDestination(name)) throw new HttpError(409, 'conflict', `A destination named "${name}" already exists.`, { field: 'name' });
    const { target, secrets } = readDestination(b, null);
    const rec = store.createDestination(name, target, secrets);
    audit(ctx, 'backup.destination_create', name, 'success', { bucket: target.bucket, endpoint: target.endpoint });
    return { destination: rec };
  });

  r.add('PUT', '/api/backups/destinations/:name', (ctx) => {
    const name = destinationName(ctx.params.name);
    const { target, secrets } = readDestination(obj(ctx.body), store.access(name));
    const rec = store.updateDestination(name, target, secrets);
    audit(ctx, 'backup.destination_update', name, 'success', { bucket: target.bucket, endpoint: target.endpoint });
    return { destination: rec };
  });

  r.delete('/api/backups/destinations/:name', (ctx) => {
    const name = destinationName(ctx.params.name);
    const users = store.plansUsing(name);
    if (users.length) throw new HttpError(409, 'conflict', `Still used by: ${users.join(', ')}. Change those plans first.`);
    store.deleteDestination(name);
    audit(ctx, 'backup.destination_delete', name, 'success');
    return { ok: true };
  });

  // ---- plans ------------------------------------------------------------------------

  r.post('/api/backups/plans', (ctx) => {
    const b = obj(ctx.body);
    const name = typeof b.name === 'string' ? b.name : '';
    if (!PLAN_NAME.test(name)) throw new HttpError(400, 'invalid_field', 'Name: 2–40 characters, lowercase letters, digits and dashes, starting with a letter.', { field: 'name' });
    if (store.getPlan(name)) throw new HttpError(409, 'conflict', `A plan named "${name}" already exists.`, { field: 'name' });
    const { planSpec, uris, enabled } = readPlan(b, null);
    const plan = store.createPlan(name, enabled, planSpec, uris, nextAt(enabled, planSpec.schedule));
    audit(ctx, 'backup.plan_create', name, 'success', { sources: planSpec.sources.map((s) => `${s.type}:${s.name}`), schedule: planSpec.schedule.kind });
    return { plan };
  });

  r.add('PUT', '/api/backups/plans/:name', (ctx) => {
    const existing = planOf(ctx.params.name);
    const { planSpec, uris, enabled } = readPlan(obj(ctx.body), existing);
    const plan = store.updatePlan(existing.name, enabled, planSpec, uris, nextAt(enabled, planSpec.schedule));
    audit(ctx, 'backup.plan_update', existing.name, 'success', { sources: planSpec.sources.map((s) => `${s.type}:${s.name}`), schedule: planSpec.schedule.kind });
    return { plan };
  });

  r.delete('/api/backups/plans/:name', (ctx) => {
    const plan = planOf(ctx.params.name);
    if (store.runningRuns().some((x) => x.plan === plan.name)) throw new HttpError(409, 'conflict', 'A backup task for this plan is running. Wait for it to finish.');
    store.deletePlan(plan.name);
    audit(ctx, 'backup.plan_delete', plan.name, 'success');
    return { ok: true };
  });

  r.post('/api/backups/plans/:name/run', async (ctx) => {
    const plan = planOf(ctx.params.name);
    try {
      return { run: await backups.startBackup(plan, 'manual', ctx.user!.username, ctx.ip) };
    } catch (e) {
      agentError(e);
    }
  }, { body: false });

  // ---- artifacts: list, inspect, verify, restore, delete ----------------------------------

  const refFrom = (plan: PlanRecord, where: unknown, artifact: unknown): { ref: ArtifactRef; s3: S3Access | null } => {
    if (where !== 'local' && where !== 'remote') throw new HttpError(400, 'invalid_field', 'Choose where the backup is.', { field: 'where' });
    const ref = spec(() => parseArtifactRef({ where: where === 'remote' ? 's3' : 'local', plan: plan.name, name: artifact }));
    const s3 = ref.where === 's3' ? backups.accessFor(plan) : null;
    if (ref.where === 's3' && !s3) throw new HttpError(400, 'invalid_field', 'This plan has no cloud storage.', { field: 'where' });
    return { ref, s3 };
  };

  r.get('/api/backups/plans/:name/artifacts', async (ctx) => {
    const plan = planOf(ctx.params.name);
    const res = await call<{ local: ArtifactInfo[]; remote: ArtifactInfo[] | null; remoteError: string | null }>({
      action: 'backup.list',
      params: { plan: plan.name, s3: backups.accessFor(plan) },
    });
    return { ...res, hasRemote: !!plan.destination };
  });

  r.get('/api/backups/plans/:name/inspect', async (ctx) => {
    const plan = planOf(ctx.params.name);
    const { ref, s3 } = refFrom(plan, ctx.url.searchParams.get('where'), ctx.url.searchParams.get('artifact'));
    const res = await call<{ manifest: Manifest; members: unknown[] }>({ action: 'backup.inspect', params: { ref, s3 } });
    return { ...res, mongoSources: Object.keys(store.mongoUris(plan.name)) };
  });

  r.post('/api/backups/plans/:name/verify', async (ctx) => {
    const plan = planOf(ctx.params.name);
    const b = obj(ctx.body);
    const { ref } = refFrom(plan, b.where, b.artifact);
    try {
      return { run: await backups.startVerify(plan, ref, b.deep === true, ctx.user!.username, ctx.ip) };
    } catch (e) {
      agentError(e);
    }
  });

  r.post('/api/backups/plans/:name/restore', async (ctx) => {
    const plan = planOf(ctx.params.name);
    const b = obj(ctx.body);
    const { ref } = refFrom(plan, b.where, b.artifact);
    // Restoring overwrites data; the person must type the plan name to proceed.
    if (b.confirm !== plan.name) throw new HttpError(400, 'confirmation_required', `Type "${plan.name}" to confirm the restore.`, { field: 'confirm' });
    const items = b.items;
    if (!Array.isArray(items) || items.length === 0) throw new HttpError(400, 'invalid_field', 'Choose what to restore.', { field: 'items' });
    const parsed: RestoreItem[] = items.map((it: unknown) => {
      const o = obj(it);
      if (typeof o.file !== 'string' || !MEMBER_FILE.test(o.file) || (o.target !== 'original' && o.target !== 'alternate')) {
        throw new HttpError(400, 'invalid_field', 'Invalid item.', { field: 'items' });
      }
      return { file: o.file, target: o.target };
    });
    try {
      return { run: await backups.startRestore(plan, ref, parsed, b.drop === true, ctx.user!.username, ctx.ip) };
    } catch (e) {
      agentError(e);
    }
  });

  r.delete('/api/backups/plans/:name/artifacts', async (ctx) => {
    const plan = planOf(ctx.params.name);
    const { ref, s3 } = refFrom(plan, ctx.url.searchParams.get('where'), ctx.url.searchParams.get('artifact'));
    try {
      await app.agent.call({ action: 'backup.delete', params: { ref, s3 } });
    } catch (e) {
      audit(ctx, 'backup.delete', plan.name, 'failure', { artifact: ref.name, where: ref.where });
      agentError(e);
    }
    audit(ctx, 'backup.delete', plan.name, 'success', { artifact: ref.name, where: ref.where });
    return { ok: true };
  });
}
