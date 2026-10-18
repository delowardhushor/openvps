import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { extractServers, parseConfig, serverNameMatches, detectLayout } from '../src/agent/nginx-parse.ts';
import { renderSite } from '../src/agent/nginx-render.ts';
import { parseSiteSpec, type SiteSpec } from '../src/agent/sites-spec.ts';
import { SpecError } from '../src/agent/spec.ts';
import { SitesManager } from '../src/agent/sites.ts';
import { AgentError } from '../src/agent/pm2.ts';

const NGINX = '/usr/sbin/nginx';
const HAVE_NGINX = existsSync(NGINX);
const FAKE_CERTBOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-certbot.mjs');

const USER_SITE = `server {
    server_name thesportsarena.com www.thesportsarena.com; # managed by hand
    location / {
        proxy_pass http://localhost:3000;
        proxy_set_header Host $host;
    }
    listen 443 ssl; # managed by Certbot
    ssl_certificate LE/live/thesportsarena.com/fullchain.pem; # managed by Certbot
    ssl_certificate_key LE/live/thesportsarena.com/privkey.pem; # managed by Certbot
}
server {
    if ($host = www.thesportsarena.com) {
        return 301 https://$host$request_uri;
    } # managed by Certbot
    listen 80;
    server_name thesportsarena.com www.thesportsarena.com;
    return 404; # managed by Certbot
}
`;

describe('nginx config reading', () => {
  test('extracts server blocks from a certbot-managed site', () => {
    const s = extractServers(USER_SITE, '/etc/nginx/sites-enabled/sports');
    assert.equal(s.length, 2);
    assert.deepEqual(s[0]!.serverNames, ['thesportsarena.com', 'www.thesportsarena.com']);
    assert.equal(s[0]!.ssl, true);
    assert.equal(s[0]!.certificate, 'LE/live/thesportsarena.com/fullchain.pem');
    assert.deepEqual(s[0]!.proxyPass, ['http://localhost:3000']);
    assert.equal(s[1]!.ssl, false);
  });

  test('tolerates quotes, comments, ${vars} and braces in strings', () => {
    const src = `http { server { server_name "a.com" b.com; # c.com
      location / { add_header X-Test "x { y } ;"; return 200 "\${host}"; } } }`;
    const d = parseConfig(src);
    assert.equal(d[0]!.name, 'http');
    const s = extractServers(src, 'f');
    assert.deepEqual(s[0]!.serverNames, ['a.com', 'b.com']);
    assert.doesNotThrow(() => parseConfig('server { listen 80; ')); // unbalanced
  });

  test('server_name matching rules', () => {
    assert.ok(serverNameMatches('example.com', 'example.com'));
    assert.ok(serverNameMatches('*.example.com', 'app.example.com'));
    assert.ok(!serverNameMatches('*.example.com', 'example.com'));
    assert.ok(serverNameMatches('.example.com', 'example.com'));
    assert.ok(serverNameMatches('.example.com', 'a.b.example.com'));
    assert.ok(serverNameMatches('www.*', 'www.example.com'));
    assert.ok(!serverNameMatches('_', 'example.com'));
    assert.ok(!serverNameMatches('~^(?<x>.+)\\.com$', 'example.com'));
  });

  test('layout detection', () => {
    assert.equal(detectLayout('http { include /etc/nginx/conf.d/*.conf; include /etc/nginx/sites-enabled/*; }'), 'sites');
    assert.equal(detectLayout('http { include /etc/nginx/conf.d/*.conf; }'), 'confd');
    assert.equal(detectLayout('http { }'), null);
  });
});

describe('site spec validation', () => {
  const base = { name: 'shop', domains: ['shop.example.com'], type: 'proxy', upstreamPort: 3000 };
  const bad = (o: Record<string, unknown>, field: string) =>
    assert.throws(() => parseSiteSpec({ ...base, ...o }), (e: unknown) => e instanceof SpecError && e.field === field, JSON.stringify(o));

  test('accepts and normalizes', () => {
    const s = parseSiteSpec({ ...base, domains: ['Shop.Example.COM.', 'shop.example.com', 'www.shop.example.com'] });
    assert.deepEqual(s.domains, ['shop.example.com', 'www.shop.example.com']);
    assert.equal(s.https, true);
    assert.equal(s.maxBodyMb, 25);
  });

  test('rejects anything that could inject into an nginx config', () => {
    bad({ domains: ['a.com; include /etc/passwd'] }, 'domains');
    bad({ domains: ['a.com\nserver{'] }, 'domains');
    bad({ domains: ['*.example.com'] }, 'domains');
    bad({ domains: ['192.168.1.1'] }, 'domains');
    bad({ domains: ['localhost'] }, 'domains');
    bad({ domains: [] }, 'domains');
    bad({ name: 'Shop' }, 'name');
    bad({ type: 'php' }, 'type');
    bad({ upstreamPort: 0 }, 'upstreamPort');
    bad({ upstreamPort: '3000; return 200' }, 'upstreamPort');
    bad({ type: 'static', root: '/srv/apps/x; deny all' }, 'root');
    bad({ type: 'static', root: '/srv/apps/../etc' }, 'root');
    bad({ type: 'spa', root: 'relative/path' }, 'root');
    bad({ type: 'spa', root: '/srv/apps/my site' }, 'root');
    bad({ maxBodyMb: 0 }, 'maxBodyMb');
  });
});

describe('nginx config rendering', () => {
  const env = {
    acmeRoot: '/var/lib/openvps-agent/acme',
    ipv6: true,
    http2Directive: false,
    cert: null,
    panel: { port: 7443, tls: true },
    version: '0.3.0',
  };
  const spec = (o: Partial<SiteSpec>): SiteSpec => ({
    name: 'shop', domains: ['shop.example.com'], type: 'proxy', upstreamPort: 3000, root: null,
    https: true, forceHttps: true, hsts: false, maxBodyMb: 25, ...o,
  });

  test('HTTP only until a certificate exists, ACME path always served', () => {
    const c = renderSite(spec({}), env);
    assert.match(c, /listen 80;/);
    assert.match(c, /listen \[::\]:80;/);
    assert.match(c, /acme-challenge/);
    assert.match(c, /proxy_pass http:\/\/127\.0\.0\.1:3000;/);
    assert.doesNotMatch(c, /listen 443/);
    assert.doesNotMatch(c, /return 301/);
  });

  test('with a certificate: redirect + TLS server, HSTS optional, http2 syntax by version', () => {
    const withCert = { ...env, cert: { fullchain: '/le/fullchain.pem', key: '/le/privkey.pem' } };
    const c = renderSite(spec({ hsts: true }), withCert);
    assert.match(c, /return 301 https:\/\/\$host\$request_uri;/);
    assert.match(c, /listen 443 ssl http2;/);
    assert.match(c, /ssl_certificate \/le\/fullchain\.pem;/);
    assert.match(c, /Strict-Transport-Security/);
    assert.match(renderSite(spec({}), { ...withCert, http2Directive: true }), /http2 on;/);
    assert.match(renderSite(spec({}), { ...withCert, http2: false }), /listen 443 ssl;/);
    assert.doesNotMatch(renderSite(spec({}), { ...withCert, http2Directive: true, http2: false }), /http2/);
    const noRedirect = renderSite(spec({ forceHttps: false }), withCert);
    assert.doesNotMatch(noRedirect, /return 301/);
    assert.equal((noRedirect.match(/proxy_pass/g) ?? []).length, 2, 'content served on both');
  });

  test('HSTS is repeated in locations that set their own headers (Nginx does not inherit them)', () => {
    const withCert = { ...env, cert: { fullchain: '/le/fullchain.pem', key: '/le/privkey.pem' } };
    const spa = renderSite(spec({ type: 'spa', upstreamPort: null, root: '/srv/apps/admin/dist', hsts: true }), withCert);
    const tlsBlock = spa.slice(spa.indexOf('listen 443'));
    assert.equal((tlsBlock.match(/Strict-Transport-Security/g) ?? []).length, 3, 'server + assets + index');
    assert.match(spa, /Cache-Control "public, max-age=2592000"/);
    assert.doesNotMatch(spa, /expires /);
    const stat = renderSite(spec({ type: 'static', upstreamPort: null, root: '/srv/apps/site', hsts: false }), withCert);
    assert.match(stat, /Cache-Control "public, max-age=3600"/);
    assert.doesNotMatch(stat, /Strict-Transport-Security/);
  });

  test('static vs SPA fallback; panel proxies to local HTTPS', () => {
    assert.match(renderSite(spec({ type: 'static', upstreamPort: null, root: '/srv/apps/site/dist' }), env), /try_files \$uri \$uri\/ =404;/);
    const spa = renderSite(spec({ type: 'spa', upstreamPort: null, root: '/srv/apps/admin/dist' }), env);
    assert.match(spa, /try_files \$uri \$uri\/ \/index\.html;/);
    assert.match(spa, /root \/srv\/apps\/admin\/dist;/);
    assert.match(spa, /disable_symlinks if_not_owner;/);
    const panel = renderSite(spec({ type: 'panel', upstreamPort: null }), env);
    assert.match(panel, /proxy_pass https:\/\/127\.0\.0\.1:7443;/);
    assert.match(panel, /proxy_ssl_verify off;/);
  });
});

describe('sites with a real nginx binary', { skip: HAVE_NGINX ? false : 'nginx not installed' }, () => {
  let dir: string;
  let m: SitesManager;
  let reloads = 0;
  const le = () => join(dir, 'le');

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'openvps-nginx-'));
    for (const d of ['sites-available', 'sites-enabled', 'conf.d', 'le/live/thesportsarena.com', 'le/renewal', 'acme', 'srv/admin/dist', 'logs']) {
      mkdirSync(join(dir, d), { recursive: true });
    }
    writeFileSync(
      join(dir, 'nginx.conf'),
      `pid ${dir}/nginx.pid;\nerror_log ${dir}/logs/error.log;\nevents {}\nhttp {\n  include ${dir}/conf.d/*.conf;\n  include ${dir}/sites-enabled/*;\n}\n`,
    );
    // The user's existing hand-made site with a certbot certificate.
    const live = join(le(), 'live', 'thesportsarena.com');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '12', '-subj', '/CN=thesportsarena.com',
      '-addext', 'subjectAltName=DNS:thesportsarena.com,DNS:www.thesportsarena.com',
      '-keyout', join(live, 'privkey.pem'), '-out', join(live, 'fullchain.pem')], { stdio: 'ignore' });
    writeFileSync(join(le(), 'renewal', 'thesportsarena.com.conf'), '#\n');
    writeFileSync(join(dir, 'sites-available', 'thesportsarena.com'), USER_SITE.replaceAll('LE/', `${le()}/`));
    execFileSync('ln', ['-s', join(dir, 'sites-available', 'thesportsarena.com'), join(dir, 'sites-enabled', 'thesportsarena.com')]);
    writeFileSync(join(dir, 'srv/admin/dist/index.html'), '<h1>admin</h1>');
    chmodSync(FAKE_CERTBOT, 0o755);
    m = new SitesManager({
      nginxBin: NGINX,
      nginxConf: join(dir, 'nginx.conf'),
      sitesAvailable: join(dir, 'sites-available'),
      sitesEnabled: join(dir, 'sites-enabled'),
      confD: join(dir, 'conf.d'),
      letsencryptDir: le(),
      certbotBin: FAKE_CERTBOT,
      acmeRoot: join(dir, 'acme'),
      staticRoots: [join(dir, 'srv')],
      panel: { port: 7443, tls: true },
      version: '0.3.0-test',
      acmeServer: null,
      certbotEnv: { FAKE_LE_DIR: le() },
      dnsServers: null,
      checkPort: 80,
      ipv6: false,
      reload: async () => {
        reloads++;
        return { ok: true, message: 'Nginx reloaded.' };
      },
      isRunning: async () => true,
      renewalTimer: async () => 'certbot.timer',
    });
  });

  const proxy = (o: Partial<SiteSpec> = {}): SiteSpec => ({
    name: 'api', domains: ['api.thesportsarena.com'], type: 'proxy', upstreamPort: 4000, root: null,
    https: true, forceHttps: true, hsts: false, maxBodyMb: 25, ...o,
  });

  test('status lists existing sites and certificates read-only', async () => {
    const st = await m.status();
    assert.equal(st.installed, true);
    assert.equal(st.configOk, true);
    assert.equal(st.layout, 'sites');
    assert.match(st.version!, /^1\./);
    assert.equal(st.certbot.version, '9.9.9-fake');
    assert.ok(st.existing.some((s) => s.serverNames.includes('www.thesportsarena.com')));
    const certs = m.certificates();
    const theirs = certs.find((c) => c.name === 'thesportsarena.com')!;
    assert.deepEqual(theirs.domains, ['thesportsarena.com', 'www.thesportsarena.com']);
    assert.ok(theirs.daysLeft >= 10 && theirs.daysLeft <= 12);
    assert.equal(theirs.managed, false);
    assert.equal(theirs.renewable, true);
    assert.ok(theirs.usedBy[0]!.endsWith('thesportsarena.com'));
  });

  test('refuses a domain that an existing site already serves', async () => {
    await assert.rejects(m.apply(proxy({ domains: ['www.thesportsarena.com'] })), (e: unknown) => e instanceof AgentError && e.code === 'conflict' && /thesportsarena\.com/.test(e.message));
  });

  test('creates a proxy site, validated by nginx -t, symlinked and reloaded', async () => {
    const before = reloads;
    const r = await m.apply(proxy());
    assert.equal(r.state.enabled, true);
    assert.equal(r.state.httpsActive, false);
    assert.ok(lstatSync(join(dir, 'sites-enabled', 'openvps-api.conf')).isSymbolicLink());
    assert.ok(existsSync(join(dir, 'sites-enabled', 'openvps-00-shared.conf')));
    assert.equal(reloads, before + 1);
    const conf = readFileSync(m.siteFile('api'), 'utf8');
    assert.match(conf, /Managed by OpenVPS/);
    // Second OpenVPS site cannot take the same domain.
    await assert.rejects(m.apply(proxy({ name: 'other' })), (e: unknown) => e instanceof AgentError && /OpenVPS site "api"/.test(e.message));
  });

  test('SPA site: folder must be inside the allowed roots; readable checks', async () => {
    const spa = { ...proxy({ name: 'admin', domains: ['admin.thesportsarena.com'], type: 'spa', upstreamPort: null, root: join(dir, 'srv/admin/dist') }) } as SiteSpec;
    const r = await m.apply(spa);
    assert.equal(r.state.enabled, true);
    await assert.rejects(m.apply({ ...spa, name: 'etc', domains: ['etc.thesportsarena.com'], root: '/etc' }), (e: unknown) => e instanceof AgentError && e.field === 'root');
    await assert.rejects(m.apply({ ...spa, name: 'nope', domains: ['nope.thesportsarena.com'], root: join(dir, 'srv/missing') }), /does not exist/);
  });

  test('a configuration nginx rejects is rolled back and never left in place', async () => {
    // Break the shared map file so the full config test fails after writing.
    const sharedReal = readFileSync(join(dir, 'sites-available', 'openvps-00-shared.conf'), 'utf8');
    const filesBefore = readdirSync(join(dir, 'sites-enabled')).sort();
    const contentBefore = readFileSync(m.siteFile('api'), 'utf8');
    // A site whose rendered config refers to an upstream port nginx accepts, but force failure by
    // making the certificate "exist" with an unreadable path.
    mkdirSync(join(le(), 'live', 'openvps-api'), { recursive: true });
    writeFileSync(join(le(), 'live', 'openvps-api', 'fullchain.pem'), 'not a certificate');
    writeFileSync(join(le(), 'live', 'openvps-api', 'privkey.pem'), 'not a key');
    await assert.rejects(m.apply(proxy({ maxBodyMb: 50 })), (e: unknown) => e instanceof AgentError && e.code === 'nginx_test_failed');
    assert.equal(readFileSync(m.siteFile('api'), 'utf8'), contentBefore, 'previous file restored');
    assert.deepEqual(readdirSync(join(dir, 'sites-enabled')).sort(), filesBefore);
    assert.equal(readFileSync(join(dir, 'sites-available', 'openvps-00-shared.conf'), 'utf8'), sharedReal);
    assert.equal((await m.testConfig()).ok, true, 'nginx config still valid');
    execFileSync('rm', ['-rf', join(le(), 'live', 'openvps-api')]);
  });

  test('refuses to touch anything while nginx is already broken', async () => {
    const bad = join(dir, 'sites-enabled', 'zz-broken');
    writeFileSync(bad, 'server { listen 80; this_is_not_a_directive; }');
    await assert.rejects(m.apply(proxy({ maxBodyMb: 10 })), (e: unknown) => e instanceof AgentError && e.code === 'nginx_broken');
    execFileSync('rm', [bad]);
  });

  test('certificate issue switches the site to HTTPS; failures are explained', async () => {
    const cert = await m.issue(proxy(), 'admin@thesportsarena.com');
    assert.equal(cert.name, 'openvps-api');
    assert.deepEqual(cert.domains, ['api.thesportsarena.com']);
    const calls = readFileSync(join(le(), 'calls.log'), 'utf8');
    assert.match(calls, /certonly --non-interactive --agree-tos --webroot -w \S+acme --cert-name openvps-api --deploy-hook systemctl reload nginx --email admin@thesportsarena\.com -d api\.thesportsarena\.com/);
    const r = await m.apply(proxy());
    assert.equal(r.state.httpsActive, true);
    const conf = readFileSync(m.siteFile('api'), 'utf8');
    assert.match(conf, /listen 443 ssl/);
    assert.match(conf, /return 301 https/);
    assert.equal((await m.testConfig()).ok, true);

    await m.apply(proxy({ name: 'bad', domains: ['fail.thesportsarena.com'] }));
    await assert.rejects(m.issue(proxy({ name: 'bad', domains: ['fail.thesportsarena.com'] }), null), (e: unknown) => e instanceof AgentError && e.code === 'certbot_failed' && /firewall/.test(e.message));
  });

  test('remove deletes the files (and optionally the certificate), nginx stays valid', async () => {
    await m.remove('api', true);
    assert.equal(existsSync(m.siteFile('api')), false);
    assert.equal(existsSync(join(dir, 'sites-enabled', 'openvps-api.conf')), false);
    assert.equal(existsSync(join(le(), 'live', 'openvps-api')), false);
    assert.equal((await m.testConfig()).ok, true);
    // The user's own site and certificate were never touched.
    assert.ok(existsSync(join(dir, 'sites-enabled', 'thesportsarena.com')));
    assert.ok(existsSync(join(le(), 'live', 'thesportsarena.com', 'fullchain.pem')));
  });

  after(() => undefined);
});
