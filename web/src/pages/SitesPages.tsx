import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type CertificateResult, type CheckResult, type SiteRecord, type SitesOverview } from '../api';
import { SiteForm, initialSiteForm, parseDomains, toSiteSpec, type SiteFormValue } from '../components/SiteForm';
import { CertBadge, CheckList, DnsHint, DomainLinks, HttpsBadge, TYPE_LABEL, target } from '../components/SiteBits';
import { shortDate } from '../format';

function useSites() {
  const [data, setData] = useState<SitesOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api.sites());
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, reload: load };
}

function Back({ to, label, navigate }: { to: string; label: string; navigate: (p: string) => void }) {
  return (
    <a
      href={to}
      className="back"
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      ← {label}
    </a>
  );
}

function NginxBanner({ data }: { data: SitesOverview }) {
  if (!data.agent.available) {
    return (
      <div className="alert alert-warn">
        <strong>The OpenVPS agent is not running.</strong> On the server, run <code>sudo openvps provision</code>.
      </div>
    );
  }
  const n = data.nginx;
  if (!n) return null;
  if (!n.installed) {
    return (
      <div className="alert alert-warn">
        <strong>Nginx is not installed.</strong> Install it on the server with <code>sudo apt install nginx certbot</code>, then reload this page.
      </div>
    );
  }
  if (!n.configOk) {
    return (
      <div className="alert alert-error">
        <strong>Nginx's configuration has an error</strong>, so OpenVPS won't change anything until it's fixed. Run <code>sudo nginx -t</code> on the server.
        {n.configError && <pre className="pre-error">{n.configError}</pre>}
      </div>
    );
  }
  return (
    <>
      {!n.running && <div className="alert alert-warn">Nginx is installed but not running. Start it with <code>sudo systemctl start nginx</code>.</div>}
      {!n.certbot.installed && (
        <div className="alert alert-warn">
          Certbot is not installed, so HTTPS certificates can't be issued. Install it with <code>sudo apt install certbot</code>.
        </div>
      )}
    </>
  );
}

export function SitesPage({ navigate }: { navigate: (p: string) => void }) {
  const { data, error } = useSites();
  const certFor = (path: string | null) => (path ? data?.certificates.find((c) => c.path === path || (c.name && path.includes(`/live/${c.name}/`))) ?? null : null);

  // Group existing (hand-made) server blocks by file so each site shows once.
  const existing = new Map<string, { names: string[]; ssl: boolean; cert: string | null; target: string }>();
  for (const s of data?.nginx?.existing ?? []) {
    const e = existing.get(s.file) ?? { names: [], ssl: false, cert: null, target: '' };
    for (const n of s.serverNames) if (n !== '_' && !e.names.includes(n)) e.names.push(n);
    e.ssl ||= s.ssl;
    e.cert ??= s.certificate;
    e.target ||= s.proxyPass[0] ? `→ ${s.proxyPass[0]}` : s.root ?? '';
    existing.set(s.file, e);
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Sites &amp; domains</h1>
          <p className="muted">Domains served by Nginx on this server, with free HTTPS certificates.</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/sites/new')} disabled={!data?.nginx?.installed || !data.nginx.configOk}>
          New site
        </button>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      {!data && !error && <div className="loading">Loading sites…</div>}
      {data && <NginxBanner data={data} />}

      {data?.nginx?.installed && (
        <>
          <section className="card table-card section-gap">
            <div className="card-head card-head-pad">
              <h2>Managed by OpenVPS</h2>
              <span className="muted small">
                Nginx {data.nginx.version}
                {data.nginx.certbot.renewalTimer ? ` · automatic renewal active (${data.nginx.certbot.renewalTimer})` : ''}
              </span>
            </div>
            {data.sites.length ? (
              <div className="table-scroll">
                <table className="table table-hover">
                  <thead>
                    <tr>
                      <th>Site</th>
                      <th className="hide-sm">Serves</th>
                      <th>HTTPS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.sites.map((s) => (
                      <tr key={s.name} className="clickable" onClick={() => navigate(`/sites/${s.name}`)}>
                        <td>
                          <a
                            className="row-link"
                            href={`/sites/${s.name}`}
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              navigate(`/sites/${s.name}`);
                            }}
                          >
                            {s.name}
                          </a>
                          <div className="small">
                            <DomainLinks domains={s.spec.domains} https={!!s.state?.httpsActive} />
                          </div>
                          {s.lastError && <div className="text-fail small">{s.lastError}</div>}
                        </td>
                        <td className="hide-sm">
                          <div>{TYPE_LABEL[s.spec.type]}</div>
                          <div className="muted small mono ellipsis">{target(s.spec)}</div>
                        </td>
                        <td>
                          <HttpsBadge site={s} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-inline">
                <p>No sites yet.</p>
                <p className="muted small">Put a domain in front of an app, a React build, a static website, or this panel.</p>
                <button className="btn btn-primary" onClick={() => navigate('/sites/new')} disabled={!data.nginx.configOk}>
                  Add your first site
                </button>
              </div>
            )}
          </section>

          <section className="card table-card section-gap">
            <div className="card-head card-head-pad">
              <h2>
                Existing Nginx sites <span className="owner owner-root">read-only</span>
              </h2>
              <span className="muted small">Configured by hand. OpenVPS shows them but never changes them.</span>
            </div>
            {existing.size ? (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Domains</th>
                      <th className="hide-sm">Serves</th>
                      <th>HTTPS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...existing.entries()].map(([file, e]) => (
                      <tr key={file}>
                        <td>
                          {e.names.length ? <DomainLinks domains={e.names} https={e.ssl} /> : <span className="muted">default (any domain)</span>}
                          <div className="muted small mono">{file}</div>
                        </td>
                        <td className="hide-sm muted small mono ellipsis">{e.target}</td>
                        <td>{e.ssl ? <CertBadge cert={certFor(e.cert)} /> : <span className="pill pill-muted">HTTP only</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-inline muted">No other Nginx sites.</div>
            )}
          </section>
        </>
      )}
    </>
  );
}

function ResultPanel({ result, onRetry, busy }: { result: CertificateResult; onRetry?: () => void; busy?: boolean }) {
  return (
    <section className={`card ${result.certificate ? 'card-ok' : 'card-warn'}`}>
      {result.certificate ? (
        <>
          <h2>🔒 HTTPS is active</h2>
          <p className="muted">
            Certificate for {result.certificate.domains.join(', ')}, valid until {shortDate(result.certificate.notAfter)}. It will renew automatically.
          </p>
        </>
      ) : (
        <>
          <h2>No certificate yet</h2>
          <p>{result.certificateError}</p>
          <p className="muted small">The site works over plain HTTP in the meantime. Fix the issue below, then try again.</p>
        </>
      )}
      {result.checks && <CheckList checks={result.checks} />}
      {!result.certificate && onRetry && (
        <button className="btn btn-primary" onClick={onRetry} disabled={busy}>
          {busy ? 'Checking…' : 'Try again'}
        </button>
      )}
    </section>
  );
}

export function NewSitePage({ navigate }: { navigate: (p: string) => void }) {
  const { data } = useSites();
  const [form, setForm] = useState<SiteFormValue>(initialSiteForm);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  useEffect(() => {
    if (data?.certEmail) setEmail(data.certEmail);
  }, [data?.certEmail]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      if (form.https && email.trim() && email.trim() !== data?.certEmail) await api.setCertEmail(email.trim());
      const spec = toSiteSpec(form);
      const r = await api.createSite(spec, spec.https);
      setWarnings(r.warnings);
      sessionStorage.setItem(
        `openvps-site-result-${spec.name}`,
        JSON.stringify({ checks: r.checks ?? null, certificate: r.certificate ?? null, certificateError: r.certificateError ?? null, warnings: r.warnings }),
      );
      navigate(`/sites/${spec.name}`);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const domains = parseDomains(form.domains);
  return (
    <>
      <Back to="/sites" label="Sites & domains" navigate={navigate} />
      <div className="page-head">
        <div>
          <h1>New site</h1>
          <p className="muted">Point a domain at an app, a static or single-page app build, or the panel itself.</p>
        </div>
      </div>
      {data && <NginxBanner data={data} />}
      <form onSubmit={submit} className="grid-2 grid-form">
        <section className="card">
          <SiteForm value={form} onChange={setForm} overview={data} error={err} />
        </section>
        <div className="col">
          <section className="card">
            <h2>Before you create it</h2>
            <DnsHint domains={domains} />
            {form.https && (
              <div className="field">
                <label htmlFor="le-email">Email for Let's Encrypt (optional)</label>
                <input id="le-email" type="email" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
                <div className="field-hint">Let's Encrypt warns you here if renewal ever fails. Used for all certificates.</div>
              </div>
            )}
            {warnings.map((w) => (
              <div key={w} className="alert alert-warn">
                {w}
              </div>
            ))}
            {err && !['name', 'domains', 'type', 'upstreamPort', 'root', 'maxBodyMb'].includes(err.field ?? '') && (
              <div className="alert alert-error">
                <pre className="pre-plain">{err.message}</pre>
              </div>
            )}
            <div className="btn-row">
              <button className="btn btn-primary" disabled={busy || !domains.length || !form.name}>
                {busy ? (form.https ? 'Creating and requesting certificate…' : 'Creating…') : form.https ? 'Create site and enable HTTPS' : 'Create site'}
              </button>
              <button type="button" className="btn" onClick={() => navigate('/sites')}>
                Cancel
              </button>
            </div>
            {busy && form.https && <p className="muted small section-gap-sm">This can take up to a minute while Let's Encrypt checks your domain.</p>}
          </section>
        </div>
      </form>
    </>
  );
}

export function SiteDetailPage({ name, navigate }: { name: string; navigate: (p: string) => void }) {
  const { data, error, reload } = useSites();
  const site: SiteRecord | undefined = data?.sites.find((s) => s.name === name);
  const [result, setResult] = useState<CertificateResult | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [checks, setChecks] = useState<CheckResult[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [tab, setTab] = useState<'overview' | 'settings' | 'config'>('overview');
  const [config, setConfig] = useState<string | null>(null);
  const [form, setForm] = useState<SiteFormValue | null>(null);
  const [confirm, setConfirm] = useState('');
  const [deleteCert, setDeleteCert] = useState(true);

  // Result of the creation step, handed over from the New site page.
  useEffect(() => {
    const k = `openvps-site-result-${name}`;
    const raw = sessionStorage.getItem(k);
    if (raw) {
      sessionStorage.removeItem(k);
      const r = JSON.parse(raw) as CertificateResult & { warnings: string[] };
      if (r.certificate || r.certificateError) setResult(r);
      setWarnings(r.warnings ?? []);
      if (!r.certificate && !r.certificateError) setMsg('Site created.');
    }
  }, [name]);
  useEffect(() => {
    if (site && !form) setForm(initialSiteForm(site.spec));
  }, [site, form]);
  useEffect(() => {
    if (tab === 'config') api.siteConfig(name).then((c) => setConfig(c.current ?? c.content)).catch((e: ApiError) => setConfig(`# ${e.message}`));
  }, [tab, name]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    setErr(null);
    setMsg(null);
    try {
      await fn();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  };
  const issue = () =>
    run('issue', async () => {
      const r = await api.issueCertificate(name);
      setResult(r);
      await reload();
    });
  const check = () =>
    run('check', async () => {
      setChecks((await api.checkSite(name)).checks);
    });
  const save = () =>
    run('save', async () => {
      const r = await api.updateSite(name, toSiteSpec(form!));
      setWarnings(r.warnings);
      setMsg(`Saved. ${r.reload}`);
      await reload();
    });
  const remove = () =>
    run('delete', async () => {
      await api.deleteSite(name, deleteCert);
      navigate('/sites');
    });

  if (data && !site) {
    return (
      <>
        <Back to="/sites" label="Sites & domains" navigate={navigate} />
        <div className="card empty">
          <h1>Not found</h1>
          <p className="muted">There is no OpenVPS site named {name}.</p>
        </div>
      </>
    );
  }
  if (!site) return <div className="loading">{error ?? 'Loading…'}</div>;
  const st = site.state;
  const cert = st?.certificate ?? null;

  return (
    <>
      <Back to="/sites" label="Sites & domains" navigate={navigate} />
      <div className="page-head">
        <div>
          <h1 className="title-row">
            {site.name} <span className="owner owner-apps">{TYPE_LABEL[site.spec.type]}</span>
          </h1>
          <p>
            <DomainLinks domains={site.spec.domains} https={!!st?.httpsActive} />
          </p>
        </div>
        <HttpsBadge site={site} />
      </div>
      {msg && <div className="alert alert-ok">{msg}</div>}
      {err && (
        <div className="alert alert-error">
          <pre className="pre-plain">{err.message}</pre>
        </div>
      )}
      {warnings.map((w) => (
        <div key={w} className="alert alert-warn">
          {w}
        </div>
      ))}
      {result && <ResultPanel result={result} onRetry={issue} busy={busy === 'issue'} />}

      <div className="tabs tabs-page section-gap-sm" role="tablist">
        {(['overview', 'settings', 'config'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
            {t === 'overview' ? 'Overview' : t === 'settings' ? 'Settings' : 'Nginx config'}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="grid-2">
          <section className="card">
            <h2>Site</h2>
            <dl className="kv">
              <dt>Serves</dt>
              <dd>
                {TYPE_LABEL[site.spec.type]} <span className="mono muted small">{target(site.spec)}</span>
              </dd>
              <dt>Status</dt>
              <dd>{st?.enabled ? <span className="text-ok">Enabled in Nginx</span> : <span className="text-warn">Not enabled</span>}</dd>
              <dt>Config file</dt>
              <dd className="mono small">{st?.file ?? '—'}</dd>
              <dt>Upload limit</dt>
              <dd>{site.spec.maxBodyMb} MB</dd>
            </dl>
          </section>
          <section className="card">
            <h2>HTTPS</h2>
            {cert ? (
              <dl className="kv">
                <dt>Certificate</dt>
                <dd>
                  <CertBadge cert={cert} />
                </dd>
                <dt>Covers</dt>
                <dd>{cert.domains.join(', ')}</dd>
                <dt>Expires</dt>
                <dd>{shortDate(cert.notAfter)}</dd>
                <dt>Issuer</dt>
                <dd>{cert.issuer}</dd>
                <dt>Renewal</dt>
                <dd>{cert.renewable ? 'Automatic (certbot)' : <span className="text-warn">Not configured</span>}</dd>
              </dl>
            ) : (
              <p className="muted">{site.spec.https ? 'No certificate yet. The site is served over plain HTTP until one is issued.' : 'HTTPS is turned off for this site.'}</p>
            )}
            {cert && cert.domains.join(',') !== site.spec.domains.join(',') && (
              <div className="alert alert-warn small">The certificate doesn't cover the site's current domains. Request a new one.</div>
            )}
            <div className="btn-row section-gap-sm">
              <button className="btn btn-primary" onClick={issue} disabled={busy !== null}>
                {busy === 'issue' ? 'Requesting… (up to a minute)' : cert ? 'Renew / reissue now' : 'Get certificate'}
              </button>
              <button className="btn" onClick={check} disabled={busy !== null}>
                {busy === 'check' ? 'Checking…' : 'Check DNS and port 80'}
              </button>
            </div>
            {checks && <CheckList checks={checks} />}
            {!cert && <DnsHint domains={site.spec.domains} />}
          </section>
        </div>
      )}

      {tab === 'settings' && form && (
        <div className="grid-2 grid-form">
          <section className="card">
            <SiteForm value={form} onChange={setForm} overview={data} editing error={err} />
            <button className="btn btn-primary" onClick={save} disabled={busy !== null}>
              {busy === 'save' ? 'Saving…' : 'Save'}
            </button>
          </section>
          <section className="card card-danger">
            <h2>Delete site</h2>
            <p className="muted small">Removes the Nginx configuration. Your files and apps are not touched.</p>
            <label className="check check-block">
              <input type="checkbox" checked={deleteCert} onChange={(e) => setDeleteCert(e.target.checked)} /> Also delete its certificate
            </label>
            <div className="field">
              <label htmlFor="confirm-site">
                Type <strong>{site.name}</strong> to confirm
              </label>
              <input id="confirm-site" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} />
            </div>
            <button className="btn btn-danger" disabled={busy !== null || confirm !== site.name} onClick={remove}>
              Delete {site.name}
            </button>
          </section>
        </div>
      )}

      {tab === 'config' && (
        <section className="card">
          <p className="muted small">Generated by OpenVPS from the settings. It is checked with <code>nginx -t</code> before every change.</p>
          <pre className="logbox codebox">{config ?? 'Loading…'}</pre>
        </section>
      )}
    </>
  );
}

export function CertificatesPage({ navigate }: { navigate: (p: string) => void }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof api.certificates>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState('');
  const [saved, setSaved] = useState<string | null>(null);
  useEffect(() => {
    api.certificates().then(setData).catch((e: ApiError) => setError(e.message));
    api.certEmail().then((r) => setEmail(r.email ?? '')).catch(() => undefined);
  }, []);

  const saveEmail = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.setCertEmail(email.trim());
      setSaved('Saved.');
    } catch (err) {
      setSaved((err as ApiError).message);
    }
  };

  const siteName = (file: string) => /openvps-([a-z0-9-]+)\.conf$/.exec(file)?.[1];
  return (
    <>
      <div className="page-head">
        <div>
          <h1>SSL certificates</h1>
          <p className="muted">Every certificate on this server: issued for OpenVPS sites, by Certbot, or used by Nginx.</p>
        </div>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      {data && !data.available && <div className="alert alert-warn">The OpenVPS agent is not running. On the server, run <code>sudo openvps provision</code>.</div>}
      {data?.certbot && (
        <div className={`alert ${data.certbot.renewalTimer ? 'alert-ok' : 'alert-warn'}`}>
          {data.certbot.renewalTimer ? (
            <>Automatic renewal is active ({data.certbot.renewalTimer}). Certbot renews certificates 30 days before they expire and reloads Nginx.</>
          ) : data.certbot.installed ? (
            <>Certbot is installed, but no renewal timer is active. Check with <code>systemctl list-timers | grep certbot</code>.</>
          ) : (
            <>Certbot is not installed: <code>sudo apt install certbot</code></>
          )}
        </div>
      )}
      <section className="card table-card section-gap">
        {data && data.certificates.length === 0 && <div className="empty-inline muted">No certificates yet.</div>}
        {data && data.certificates.length > 0 && (
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  <th>Domains</th>
                  <th>Expires</th>
                  <th className="hide-sm">Renewal</th>
                  <th className="hide-sm">Used by</th>
                </tr>
              </thead>
              <tbody>
                {data.certificates
                  .slice()
                  .sort((a, b) => a.notAfter - b.notAfter)
                  .map((c) => (
                    <tr key={c.path}>
                      <td>
                        {c.domains.join(', ')}
                        <div className="muted small">
                          {c.managed ? <span className="owner owner-apps">OpenVPS</span> : c.name ? `certbot: ${c.name}` : c.path} · {c.issuer}
                        </div>
                      </td>
                      <td className="nowrap">
                        <CertBadge cert={c} />
                        <div className="muted small">{shortDate(c.notAfter)}</div>
                      </td>
                      <td className="hide-sm">{c.renewable ? 'Automatic' : <span className="text-warn">Manual</span>}</td>
                      <td className="hide-sm small">
                        {c.usedBy.length === 0 && <span className="muted">Not used by Nginx</span>}
                        {c.usedBy.map((f) => {
                          const s = siteName(f);
                          return (
                            <div key={f}>
                              {s ? (
                                <a
                                  href={`/sites/${s}`}
                                  onClick={(e) => {
                                    e.preventDefault();
                                    navigate(`/sites/${s}`);
                                  }}
                                >
                                  {s}
                                </a>
                              ) : (
                                <span className="mono muted">{f}</span>
                              )}
                            </div>
                          );
                        })}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card narrow-card">
        <h2>Let's Encrypt account email</h2>
        <form onSubmit={saveEmail} className="inline-form">
          <input type="email" value={email} placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} aria-label="Email" />
          <button className="btn">Save</button>
        </form>
        <p className="muted small">Used for new certificates. Let's Encrypt emails you if a renewal fails.</p>
        {saved && <p className="small">{saved}</p>}
      </section>
    </>
  );
}
