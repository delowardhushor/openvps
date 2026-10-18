import { useEffect, useState } from 'react';
import type { SiteSpec, SiteType, SitesOverview } from '../api';

export interface SiteFormValue {
  name: string;
  nameTouched: boolean;
  domains: string;
  type: SiteType;
  port: string;
  root: string;
  rootTouched: boolean;
  https: boolean;
  forceHttps: boolean;
  hsts: boolean;
  maxBodyMb: string;
}

export function initialSiteForm(spec?: SiteSpec): SiteFormValue {
  if (spec) {
    return {
      name: spec.name,
      nameTouched: true,
      domains: spec.domains.join('\n'),
      type: spec.type,
      port: spec.upstreamPort ? String(spec.upstreamPort) : '',
      root: spec.root ?? '',
      rootTouched: true,
      https: spec.https,
      forceHttps: spec.forceHttps,
      hsts: spec.hsts,
      maxBodyMb: String(spec.maxBodyMb),
    };
  }
  return {
    name: '',
    nameTouched: false,
    domains: '',
    type: 'proxy',
    port: '',
    root: '',
    rootTouched: false,
    https: true,
    forceHttps: true,
    hsts: false,
    maxBodyMb: '25',
  };
}

export function parseDomains(text: string): string[] {
  return [
    ...new Set(
      text
        .split(/[\s,]+/)
        .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, ''))
        .filter(Boolean),
    ),
  ];
}

/** "shop.example.com" -> "shop-example-com" (fits the site name rules). */
export function nameFromDomain(d: string): string {
  const s = d.replace(/^www\./, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return /^[a-z]/.test(s) ? s : `site-${s}`.slice(0, 40);
}

export function toSiteSpec(v: SiteFormValue): SiteSpec {
  return {
    name: v.name.trim(),
    domains: parseDomains(v.domains),
    type: v.type,
    upstreamPort: v.type === 'proxy' ? Number(v.port) : null,
    root: v.type === 'static' || v.type === 'spa' ? v.root.trim() : null,
    https: v.https,
    forceHttps: v.forceHttps,
    hsts: v.hsts,
    maxBodyMb: Number(v.maxBodyMb) || 25,
  };
}

const TYPES: { type: SiteType; title: string; text: string }[] = [
  { type: 'proxy', title: 'App', text: 'Forward to a Node.js app (or anything listening on a port).' },
  { type: 'spa', title: 'Single-page app', text: 'A React, Vue or Angular build. Unknown paths load index.html.' },
  { type: 'static', title: 'Static website', text: 'Plain HTML, CSS and JS files served as they are.' },
  { type: 'panel', title: 'OpenVPS panel', text: 'Reach this panel on a domain with a real certificate.' },
];

function Err({ field, err }: { field: string; err: { field?: string; message: string } | null }) {
  return err && err.field === field ? <div className="field-error">{err.message}</div> : null;
}

export function SiteForm({
  value,
  onChange,
  overview,
  editing = false,
  error,
}: {
  value: SiteFormValue;
  onChange: (v: SiteFormValue) => void;
  overview: SitesOverview | null;
  editing?: boolean;
  error: { field?: string; message: string } | null;
}) {
  const set = (p: Partial<SiteFormValue>) => onChange({ ...value, ...p });
  const domains = parseDomains(value.domains);
  const primary = domains[0] ?? '';
  const hasPanelSite = !!overview?.sites.some((s) => s.spec.type === 'panel' && s.name !== value.name);
  const [advanced, setAdvanced] = useState(value.hsts || value.maxBodyMb !== '25' || !value.forceHttps);

  // Suggest a name and folder from the first domain until the user edits them.
  useEffect(() => {
    if (editing) return;
    const patch: Partial<SiteFormValue> = {};
    if (!value.nameTouched) patch.name = primary ? nameFromDomain(primary) : '';
    const n = patch.name ?? value.name;
    if (!value.rootTouched && (value.type === 'spa' || value.type === 'static')) patch.root = n ? `/srv/apps/${n}/dist` : '';
    if (Object.keys(patch).length) onChange({ ...value, ...patch });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primary, value.type]);

  const knownTargets = overview?.targets.filter((t) => t.port) ?? [];
  const www = primary && !primary.startsWith('www.') && primary.split('.').length === 2 ? `www.${primary}` : null;

  return (
    <div className="form-grid">
      <fieldset className="field">
        <legend>What does this site serve?</legend>
        <div className="type-cards" role="radiogroup">
          {TYPES.map((t) => {
            const disabled = t.type === 'panel' && hasPanelSite;
            return (
              <label key={t.type} className={`type-card ${value.type === t.type ? 'type-on' : ''} ${disabled ? 'type-disabled' : ''}`}>
                <input type="radio" name="siteType" checked={value.type === t.type} disabled={disabled} onChange={() => set({ type: t.type })} />
                <span className="type-title">{t.title}</span>
                <span className="type-text">{disabled ? 'The panel already has a domain.' : t.text}</span>
              </label>
            );
          })}
        </div>
        <Err field="type" err={error} />
      </fieldset>

      <div className={`field ${error?.field === 'domains' ? 'has-error' : ''}`}>
        <label htmlFor="site-domains">Domains</label>
        <textarea
          id="site-domains"
          className="mono"
          rows={2}
          placeholder={value.type === 'panel' ? 'panel.example.com' : 'shop.example.com'}
          value={value.domains}
          spellCheck={false}
          onChange={(e) => set({ domains: e.target.value })}
        />
        <div className="field-hint">
          One per line. The first is the main domain.
          {www && !domains.includes(www) && (
            <>
              {' '}
              <button type="button" className="link-btn inline" onClick={() => set({ domains: `${value.domains.trim()}\n${www}` })}>
                Also add {www}
              </button>
            </>
          )}
        </div>
        <Err field="domains" err={error} />
      </div>

      {value.type === 'proxy' && (
        <div className={`field ${error?.field === 'upstreamPort' ? 'has-error' : ''}`}>
          <label htmlFor="site-port">App port</label>
          <div className="port-row">
            <span className="mono muted">http://127.0.0.1:</span>
            <input id="site-port" type="number" min={1} max={65535} placeholder="3000" value={value.port} onChange={(e) => set({ port: e.target.value })} />
          </div>
          {knownTargets.length > 0 && (
            <div className="chips">
              {knownTargets.map((t) => (
                <button key={t.name} type="button" className={`chip ${value.port === String(t.port) ? 'chip-on' : ''}`} onClick={() => set({ port: String(t.port) })}>
                  {t.name} · {t.port}
                </button>
              ))}
            </div>
          )}
          <div className="field-hint">The port your app listens on (its <code>PORT</code>). Keep that port closed in your firewall; Nginx forwards to it locally.</div>
          <Err field="upstreamPort" err={error} />
        </div>
      )}

      {(value.type === 'static' || value.type === 'spa') && (
        <div className={`field ${error?.field === 'root' ? 'has-error' : ''}`}>
          <label htmlFor="site-root">Folder with the built files</label>
          <input id="site-root" className="mono" value={value.root} spellCheck={false} onChange={(e) => set({ root: e.target.value, rootTouched: true })} />
          <div className="field-hint">
            The folder containing <code>index.html</code> (for React/Vite usually <code>dist</code>, for Create React App <code>build</code>), inside <code>/srv/apps</code> or{' '}
            <code>/var/www</code>. Copy it there with e.g. <code>rsync -a dist/ root@server:{value.root || '/srv/apps/name/dist'}/</code>.
          </div>
          <Err field="root" err={error} />
        </div>
      )}

      {value.type === 'panel' && overview && (
        <div className="callout small">
          Nginx will forward this domain to the panel on port {overview.panel.port}. After it works with HTTPS, you can close port {overview.panel.port} in your firewall.
        </div>
      )}

      <div className={`field ${error?.field === 'name' ? 'has-error' : ''}`}>
        <label htmlFor="site-name">Site name</label>
        <input id="site-name" className="mono" value={value.name} disabled={editing} spellCheck={false} onChange={(e) => set({ name: e.target.value.toLowerCase(), nameTouched: true })} />
        <div className="field-hint">Used for file and certificate names. Lowercase letters, digits and dashes.</div>
        <Err field="name" err={error} />
      </div>

      <label className="check check-block">
        <input type="checkbox" checked={value.https} onChange={(e) => set({ https: e.target.checked })} />
        <span>
          <strong>HTTPS with a free Let's Encrypt certificate</strong>
          <span className="muted small block">Renewed automatically before it expires.</span>
        </span>
      </label>

      <button type="button" className="link-btn" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
        {advanced ? '▾' : '▸'} Advanced options
      </button>
      {advanced && (
        <>
          <label className="check check-block">
            <input type="checkbox" checked={value.forceHttps} disabled={!value.https} onChange={(e) => set({ forceHttps: e.target.checked })} />
            <span>Redirect HTTP to HTTPS</span>
          </label>
          <label className="check check-block">
            <input type="checkbox" checked={value.hsts} disabled={!value.https} onChange={(e) => set({ hsts: e.target.checked })} />
            <span>
              HSTS <span className="muted small">(browsers refuse plain HTTP for a year; only enable once HTTPS works)</span>
            </span>
          </label>
          <div className={`field ${error?.field === 'maxBodyMb' ? 'has-error' : ''}`}>
            <label htmlFor="site-body">Upload limit (MB)</label>
            <input id="site-body" type="number" min={1} max={2048} value={value.maxBodyMb} onChange={(e) => set({ maxBodyMb: e.target.value })} />
            <Err field="maxBodyMb" err={error} />
          </div>
        </>
      )}
    </div>
  );
}
