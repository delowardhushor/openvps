import { X509Certificate, randomBytes } from 'node:crypto';
import { promises as dnsp } from 'node:dns';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
  chmodSync,
} from 'node:fs';
import { request } from 'node:http';
import { basename, dirname, join, sep } from 'node:path';
import { AgentError } from './pm2.ts';
import { runTool, tail } from './exec.ts';
import { detectLayout, extractServers, serverNameMatches } from './nginx-parse.ts';
import { renderSite, SHARED_FILE_CONTENT, type RenderEnv } from './nginx-render.ts';
import { certName, type CertInfo, type CheckResult, type ExistingServer, type NginxStatus, type SiteSpec, type SiteState } from './sites-spec.ts';

export interface SitesOptions {
  nginxBin: string;
  nginxConf: string;
  sitesAvailable: string;
  sitesEnabled: string;
  confD: string;
  letsencryptDir: string;
  certbotBin: string | null;
  acmeRoot: string;
  /** Directories static sites may be served from. */
  staticRoots: string[];
  panel: { port: number; tls: boolean };
  version: string;
  /** ACME directory URL (null = Let's Encrypt production, certbot's default). */
  acmeServer: string | null;
  /** Extra environment for certbot (tests: REQUESTS_CA_BUNDLE). */
  certbotEnv: Record<string, string>;
  /** DNS servers for pre-flight checks (null = system resolver). */
  dnsServers: string[] | null;
  /** Port the HTTP pre-flight check connects to (80 in production). */
  checkPort: number;
  ipv6: boolean | null;
  reload: () => Promise<{ ok: boolean; message: string }>;
  isRunning: () => Promise<boolean>;
  renewalTimer: () => Promise<string | null>;
}

const SITE_PREFIX = 'openvps-';
const SHARED_NAME = 'openvps-00-shared.conf';

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function readSafe(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function writeAtomic(path: string, content: string): void {
  const tmp = `${path}.openvps-tmp`;
  writeFileSync(tmp, content, { mode: 0o644 });
  chmodSync(tmp, 0o644);
  renameSync(tmp, path);
}

function parseCertFile(path: string): Omit<CertInfo, 'name' | 'managed' | 'renewable' | 'usedBy' | 'path'> | null {
  const pem = readSafe(path);
  if (!pem) return null;
  const first = /-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/.exec(pem)?.[0];
  if (!first) return null;
  try {
    const x = new X509Certificate(first);
    const domains = (x.subjectAltName ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.startsWith('DNS:'))
      .map((s) => s.slice(4));
    const cn = /CN=([^\n,]+)/.exec(x.subject)?.[1];
    if (domains.length === 0 && cn) domains.push(cn);
    const notAfter = Date.parse(x.validTo);
    const issuer = /O=([^\n]+)/.exec(x.issuer)?.[1] ?? /CN=([^\n]+)/.exec(x.issuer)?.[1] ?? x.issuer;
    return {
      domains,
      issuer: issuer.trim(),
      notBefore: Date.parse(x.validFrom),
      notAfter,
      daysLeft: Math.floor((notAfter - Date.now()) / 86_400_000),
    };
  } catch {
    return null;
  }
}

export class SitesManager {
  readonly o: SitesOptions;
  constructor(o: SitesOptions) {
    this.o = o;
  }

  // ---- inspection ------------------------------------------------------------

  installed(): boolean {
    return existsSync(this.o.nginxBin);
  }

  layout(): 'sites' | 'confd' | null {
    const conf = readSafe(this.o.nginxConf);
    return conf ? detectLayout(conf) : null;
  }

  private siteDir(): string {
    return this.layout() === 'confd' ? this.o.confD : this.o.sitesAvailable;
  }

  siteFile(name: string): string {
    return join(this.siteDir(), `${SITE_PREFIX}${name}.conf`);
  }

  private enabledLink(name: string): string | null {
    return this.layout() === 'sites' ? join(this.o.sitesEnabled, `${SITE_PREFIX}${name}.conf`) : null;
  }

  private ownFile(path: string): boolean {
    return basename(path).startsWith(SITE_PREFIX);
  }

  /** All enabled config files (resolved), for reading existing server blocks. */
  private enabledFiles(): string[] {
    const files = new Set<string>();
    const add = (p: string) => {
      try {
        if (statSync(p).isFile()) files.add(p);
      } catch {
        /* dangling symlink */
      }
    };
    add(this.o.nginxConf);
    for (const dir of [this.o.sitesEnabled, this.o.confD]) {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names.sort()) {
        if (dir === this.o.confD && !n.endsWith('.conf')) continue;
        add(join(dir, n));
      }
    }
    return [...files];
  }

  existingServers(includeOwn = false): ExistingServer[] {
    const out: ExistingServer[] = [];
    for (const f of this.enabledFiles()) {
      if (!includeOwn && this.ownFile(f)) continue;
      const src = readSafe(f);
      if (src) out.push(...extractServers(src, f));
    }
    return out;
  }

  ipv6(): boolean {
    if (this.o.ipv6 !== null) return this.o.ipv6;
    const s = readSafe('/proc/net/if_inet6');
    return !!s && s.trim().length > 0;
  }

  async nginxVersion(): Promise<string | null> {
    if (!this.installed()) return null;
    const r = await runTool(this.o.nginxBin, ['-v'], { timeoutMs: 5000 });
    return /nginx\/([\d.]+)/.exec(r.stderr + r.stdout)?.[1] ?? null;
  }

  async testConfig(): Promise<{ ok: boolean; output: string }> {
    const r = await runTool(this.o.nginxBin, ['-t', '-q', '-c', this.o.nginxConf], { timeoutMs: 20_000 });
    return { ok: r.code === 0, output: tail(r.stderr + r.stdout, 8) };
  }

  async certbotVersion(): Promise<string | null> {
    if (!this.o.certbotBin) return null;
    const r = await runTool(this.o.certbotBin, ['--version'], { timeoutMs: 30_000, env: this.o.certbotEnv });
    return /certbot ([\d.]+\S*)/.exec(r.stdout + r.stderr)?.[1] ?? null;
  }

  async status(): Promise<NginxStatus> {
    if (!this.installed()) {
      return {
        installed: false,
        version: null,
        running: false,
        configOk: false,
        configError: null,
        layout: null,
        ipv6: this.ipv6(),
        certbot: { installed: !!this.o.certbotBin, version: null, renewalTimer: null },
        existing: [],
      };
    }
    const [version, test, running, cbVersion, timer] = await Promise.all([
      this.nginxVersion(),
      this.testConfig(),
      this.o.isRunning(),
      this.certbotVersion(),
      this.o.renewalTimer(),
    ]);
    return {
      installed: true,
      version,
      running,
      configOk: test.ok,
      configError: test.ok ? null : test.output,
      layout: this.layout(),
      ipv6: this.ipv6(),
      certbot: { installed: !!this.o.certbotBin, version: cbVersion, renewalTimer: timer },
      existing: this.existingServers(),
    };
  }

  certPaths(name: string): { fullchain: string; key: string } | null {
    const dir = join(this.o.letsencryptDir, 'live', certName(name));
    const fullchain = join(dir, 'fullchain.pem');
    const key = join(dir, 'privkey.pem');
    return existsSync(fullchain) && existsSync(key) ? { fullchain, key } : null;
  }

  /** All certificates: certbot lineages plus any other certificate files Nginx uses. */
  certificates(): CertInfo[] {
    const servers = this.existingServers(true);
    const usedBy = (path: string, lineage: string | null): string[] => {
      let real = path;
      try {
        real = realpathSync(path);
      } catch {
        /* keep */
      }
      const files = servers
        .filter((s) => {
          if (!s.certificate) return false;
          if (lineage && s.certificate.includes(`/live/${lineage}/`)) return true;
          try {
            return realpathSync(s.certificate) === real;
          } catch {
            return s.certificate === path;
          }
        })
        .map((s) => s.file);
      return [...new Set(files)];
    };
    const out: CertInfo[] = [];
    const seen = new Set<string>();
    const live = join(this.o.letsencryptDir, 'live');
    let lineages: string[] = [];
    try {
      lineages = readdirSync(live).filter((n) => n !== 'README');
    } catch {
      /* no certbot */
    }
    for (const name of lineages.sort()) {
      const path = join(live, name, 'fullchain.pem');
      const info = parseCertFile(path);
      if (!info) continue;
      seen.add(path);
      out.push({
        name,
        path,
        ...info,
        managed: name.startsWith(SITE_PREFIX),
        renewable: existsSync(join(this.o.letsencryptDir, 'renewal', `${name}.conf`)),
        usedBy: usedBy(path, name),
      });
    }
    for (const s of servers) {
      if (!s.certificate || s.certificate.includes('$')) continue;
      if ([...seen].some((p) => s.certificate === p || s.certificate!.includes('/live/'))) continue;
      if (seen.has(s.certificate)) continue;
      const info = parseCertFile(s.certificate);
      if (!info) continue;
      seen.add(s.certificate);
      out.push({ name: null, path: s.certificate, ...info, managed: false, renewable: false, usedBy: usedBy(s.certificate, null) });
    }
    return out;
  }

  siteState(name: string, spec: SiteSpec | null): SiteState {
    const file = this.siteFile(name);
    const link = this.enabledLink(name);
    const enabled = existsSync(file) && (link === null || existsSync(link));
    const cert = this.certificates().find((c) => c.name === certName(name)) ?? null;
    return { name, file, enabled, certificate: cert, httpsActive: !!(spec?.https && cert && this.certPaths(name)) };
  }

  readSiteConfig(name: string): string | null {
    return readSafe(this.siteFile(name));
  }

  // ---- validation ------------------------------------------------------------

  conflicts(spec: SiteSpec): string[] {
    const problems: string[] = [];
    for (const s of this.existingServers(true)) {
      if (this.ownFile(s.file) && basename(s.file) === `${SITE_PREFIX}${spec.name}.conf`) continue;
      for (const d of spec.domains) {
        const hit = s.serverNames.find((n) => serverNameMatches(n, d));
        if (hit) {
          const who = this.ownFile(s.file) ? `the OpenVPS site "${basename(s.file).slice(SITE_PREFIX.length, -5)}"` : s.file;
          problems.push(`${d} is already served by ${who}${hit !== d ? ` (server_name ${hit})` : ''}.`);
        }
      }
    }
    return [...new Set(problems)];
  }

  /** Static folder must be inside an allowed root and readable by the Nginx worker. */
  checkStaticRoot(root: string): string[] {
    const warnings: string[] = [];
    let real: string;
    try {
      real = realpathSync(root);
    } catch {
      throw new AgentError('invalid', `Folder ${root} does not exist. Copy your build output there first.`, 'root');
    }
    if (!statSync(real).isDirectory()) throw new AgentError('invalid', `${root} is not a folder.`, 'root');
    const roots = this.o.staticRoots.map((r) => {
      try {
        return realpathSync(r);
      } catch {
        return r;
      }
    });
    if (!roots.some((r) => within(real, r) && real !== r)) {
      throw new AgentError('invalid', `Static files must be inside ${this.o.staticRoots.join(' or ')}.`, 'root');
    }
    // Every directory up to the root must be traversable by "other" (the nginx worker user).
    for (let d = real; d !== '/'; d = dirname(d)) {
      const st = statSync(d);
      if (!(st.mode & 0o001)) {
        warnings.push(`Nginx may not be able to enter ${d} (permissions ${(st.mode & 0o777).toString(8)}). Run: sudo chmod o+x ${d}`);
        break;
      }
    }
    if (!(statSync(real).mode & 0o004)) warnings.push(`Nginx may not be able to list ${real}. Run: sudo chmod -R o+rX ${real}`);
    const index = join(real, 'index.html');
    if (!existsSync(index)) warnings.push(`No index.html in ${root} yet. The site will answer 404 until you copy your build there.`);
    else if (!(statSync(index).mode & 0o004)) warnings.push(`index.html is not readable by Nginx. Run: sudo chmod -R o+rX ${real}`);
    return warnings;
  }

  // ---- changes ---------------------------------------------------------------

  private renderEnv(name: string): RenderEnv {
    return {
      acmeRoot: this.o.acmeRoot,
      ipv6: this.ipv6(),
      http2Directive: false,
      cert: this.certPaths(name),
      panel: this.o.panel,
      version: this.o.version,
    };
  }

  async render(spec: SiteSpec): Promise<string> {
    const env = this.renderEnv(spec.name);
    const v = await this.nginxVersion();
    if (v) {
      const [maj = 0, min = 0, patch = 0] = v.split('.').map(Number);
      env.http2Directive = maj > 1 || (maj === 1 && (min > 25 || (min === 25 && patch >= 1)));
    }
    if (!env.http2Directive) {
      const other443 = this.existingServers().flatMap((s) => s.listens).filter((l) => /(^|[\s:])443(\s|$)/.test(l));
      env.http2 = other443.every((l) => /\bhttp2\b/.test(l));
    }
    return renderSite(spec, env);
  }

  private ensureAcmeRoot(): void {
    const dir = join(this.o.acmeRoot, '.well-known', 'acme-challenge');
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    for (let d = dir; within(d, this.o.acmeRoot); d = dirname(d)) {
      chmodSync(d, 0o755);
      if (d === this.o.acmeRoot) break;
    }
  }

  /**
   * Write the site, validate the complete Nginx configuration, and reload. If
   * validation fails, every file this call touched is restored and the error returned.
   */
  async apply(spec: SiteSpec): Promise<{ state: SiteState; warnings: string[]; reload: string }> {
    if (!this.installed()) throw new AgentError('nginx_missing', 'Nginx is not installed. On the server: sudo apt install nginx');
    const layout = this.layout();
    if (!layout) {
      throw new AgentError('nginx_layout', `${this.o.nginxConf} includes neither sites-enabled nor conf.d, so OpenVPS cannot add sites safely.`);
    }
    const before = await this.testConfig();
    if (!before.ok) {
      throw new AgentError(
        'nginx_broken',
        `Nginx's configuration already has an error, so OpenVPS won't change anything until it is fixed:\n${before.output}`,
      );
    }
    const conflicts = this.conflicts(spec);
    if (conflicts.length) throw new AgentError('conflict', conflicts.join(' '), 'domains');
    const warnings = spec.type === 'static' || spec.type === 'spa' ? this.checkStaticRoot(spec.root!) : [];
    if (spec.type === 'panel' && !this.o.panel) throw new AgentError('invalid', 'Panel port unknown.');

    this.ensureAcmeRoot();
    const content = await this.render(spec);
    const dir = this.siteDir();
    mkdirSync(dir, { recursive: true });
    const file = this.siteFile(spec.name);
    const link = this.enabledLink(spec.name);
    const sharedFile = join(dir, SHARED_NAME);
    const sharedLink = layout === 'sites' ? join(this.o.sitesEnabled, SHARED_NAME) : null;

    // Remember the previous state so a failed test can be undone exactly.
    const prevContent = readSafe(file);
    const prevShared = readSafe(sharedFile);
    const hadLink = link ? existsSync(link) : true;
    const hadSharedLink = sharedLink ? existsSync(sharedLink) : true;

    const undo = () => {
      if (prevContent === null) rmSync(file, { force: true });
      else writeAtomic(file, prevContent);
      if (link && !hadLink) rmSync(link, { force: true });
      if (prevShared === null) rmSync(sharedFile, { force: true });
      if (sharedLink && !hadSharedLink) rmSync(sharedLink, { force: true });
    };

    try {
      if (prevShared !== SHARED_FILE_CONTENT) writeAtomic(sharedFile, SHARED_FILE_CONTENT);
      if (sharedLink && !hadSharedLink) symlinkSync(sharedFile, sharedLink);
      writeAtomic(file, content);
      if (link && !hadLink) {
        if (lstatSync(dirname(link)).isDirectory()) symlinkSync(file, link);
      }
    } catch (e) {
      undo();
      throw new AgentError('io', `Could not write the Nginx configuration: ${(e as Error).message}`);
    }

    const after = await this.testConfig();
    if (!after.ok) {
      undo();
      throw new AgentError('nginx_test_failed', `Nginx rejected the new configuration, so it was not applied:\n${after.output}`);
    }
    const r = await this.o.reload();
    return { state: this.siteState(spec.name, spec), warnings, reload: r.message };
  }

  async remove(name: string, deleteCertificate: boolean): Promise<{ reload: string; certificateDeleted: boolean }> {
    const file = this.siteFile(name);
    const link = this.enabledLink(name);
    const prev = readSafe(file);
    if (link) rmSync(link, { force: true });
    rmSync(file, { force: true });
    const t = await this.testConfig();
    if (!t.ok) {
      // Should not happen (removing a server block), but never leave Nginx broken.
      if (prev !== null) {
        writeAtomic(file, prev);
        if (link) symlinkSync(file, link);
      }
      throw new AgentError('nginx_test_failed', `Removing the site would break Nginx, so it was kept:\n${t.output}`);
    }
    const r = await this.o.reload();
    let certificateDeleted = false;
    if (deleteCertificate && this.o.certbotBin && existsSync(join(this.o.letsencryptDir, 'live', certName(name)))) {
      const d = await runTool(this.o.certbotBin, ['delete', '--non-interactive', '--cert-name', certName(name)], {
        timeoutMs: 60_000,
        env: this.o.certbotEnv,
      });
      certificateDeleted = d.code === 0;
    }
    return { reload: r.message, certificateDeleted };
  }

  // ---- certificates ----------------------------------------------------------

  private async resolve(domain: string): Promise<string[]> {
    const r = new dnsp.Resolver({ timeout: 4000, tries: 2 });
    if (this.o.dnsServers) r.setServers(this.o.dnsServers);
    const v4 = await r.resolve4(domain).catch(() => [] as string[]);
    const v6 = await r.resolve6(domain).catch(() => [] as string[]);
    return [...v4, ...v6];
  }

  private httpGet(address: string, host: string, path: string): Promise<{ status: number; body: string } | null> {
    return new Promise((resolve) => {
      const req = request(
        { host: address, port: this.o.checkPort, path, method: 'GET', headers: { Host: host, 'User-Agent': 'OpenVPS-check' }, timeout: 8000, family: address.includes(':') ? 6 : 4 },
        (res) => {
          let body = '';
          res.setEncoding('utf8');
          res.on('data', (c: string) => {
            if (body.length < 4096) body += c;
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('timeout', () => req.destroy());
      req.on('error', () => resolve(null));
      req.end();
    });
  }

  /**
   * Pre-flight for Let's Encrypt: each domain must resolve and must reach this
   * Nginx on port 80. Failing early avoids Let's Encrypt's failed-validation limits.
   */
  async check(name: string, domains: string[]): Promise<CheckResult[]> {
    if (!existsSync(this.siteFile(name))) throw new AgentError('not_found', 'Create the site before checking it.');
    this.ensureAcmeRoot();
    const token = `openvps-check-${randomBytes(12).toString('hex')}`;
    const tokenFile = join(this.o.acmeRoot, '.well-known', 'acme-challenge', token);
    writeFileSync(tokenFile, token, { mode: 0o644 });
    chmodSync(tokenFile, 0o644);
    try {
      const out: CheckResult[] = [];
      for (const domain of domains) {
        const addresses = await this.resolve(domain);
        if (addresses.length === 0) {
          out.push({ domain, addresses, dnsOk: false, httpOk: false, message: `${domain} has no DNS record yet. Add an A record pointing to this server's IP address.` });
          continue;
        }
        let httpOk = false;
        // `nginx -s reload` returns before new workers take over, so a site created a
        // moment ago may briefly answer with the old config. Retry when something answered.
        for (let attempt = 0; attempt < 4 && !httpOk; attempt++) {
          if (attempt > 0) await new Promise((r) => setTimeout(r, 750));
          let answered = false;
          for (const a of addresses.slice(0, 4)) {
            const res = await this.httpGet(a, domain, `/.well-known/acme-challenge/${token}`);
            if (res) answered = true;
            if (res && res.status === 200 && res.body.trim() === token) {
              httpOk = true;
              break;
            }
          }
          if (!answered) break;
        }
        out.push({
          domain,
          addresses,
          dnsOk: true,
          httpOk,
          message: httpOk
            ? `${domain} points to this server and is reachable on port 80.`
            : `${domain} resolves to ${addresses.join(', ')}, but this server did not answer the check there. Make sure the DNS record points to this server and port 80 is open in your firewall.`,
        });
      }
      return out;
    } finally {
      rmSync(tokenFile, { force: true });
    }
  }

  async issue(spec: SiteSpec, email: string | null): Promise<CertInfo> {
    if (!this.o.certbotBin) {
      throw new AgentError('certbot_missing', 'Certbot is not installed. On the server: sudo apt install certbot');
    }
    if (!existsSync(this.siteFile(spec.name))) throw new AgentError('not_found', 'Create the site before requesting a certificate.');
    this.ensureAcmeRoot();
    const args = [
      'certonly',
      '--non-interactive',
      '--agree-tos',
      '--webroot',
      '-w',
      this.o.acmeRoot,
      '--cert-name',
      certName(spec.name),
      '--deploy-hook',
      'systemctl reload nginx',
      ...(email ? ['--email', email] : ['--register-unsafely-without-email']),
      ...(this.o.acmeServer ? ['--server', this.o.acmeServer] : []),
      ...spec.domains.flatMap((d) => ['-d', d]),
    ];
    const r = await runTool(this.o.certbotBin, args, { timeoutMs: 240_000, env: this.o.certbotEnv });
    if (r.code !== 0) {
      const out = r.stderr + '\n' + r.stdout;
      const detail =
        /Detail: ([^\n]+)/.exec(out)?.[1] ??
        /(too many (?:certificates|failed authorizations)[^\n]*)/i.exec(out)?.[1] ??
        tail(out, 4);
      throw new AgentError('certbot_failed', `Let's Encrypt did not issue the certificate: ${detail}`);
    }
    const cert = this.certificates().find((c) => c.name === certName(spec.name));
    if (!cert) throw new AgentError('certbot_failed', 'Certbot reported success but the certificate was not found.');
    return cert;
  }
}
