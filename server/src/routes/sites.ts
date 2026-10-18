import { HttpError, obj, type Ctx, type Router } from '../http/core.ts';
import { agentError } from './apps.ts';
import { AgentUnavailableError } from '../agent-client.ts';
import { getSetting, setSetting } from '../db/index.ts';
import { parseEmail, parseSiteSpec, SITE_NAME, type CertInfo, type CheckResult, type NginxStatus, type SiteSpec, type SiteState } from '../agent/sites-spec.ts';
import { SpecError, type AgentRequest } from '../agent/spec.ts';
import type { AppContext } from '../context.ts';

const EMAIL_KEY = 'certificates.email';

interface ApplyResult {
  state: SiteState;
  warnings: string[];
  reload: string;
}

function siteName(v: string | undefined): string {
  if (!v || !SITE_NAME.test(v)) throw new HttpError(404, 'not_found', 'Site not found.');
  return v;
}

export function registerSiteRoutes(r: Router, app: AppContext): void {
  const call = async <T>(req: AgentRequest): Promise<T> => {
    try {
      return await app.agent.call<T>(req);
    } catch (e) {
      agentError(e);
    }
  };
  const parse = (input: unknown): SiteSpec => {
    try {
      return parseSiteSpec(input);
    } catch (e) {
      if (e instanceof SpecError) throw new HttpError(400, 'invalid_field', e.message, { field: e.field });
      throw e;
    }
  };
  const audit = (ctx: Ctx, action: string, target: string, outcome: 'success' | 'failure', details?: Record<string, unknown>) =>
    app.audit.record({ actor: ctx.user!.username, ip: ctx.ip, action, target, outcome, details });

  const email = (): string | null => getSetting(app.db, EMAIL_KEY) ?? null;

  /** Domains the panel itself is reachable on, for the "panel" site type. */
  const onePanelSite = (spec: SiteSpec) => {
    if (spec.type !== 'panel') return;
    const other = app.sites.list().find((s) => s.spec.type === 'panel' && s.name !== spec.name);
    if (other) throw new HttpError(409, 'conflict', `The panel already has a domain (site "${other.name}").`, { field: 'type' });
  };

  /** Check DNS + port 80, then issue a certificate and switch the site to HTTPS. */
  const issueFor = async (ctx: Ctx, spec: SiteSpec, skipChecks: boolean) => {
    let checks: CheckResult[] | null = null;
    if (!skipChecks) {
      checks = await call<CheckResult[]>({ action: 'site.check', params: { name: spec.name, domains: spec.domains } });
      const failing = checks.filter((c) => !c.httpOk);
      if (failing.length) {
        audit(ctx, 'certificate.issue', spec.name, 'failure', { reason: 'preflight', domains: failing.map((c) => c.domain) });
        return { checks, certificate: null, certificateError: failing.map((c) => c.message).join(' ') };
      }
    }
    try {
      const res = await call<ApplyResult & { certificate: CertInfo }>({ action: 'cert.issue', params: { spec, email: email() } });
      audit(ctx, 'certificate.issue', spec.name, 'success', { domains: spec.domains });
      app.sites.setError(spec.name, null);
      return { checks, certificate: res.certificate, state: res.state, certificateError: null };
    } catch (e) {
      const msg = e instanceof HttpError ? e.message : 'Certificate request failed.';
      audit(ctx, 'certificate.issue', spec.name, 'failure', { domains: spec.domains, error: msg.slice(0, 300) });
      if (e instanceof HttpError && e.code === 'certbot_failed') return { checks, certificate: null, certificateError: msg };
      throw e;
    }
  };

  // ---- overview --------------------------------------------------------------

  r.get('/api/sites', async () => {
    const records = app.sites.list();
    let nginx: NginxStatus | null = null;
    let states: SiteState[] = [];
    let certificates: CertInfo[] = [];
    let agent = { available: true, reason: null as string | null };
    try {
      [nginx, states, certificates] = await Promise.all([
        app.agent.call<NginxStatus>({ action: 'nginx.status' }),
        app.agent.call<SiteState[]>({ action: 'site.states', params: { specs: records.map((s) => s.spec) } }),
        app.agent.call<CertInfo[]>({ action: 'cert.list' }),
      ]);
    } catch (e) {
      if (!(e instanceof AgentUnavailableError)) agentError(e);
      agent = { available: false, reason: 'The OpenVPS agent is not running. On the server, run: sudo openvps provision' };
    }
    // Ports of registered apps (from their PORT variable) to help pick a proxy target.
    const targets = app.apps.list().map((a) => {
      const p = Number(app.apps.env(a.name).PORT);
      return { name: a.name, port: Number.isInteger(p) && p > 0 && p < 65536 ? p : null };
    });
    return {
      agent,
      nginx,
      sites: records.map((s) => ({ ...s, state: states.find((st) => st.name === s.name) ?? null })),
      certificates,
      targets,
      panel: { port: app.config.listen.port, tls: app.config.tls.enabled },
      certEmail: email(),
    };
  });

  r.get('/api/certificates', async () => {
    try {
      const [certificates, nginx] = await Promise.all([
        app.agent.call<CertInfo[]>({ action: 'cert.list' }),
        app.agent.call<NginxStatus>({ action: 'nginx.status' }),
      ]);
      return { available: true, certificates, certbot: nginx.certbot, nginxInstalled: nginx.installed };
    } catch (e) {
      if (e instanceof AgentUnavailableError) return { available: false, certificates: [], certbot: null, nginxInstalled: false };
      agentError(e);
    }
  });

  // ---- settings --------------------------------------------------------------

  r.get('/api/settings/certificates', () => ({ email: email() }));
  r.add('PUT', '/api/settings/certificates', (ctx) => {
    let value: string | null;
    try {
      value = parseEmail(obj(ctx.body).email);
    } catch (e) {
      throw new HttpError(400, 'invalid_field', (e as Error).message, { field: 'email' });
    }
    setSetting(app.db, EMAIL_KEY, value ?? '');
    if (!value) app.db.prepare('DELETE FROM settings WHERE key = ?').run(EMAIL_KEY);
    audit(ctx, 'settings.certificates', 'email', 'success');
    return { email: value };
  });

  // ---- sites -----------------------------------------------------------------

  r.post('/api/sites', async (ctx) => {
    const b = obj(ctx.body);
    const spec = parse(b.spec);
    if (app.sites.get(spec.name)) throw new HttpError(409, 'conflict', `A site named "${spec.name}" already exists.`, { field: 'name' });
    onePanelSite(spec);
    let applied: ApplyResult;
    try {
      applied = await call<ApplyResult>({ action: 'site.apply', params: { spec } });
    } catch (e) {
      audit(ctx, 'site.create', spec.name, 'failure', { domains: spec.domains, error: (e as Error).message.slice(0, 300) });
      throw e;
    }
    const record = app.sites.upsert(spec);
    audit(ctx, 'site.create', spec.name, 'success', { domains: spec.domains, type: spec.type });
    let cert: Awaited<ReturnType<typeof issueFor>> | null = null;
    if (spec.https && b.issueCertificate === true) cert = await issueFor(ctx, spec, b.skipChecks === true);
    return { site: record, state: cert?.state ?? applied.state, warnings: applied.warnings, reload: applied.reload, ...(cert ?? {}) };
  });

  r.add('PUT', '/api/sites/:name', async (ctx) => {
    const name = siteName(ctx.params.name);
    if (!app.sites.get(name)) throw new HttpError(404, 'not_found', 'Site not found.');
    const spec = parse({ ...(obj(obj(ctx.body).spec) as object), name });
    onePanelSite(spec);
    try {
      const applied = await call<ApplyResult>({ action: 'site.apply', params: { spec } });
      const record = app.sites.upsert(spec);
      audit(ctx, 'site.update', name, 'success', { domains: spec.domains, type: spec.type });
      return { site: record, ...applied };
    } catch (e) {
      audit(ctx, 'site.update', name, 'failure', { error: (e as Error).message.slice(0, 300) });
      throw e;
    }
  });

  r.delete('/api/sites/:name', async (ctx) => {
    const name = siteName(ctx.params.name);
    if (!app.sites.get(name)) throw new HttpError(404, 'not_found', 'Site not found.');
    const deleteCertificate = ctx.url.searchParams.get('deleteCertificate') === '1';
    const res = await call<{ reload: string; certificateDeleted: boolean }>({ action: 'site.remove', params: { name, deleteCertificate } });
    app.sites.delete(name);
    audit(ctx, 'site.delete', name, 'success', { certificateDeleted: res.certificateDeleted });
    return { ok: true, ...res };
  });

  r.post(
    '/api/sites/:name/check',
    async (ctx) => {
      const s = app.sites.get(siteName(ctx.params.name));
      if (!s) throw new HttpError(404, 'not_found', 'Site not found.');
      return { checks: await call<CheckResult[]>({ action: 'site.check', params: { name: s.name, domains: s.spec.domains } }) };
    },
    { body: false },
  );

  r.post('/api/sites/:name/certificate', async (ctx) => {
    const s = app.sites.get(siteName(ctx.params.name));
    if (!s) throw new HttpError(404, 'not_found', 'Site not found.');
    const b = obj(ctx.body ?? {});
    const spec: SiteSpec = { ...s.spec, https: true };
    if (!s.spec.https) app.sites.upsert(spec);
    return issueFor(ctx, spec, b.skipChecks === true);
  });

  r.get('/api/sites/:name/config', async (ctx) => {
    const s = app.sites.get(siteName(ctx.params.name));
    if (!s) throw new HttpError(404, 'not_found', 'Site not found.');
    return call<{ content: string; current: string | null }>({ action: 'site.config', params: { spec: s.spec } });
  });
}
