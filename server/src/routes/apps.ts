import { AgentCallError, AgentUnavailableError } from '../agent-client.ts';
import { HttpError, obj, type Ctx, type Router } from '../http/core.ts';
import {
  CONTROL_OPS,
  PROCESS_NAME,
  APP_NAME,
  parseAppSpec,
  parseEnv,
  SpecError,
  type AgentInfo,
  type AgentRequest,
  type AppSpec,
  type ControlOp,
  type Owner,
  type Pm2Status,
  type ProcessInfo,
} from '../agent/spec.ts';
import type { AppContext } from '../context.ts';

const STATUS_BY_CODE: Record<string, number> = {
  invalid: 400,
  not_found: 404,
  forbidden: 403,
  conflict: 409,
  pm2_unavailable: 503,
  nginx_missing: 503,
  certbot_missing: 503,
  nginx_layout: 422,
  nginx_broken: 422,
  nginx_test_failed: 422,
  certbot_failed: 422,
};

/** Translate agent failures into API errors the UI can show. */
export function agentError(e: unknown): never {
  if (e instanceof AgentUnavailableError) {
    throw new HttpError(503, 'agent_unavailable', 'The OpenVPS agent is not running. On the server, run: sudo openvps provision');
  }
  if (e instanceof AgentCallError) {
    const status = STATUS_BY_CODE[e.code] ?? 502;
    throw new HttpError(status, e.code, e.message, e.field ? { field: e.field } : undefined);
  }
  if (e instanceof SpecError) throw new HttpError(400, 'invalid_field', e.message, { field: e.field });
  throw e;
}

function owner(v: string | undefined): Owner {
  if (v !== 'root' && v !== 'apps') throw new HttpError(404, 'not_found', 'Unknown process owner.');
  return v;
}

function processName(v: string | undefined): string {
  if (!v || !PROCESS_NAME.test(v)) throw new HttpError(400, 'invalid_field', 'Invalid process name.');
  return v;
}

function appName(v: string | undefined): string {
  if (!v || !APP_NAME.test(v)) throw new HttpError(404, 'not_found', 'Application not found.');
  return v;
}

interface ListResult {
  status: Pm2Status;
  processes: ProcessInfo[];
}

export function registerAppRoutes(r: Router, app: AppContext): void {
  const call = async <T>(req: AgentRequest): Promise<T> => {
    try {
      return await app.agent.call<T>(req);
    } catch (e) {
      agentError(e);
    }
  };

  const audit = (ctx: Ctx, action: string, target: string, outcome: 'success' | 'failure', details?: Record<string, unknown>) =>
    app.audit.record({ actor: ctx.user!.username, ip: ctx.ip, action, target, outcome, details });

  /** Run an agent action and audit the outcome either way. */
  const audited = async <T>(ctx: Ctx, action: string, target: string, details: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => {
    try {
      const res = await fn();
      audit(ctx, action, target, 'success', details);
      return res;
    } catch (e) {
      audit(ctx, action, target, 'failure', { ...details, error: e instanceof Error ? e.message.slice(0, 300) : 'error' });
      throw e;
    }
  };

  let infoCache: { at: number; info: AgentInfo } | null = null;
  const agentInfo = async (): Promise<AgentInfo> => {
    if (infoCache && Date.now() - infoCache.at < 15_000) return infoCache.info;
    const info = await call<AgentInfo>({ action: 'agent.info' });
    infoCache = { at: Date.now(), info };
    return info;
  };

  const applyApp = (spec: AppSpec, env: Record<string, string>, start: boolean) =>
    call<ProcessInfo | null>({ action: 'app.apply', params: { spec, env, start } });

  // ---- Agent and processes -------------------------------------------------

  r.get('/api/agent', async () => {
    try {
      return { available: true, info: await agentInfo() };
    } catch (e) {
      if (e instanceof HttpError && e.code === 'agent_unavailable') return { available: false, reason: e.message };
      throw e;
    }
  });

  r.get('/api/processes', async () => {
    const registered = app.apps.list();
    let available = true;
    let reason: string | null = null;
    const empty: ListResult = { status: { available: false, reason: null, version: null }, processes: [] };
    let root = empty;
    let apps = empty;
    try {
      [root, apps] = await Promise.all([
        call<ListResult>({ action: 'pm2.list', params: { owner: 'root' } }).catch((e: unknown) => {
          if (e instanceof HttpError && e.code !== 'agent_unavailable') {
            return { status: { available: false, reason: e.message, version: null }, processes: [] };
          }
          throw e;
        }),
        call<ListResult>({ action: 'pm2.list', params: { owner: 'apps' } }),
      ]);
    } catch (e) {
      if (!(e instanceof HttpError && e.code === 'agent_unavailable')) throw e;
      available = false;
      reason = e.message;
    }
    return {
      agent: { available, reason },
      root,
      apps,
      registered: registered.map((a) => ({
        name: a.name,
        spec: a.spec,
        envKeys: a.envKeys,
        lastError: a.lastError,
        process: apps.processes.find((p) => p.name === a.name) ?? null,
      })),
      fetchedAt: Date.now(),
    };
  });

  r.post(
    '/api/processes/:owner/:name/:op',
    async (ctx) => {
      const o = owner(ctx.params.owner);
      const name = processName(ctx.params.name);
      const op = ctx.params.op as ControlOp;
      if (!(CONTROL_OPS as readonly string[]).includes(op)) throw new HttpError(404, 'not_found', 'Unknown operation.');
      return audited(ctx, 'process.control', `${o}:${name}`, { op }, async () => {
        // Starting a registered app that is not in PM2 yet (or was removed from it) deploys its config.
        const registered = o === 'apps' ? app.apps.get(name) : null;
        if (registered && op === 'start') {
          const list = await call<ListResult>({ action: 'pm2.list', params: { owner: 'apps' } });
          if (!list.processes.some((p) => p.name === name)) {
            const p = await applyApp(registered.spec, app.apps.env(name), true);
            app.apps.markApplied(name, null);
            return p;
          }
        }
        return call<ProcessInfo>({ action: 'pm2.control', params: { owner: o, name, op } });
      });
    },
    { body: false },
  );

  r.get('/api/processes/:owner/:name/logs', async (ctx) => {
    const o = owner(ctx.params.owner);
    const name = processName(ctx.params.name);
    const stream = ctx.url.searchParams.get('stream') === 'err' ? 'err' : 'out';
    const lines = Math.min(Math.max(Number(ctx.url.searchParams.get('lines') ?? 200) || 200, 10), 2000);
    const res = await call<{ path: string | null; lines: string[] }>({ action: 'pm2.logs', params: { owner: o, name, stream, lines } });
    return { ...res, stream, fetchedAt: Date.now() };
  });

  // ---- Registered applications ---------------------------------------------

  r.get('/api/apps', () => ({ apps: app.apps.list() }));

  r.get('/api/apps/:name', (ctx) => {
    const a = app.apps.get(appName(ctx.params.name));
    if (!a) throw new HttpError(404, 'not_found', 'Application not found.');
    return { app: a };
  });

  r.post('/api/apps', async (ctx) => {
    const b = obj(ctx.body);
    let spec: AppSpec;
    let env: Record<string, string>;
    try {
      spec = parseAppSpec(b.spec);
      env = parseEnv(b.env);
    } catch (e) {
      agentError(e);
    }
    const start = b.start !== false;
    if (app.apps.get(spec.name)) throw new HttpError(409, 'conflict', `An application named "${spec.name}" already exists.`, { field: 'name' });
    const existing = await call<ListResult>({ action: 'pm2.list', params: { owner: 'apps' } });
    if (existing.processes.some((p) => p.name === spec.name)) {
      throw new HttpError(409, 'conflict', `A PM2 process named "${spec.name}" already exists for the apps user.`, { field: 'name' });
    }
    // The agent validates paths and runtime (and starts the app) before anything is stored.
    const proc = await audited(ctx, 'app.create', spec.name, { start, envKeys: Object.keys(env) }, () => applyApp(spec, env, start));
    const record = app.apps.create(spec, env, start);
    return { app: record, process: proc };
  });

  r.add('PUT', '/api/apps/:name', async (ctx) => {
    const name = appName(ctx.params.name);
    const current = app.apps.get(name);
    if (!current) throw new HttpError(404, 'not_found', 'Application not found.');
    const b = obj(ctx.body);
    let spec: AppSpec;
    try {
      spec = parseAppSpec({ ...(obj(b.spec) as object), name });
    } catch (e) {
      agentError(e);
    }
    const restart = b.restart !== false;
    const env = app.apps.env(name);
    const proc = await audited(ctx, 'app.update', name, { restart }, () => applyApp(spec, env, restart));
    return { app: app.apps.update(name, spec, env, restart), process: proc };
  });

  r.add('PUT', '/api/apps/:name/env', async (ctx) => {
    const name = appName(ctx.params.name);
    const current = app.apps.get(name);
    if (!current) throw new HttpError(404, 'not_found', 'Application not found.');
    const b = obj(ctx.body);
    let set: Record<string, string>;
    try {
      set = parseEnv(b.set ?? {});
    } catch (e) {
      agentError(e);
    }
    const unset = Array.isArray(b.unset) ? b.unset.filter((k): k is string => typeof k === 'string') : [];
    const env = { ...app.apps.env(name) };
    for (const k of unset) delete env[k];
    Object.assign(env, set);
    try {
      parseEnv(env); // limits on the merged result
    } catch (e) {
      agentError(e);
    }
    const restart = b.restart !== false;
    const details = { restart, set: Object.keys(set), unset };
    const proc = restart ? await audited(ctx, 'app.env_update', name, details, () => applyApp(current.spec, env, true)) : null;
    if (!restart) audit(ctx, 'app.env_update', name, 'success', details);
    return { app: app.apps.update(name, current.spec, env, restart), process: proc };
  });

  r.delete('/api/apps/:name', async (ctx) => {
    const name = appName(ctx.params.name);
    if (!app.apps.get(name)) throw new HttpError(404, 'not_found', 'Application not found.');
    await audited(ctx, 'app.delete', name, {}, () => call({ action: 'app.remove', params: { name } }));
    app.apps.delete(name);
    return { ok: true };
  });
}
