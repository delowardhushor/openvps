import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Client, GOOD_PASSWORD, startTestServer, type TestServer } from './helpers.ts';
import { startAgentFixture, type AgentFixture } from './agent-fixture.ts';
import { clientIp } from '../src/app.ts';

const HAVE_NGINX = existsSync('/usr/sbin/nginx');

describe('sites API', { skip: HAVE_NGINX ? false : 'nginx not installed' }, () => {
  let fx: AgentFixture;
  let srv: TestServer;
  let c: Client;
  const proxy = (o: Record<string, unknown> = {}) => ({
    name: 'api', domains: ['api.thesportsarena.com'], type: 'proxy', upstreamPort: 4000, https: true, forceHttps: true, hsts: false, maxBodyMb: 25, ...o,
  });

  before(async () => {
    fx = await startAgentFixture({ sites: true });
    srv = await startTestServer({ agent: { socket: fx.socket } });
    c = new Client(srv.url);
    assert.equal((await c.post('/api/setup', { setupToken: srv.setupToken, username: 'admin', password: GOOD_PASSWORD })).status, 200);
  });
  after(async () => {
    await srv.close();
    await fx.close();
  });

  test('requires authentication', async () => {
    const anon = new Client(srv.url);
    for (const p of ['/api/sites', '/api/certificates', '/api/settings/certificates']) assert.equal((await anon.get(p)).status, 401, p);
    assert.equal((await anon.post('/api/sites', { spec: proxy() })).status, 401);
  });

  test('overview shows nginx, existing sites and their certificates read-only', async () => {
    const r = await c.get('/api/sites');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.agent.available, true);
    assert.equal(r.json.nginx.configOk, true);
    assert.ok(r.json.nginx.existing.some((s: any) => s.serverNames.includes('thesportsarena.com')));
    const cert = r.json.certificates.find((x: any) => x.name === 'thesportsarena.com');
    assert.ok(cert && cert.daysLeft >= 13 && !cert.managed);
    assert.deepEqual(r.json.sites, []);
  });

  test('validation and conflicts with existing sites', async () => {
    let r = await c.post('/api/sites', { spec: proxy({ domains: ['bad domain'] }) });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.field, 'domains');
    r = await c.post('/api/sites', { spec: proxy({ domains: ['www.thesportsarena.com'] }) });
    assert.equal(r.status, 409);
    assert.match(r.json.error.message, /already served by/);
    assert.equal((await c.get('/api/sites')).json.sites.length, 0, 'nothing stored on failure');
  });

  test('create site, then get a certificate: switches to HTTPS', async () => {
    let r = await c.post('/api/sites', { spec: proxy() });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.state.enabled, true);
    assert.equal(r.json.state.httpsActive, false);

    // Pre-flight fails cleanly for a domain that doesn't resolve (no Let's Encrypt call made).
    r = await c.post('/api/sites/api/certificate', {});
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.certificate, null);
    assert.equal(r.json.checks[0].dnsOk, false);
    assert.match(r.json.certificateError, /DNS/);

    assert.equal((await c.req('PUT', '/api/settings/certificates', { email: 'not-an-email' })).status, 400);
    assert.equal((await c.req('PUT', '/api/settings/certificates', { email: 'ops@thesportsarena.com' })).status, 200);
    r = await c.post('/api/sites/api/certificate', { skipChecks: true });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.certificate.name, 'openvps-api');
    assert.equal(r.json.state.httpsActive, true);

    const cfg = await c.get('/api/sites/api/config');
    assert.match(cfg.json.current, /listen 443 ssl/);
    assert.match(cfg.json.current, /return 301 https/);

    const list = await c.get('/api/sites');
    const site = list.json.sites.find((s: any) => s.name === 'api');
    assert.equal(site.state.httpsActive, true);
    assert.ok(list.json.certificates.find((x: any) => x.name === 'openvps-api').managed);
    const calls = readFileSync(join(fx.dir, 'nginx', 'le', 'calls.log'), 'utf8');
    assert.match(calls, /--email ops@thesportsarena\.com/);
  });

  test('certificate failures are reported, site stays on HTTP', async () => {
    await c.post('/api/sites', { spec: proxy({ name: 'flaky', domains: ['fail.thesportsarena.com'] }) });
    const r = await c.post('/api/sites/flaky/certificate', { skipChecks: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.certificate, null);
    assert.match(r.json.certificateError, /firewall/);
    const audit = await c.get('/api/audit?action=certificate.');
    assert.ok(audit.json.entries.some((e: any) => e.outcome === 'failure' && e.target === 'flaky'));
  });

  test('SPA site from a build folder, and the panel domain (only one)', async () => {
    let r = await c.post('/api/sites', { spec: { name: 'admin', domains: ['admin.thesportsarena.com'], type: 'spa', root: join(fx.dir, 'srv-apps', 'admin', 'dist') } });
    assert.equal(r.status, 200, r.text);
    r = await c.post('/api/sites', { spec: { name: 'panel', domains: ['panel.thesportsarena.com'], type: 'panel' } });
    assert.equal(r.status, 200, r.text);
    const cfg = await c.get('/api/sites/panel/config');
    assert.match(cfg.json.current, new RegExp(`127\\.0\\.0\\.1:${srv.config.listen.port}`));
    r = await c.post('/api/sites', { spec: { name: 'panel2', domains: ['panel2.thesportsarena.com'], type: 'panel' } });
    assert.equal(r.status, 409);
  });

  test('update and delete (with certificate)', async () => {
    let r = await c.req('PUT', '/api/sites/api', { spec: proxy({ upstreamPort: 5000, domains: ['api.thesportsarena.com'] }) });
    assert.equal(r.status, 200, r.text);
    assert.match((await c.get('/api/sites/api/config')).json.current, /127\.0\.0\.1:5000/);
    r = await c.req('DELETE', '/api/sites/api?deleteCertificate=1');
    assert.equal(r.status, 200);
    assert.equal(r.json.certificateDeleted, true);
    assert.equal((await c.get('/api/sites/api/config')).status, 404);
    const certs = await c.get('/api/certificates');
    assert.ok(!certs.json.certificates.some((x: any) => x.name === 'openvps-api'));
    assert.ok(certs.json.certificates.some((x: any) => x.name === 'thesportsarena.com'), "user's certificate untouched");
  });
});

describe('client IP behind the panel domain', () => {
  let server: Server;
  let url: string;
  before(async () => {
    server = createServer((req, res) => res.end(clientIp(req, false)));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => new Promise<void>((r) => server.close(() => r())));

  test('trusts X-Real-IP / the last X-Forwarded-For hop from local Nginx, not forged first hops', async () => {
    const get = async (h: Record<string, string>) => (await fetch(url, { headers: h })).text();
    assert.equal(await get({ 'x-real-ip': '203.0.113.7' }), '203.0.113.7');
    assert.equal(await get({ 'x-forwarded-for': '6.6.6.6, 198.51.100.4' }), '198.51.100.4');
    assert.equal(await get({ 'x-real-ip': 'not-an-ip; drop' }), '127.0.0.1');
    assert.equal(await get({}), '127.0.0.1');
  });
});
