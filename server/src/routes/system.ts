import { serviceStatus, type ServiceStatus } from '../system/services.ts';
import { HttpError, type Router } from '../http/core.ts';
import type { AppContext } from '../context.ts';
import type { Outcome } from '../audit.ts';
import { VERSION } from '../version.ts';

const SERVICE_CACHE_MS = 15_000;

export function registerSystemRoutes(r: Router, app: AppContext): void {
  let svcCache: { at: number; data: ServiceStatus[] } | null = null;
  const services = async (): Promise<ServiceStatus[]> => {
    if (svcCache && Date.now() - svcCache.at < SERVICE_CACHE_MS) return svcCache.data;
    try {
      const data = await serviceStatus(app.run, app.config.services);
      svcCache = { at: Date.now(), data };
      return data;
    } catch (e) {
      app.log.warn('service status check failed', { error: (e as Error).message });
      return app.config.services.map((name) => ({ name, state: 'unknown' as const, enabled: null }));
    }
  };

  const metricsPayload = () => {
    const snap = app.metrics.snapshot();
    const interval = app.metrics.intervalSeconds;
    const ageMs = snap ? Date.now() - snap.collectedAt : null;
    return {
      metrics: snap,
      intervalSeconds: interval,
      // Stale if we missed more than two collection intervals (FR-03 acceptance).
      stale: ageMs === null || ageMs > interval * 2500,
      error: app.metrics.lastError,
      serverTime: Date.now(),
    };
  };

  r.get('/api/health', () => ({ status: 'ok', version: VERSION }), { auth: false });

  r.get('/api/system/overview', async () => {
    const recent = app.audit.list({ limit: 8 });
    const failures = app.audit.list({ limit: 5, outcome: 'failure' });
    return {
      version: VERSION,
      host: app.host,
      panel: {
        startedAt: app.startedAt,
        tls: app.config.tls.enabled,
        port: app.config.listen.port,
        pid: process.pid,
        nodeVersion: process.versions.node,
        memoryRssBytes: process.memoryUsage().rss,
      },
      services: await services(),
      ...metricsPayload(),
      activity: { recent, failures },
      // Modules arriving in later phases; the UI renders them as "coming soon".
      modules: {
        applications: { available: true, phase: 2 },
        deployments: { available: false, phase: 2 },
        sites: { available: true, phase: 3 },
        certificates: { available: true, phase: 3 },
        backups: { available: false, phase: 4 },
      },
    };
  });

  r.get('/api/system/metrics', () => metricsPayload());

  r.get('/api/system/history', () => ({
    intervalSeconds: app.metrics.intervalSeconds,
    points: app.metrics.history(),
  }));

  r.get('/api/system/services', async () => ({ services: await services() }));

  r.get('/api/audit', (ctx) => {
    const q = ctx.url.searchParams;
    const limit = q.has('limit') ? Number(q.get('limit')) : 50;
    const before = q.has('before') ? Number(q.get('before')) : undefined;
    const outcome = q.get('outcome') ?? undefined;
    const action = q.get('action') ?? undefined;
    if (!Number.isInteger(limit) || (before !== undefined && !Number.isInteger(before))) {
      throw new HttpError(400, 'invalid_query', 'limit and before must be integers.');
    }
    if (outcome && !['success', 'failure', 'info'].includes(outcome)) {
      throw new HttpError(400, 'invalid_query', 'outcome must be success, failure or info.');
    }
    if (action && !/^[a-z0-9_.]{1,64}$/.test(action)) throw new HttpError(400, 'invalid_query', 'Invalid action filter.');
    const entries = app.audit.list({ limit, beforeId: before, outcome: outcome as Outcome | undefined, actionPrefix: action });
    return { entries, nextBefore: entries.length === Math.min(Math.max(limit, 1), 200) ? entries.at(-1)?.id ?? null : null };
  });
}
