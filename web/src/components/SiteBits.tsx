import type { CertInfo, CheckResult, SiteRecord, SiteSpec } from '../api';
import { shortDate } from '../format';

export const TYPE_LABEL: Record<SiteSpec['type'], string> = {
  proxy: 'App',
  static: 'Static website',
  spa: 'Single-page app',
  panel: 'OpenVPS panel',
};

export function target(spec: SiteSpec): string {
  switch (spec.type) {
    case 'proxy':
      return `→ port ${spec.upstreamPort}`;
    case 'static':
    case 'spa':
      return spec.root ?? '';
    case 'panel':
      return '→ this panel';
  }
}

export function certLevel(c: CertInfo | null): 'ok' | 'warn' | 'crit' | 'none' {
  if (!c) return 'none';
  if (c.daysLeft < 7) return 'crit';
  if (c.daysLeft < 21) return 'warn';
  return 'ok';
}

export function CertBadge({ cert, httpsWanted = true }: { cert: CertInfo | null; httpsWanted?: boolean }) {
  if (!cert) {
    return <span className={`pill ${httpsWanted ? 'pill-warn' : 'pill-muted'}`}>{httpsWanted ? 'No certificate' : 'HTTP only'}</span>;
  }
  const level = certLevel(cert);
  const label = cert.daysLeft < 0 ? 'Expired' : `${cert.daysLeft} days left`;
  return (
    <span className={`pill pill-cert-${level}`} title={`Expires ${shortDate(cert.notAfter)} · ${cert.issuer}`}>
      🔒 {label}
    </span>
  );
}

export function HttpsBadge({ site }: { site: SiteRecord }) {
  const s = site.state;
  if (!site.spec.https) return <span className="pill pill-muted">HTTP only</span>;
  if (s?.httpsActive && s.certificate) return <CertBadge cert={s.certificate} />;
  return <span className="pill pill-warn">HTTPS pending</span>;
}

export function DomainLinks({ domains, https }: { domains: string[]; https: boolean }) {
  return (
    <span className="domain-links">
      {domains.map((d, i) => (
        <span key={d}>
          {i > 0 && <span className="muted"> · </span>}
          <a href={`${https ? 'https' : 'http'}://${d}`} target="_blank" rel="noreferrer noopener" onClick={(e) => e.stopPropagation()}>
            {d}
          </a>
        </span>
      ))}
    </span>
  );
}

export function CheckList({ checks }: { checks: CheckResult[] }) {
  return (
    <ul className="checks">
      {checks.map((c) => (
        <li key={c.domain} className={c.httpOk ? 'check-ok' : c.dnsOk ? 'check-warn' : 'check-fail'}>
          <span className="check-icon" aria-hidden="true">{c.httpOk ? '✓' : '✕'}</span>
          <div>
            <strong>{c.domain}</strong>
            <div className="small">{c.message}</div>
          </div>
        </li>
      ))}
    </ul>
  );
}

/** The server's address as the user reached the panel, if it's an IP (helps with DNS instructions). */
export function serverAddressHint(): string | null {
  const h = window.location.hostname;
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.includes(':') ? h : null;
}

export function DnsHint({ domains }: { domains: string[] }) {
  const ip = serverAddressHint();
  if (domains.length === 0) return null;
  return (
    <div className="callout small">
      <strong>DNS:</strong> at your domain provider, add an <code>A</code> record for{' '}
      {domains.map((d, i) => (
        <span key={d}>
          {i > 0 && (i === domains.length - 1 ? ' and ' : ', ')}
          <code>{d}</code>
        </span>
      ))}{' '}
      pointing to {ip ? <code>{ip}</code> : "this server's public IP address"}. It can take a few minutes to take effect.
    </div>
  );
}
