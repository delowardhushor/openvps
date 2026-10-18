/**
 * Site (domain) definitions shared by the panel and the agent. Every value that ends
 * up in an Nginx config is validated here against a strict pattern, so the rendered
 * file can never contain injected directives.
 */
import { SpecError } from './spec.ts';

export type SiteType = 'proxy' | 'static' | 'spa' | 'panel';
export const SITE_TYPES: readonly SiteType[] = ['proxy', 'static', 'spa', 'panel'];

export interface SiteSpec {
  /** Identifier; also the Nginx file name (openvps-<name>.conf) and certificate name. */
  name: string;
  /** First entry is the primary domain. */
  domains: string[];
  type: SiteType;
  /** proxy: local port of the app (127.0.0.1). */
  upstreamPort: number | null;
  /** static / spa: directory served. */
  root: string | null;
  /** Serve HTTPS once a certificate exists. */
  https: boolean;
  /** With HTTPS: redirect plain HTTP to HTTPS. */
  forceHttps: boolean;
  /** With HTTPS: send Strict-Transport-Security. */
  hsts: boolean;
  /** Request body limit in MB (uploads). */
  maxBodyMb: number;
}

export const SITE_NAME = /^[a-z][a-z0-9-]{1,39}$/;
/** Lowercase DNS name with at least one dot; punycode (xn--) allowed; no wildcards or IPs. */
export const DOMAIN = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,61}[a-z0-9]$/;
/** Absolute path made of safe characters only (nothing Nginx treats specially). */
export const SAFE_PATH = /^\/[A-Za-z0-9._\-/]{0,255}$/;
export const EMAIL = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9.-]{1,253}\.[A-Za-z]{2,63}$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

export function normalizeDomain(d: string): string {
  return d.trim().toLowerCase().replace(/\.$/, '');
}

export function parseSiteSpec(input: unknown): SiteSpec {
  if (!isObj(input)) throw new SpecError('spec', 'Expected an object.');
  const s = input;

  const name = s.name;
  if (typeof name !== 'string' || !SITE_NAME.test(name)) {
    throw new SpecError('name', 'Name must be 2–40 characters: lowercase letters, digits and dashes, starting with a letter.');
  }

  if (!Array.isArray(s.domains) || s.domains.length === 0) throw new SpecError('domains', 'Add at least one domain.');
  if (s.domains.length > 10) throw new SpecError('domains', 'At most 10 domains per site.');
  const domains: string[] = [];
  for (const raw of s.domains) {
    if (typeof raw !== 'string') throw new SpecError('domains', 'Domains must be text.');
    const d = normalizeDomain(raw);
    if (d.startsWith('*.')) throw new SpecError('domains', `Wildcard domains are not supported (${d}).`);
    if (!DOMAIN.test(d)) throw new SpecError('domains', `"${raw.slice(0, 80)}" is not a valid domain name (for example app.example.com).`);
    if (!domains.includes(d)) domains.push(d);
  }

  const type = s.type;
  if (typeof type !== 'string' || !(SITE_TYPES as readonly string[]).includes(type)) {
    throw new SpecError('type', 'Choose what the site serves: an app, static files, a single-page app, or the OpenVPS panel.');
  }

  let upstreamPort: number | null = null;
  let root: string | null = null;
  if (type === 'proxy') {
    const p = s.upstreamPort;
    if (typeof p !== 'number' || !Number.isInteger(p) || p < 1 || p > 65535) {
      throw new SpecError('upstreamPort', 'Enter the port your app listens on (1–65535).');
    }
    upstreamPort = p;
  } else if (type === 'static' || type === 'spa') {
    const r = s.root;
    if (typeof r !== 'string' || !SAFE_PATH.test(r) || r.split('/').includes('..')) {
      throw new SpecError('root', 'Folder must be an absolute path using letters, digits, ".", "_", "-" and "/".');
    }
    root = r.replace(/\/+$/, '') || '/';
  }

  const bool = (k: string, def: boolean): boolean => {
    const v = s[k];
    if (v === undefined) return def;
    if (typeof v !== 'boolean') throw new SpecError(k, `"${k}" must be true or false.`);
    return v;
  };
  const https = bool('https', true);
  const forceHttps = bool('forceHttps', true);
  const hsts = bool('hsts', false);

  const mb = s.maxBodyMb ?? 25;
  if (typeof mb !== 'number' || !Number.isInteger(mb) || mb < 1 || mb > 2048) {
    throw new SpecError('maxBodyMb', 'Upload limit must be between 1 and 2048 MB.');
  }

  return { name, domains, type: type as SiteType, upstreamPort, root, https, forceHttps, hsts, maxBodyMb: mb };
}

export function parseEmail(v: unknown): string | null {
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !EMAIL.test(v.trim())) throw new SpecError('email', 'Enter a valid email address.');
  return v.trim();
}

export function certName(siteName: string): string {
  return `openvps-${siteName}`;
}

// ---- Shapes returned by the agent -------------------------------------------

export interface ExistingServer {
  file: string;
  serverNames: string[];
  listens: string[];
  ssl: boolean;
  certificate: string | null;
  proxyPass: string[];
  root: string | null;
}

export interface CertInfo {
  /** certbot lineage name, or null for a certificate only referenced by Nginx. */
  name: string | null;
  path: string;
  domains: string[];
  issuer: string;
  notBefore: number;
  notAfter: number;
  daysLeft: number;
  managed: boolean;
  /** certbot renewal configuration present (auto-renewing). */
  renewable: boolean;
  /** Nginx config files that use this certificate. */
  usedBy: string[];
}

export interface NginxStatus {
  installed: boolean;
  version: string | null;
  running: boolean;
  configOk: boolean;
  configError: string | null;
  /** Where OpenVPS writes site files: Debian-style sites-available/enabled or conf.d. */
  layout: 'sites' | 'confd' | null;
  ipv6: boolean;
  certbot: { installed: boolean; version: string | null; renewalTimer: string | null };
  existing: ExistingServer[];
}

export interface SiteState {
  name: string;
  file: string;
  enabled: boolean;
  certificate: CertInfo | null;
  /** HTTPS actually being served (cert exists and spec.https). */
  httpsActive: boolean;
}

export interface CheckResult {
  domain: string;
  addresses: string[];
  dnsOk: boolean;
  httpOk: boolean;
  message: string;
}
