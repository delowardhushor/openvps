import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Client, GOOD_PASSWORD, startTestServer, type TestServer } from './helpers.ts';

describe('API', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ auth: { maxFailedAttempts: 3, ipAttemptsPerWindow: 50 } });
  });
  after(async () => srv.close());

  const PROTECTED = [
    '/api/auth/me',
    '/api/auth/sessions',
    '/api/system/overview',
    '/api/system/metrics',
    '/api/system/history',
    '/api/system/services',
    '/api/audit',
  ];

  test('health is public', async () => {
    const r = await new Client(srv.url).get('/api/health');
    assert.equal(r.status, 200);
    assert.equal(r.json.status, 'ok');
  });

  test('protected endpoints reject unauthenticated requests (FR-02)', async () => {
    const c = new Client(srv.url);
    for (const p of PROTECTED) {
      const r = await c.get(p);
      assert.equal(r.status, 401, p);
      assert.equal(r.json.error.code, 'unauthenticated');
    }
    // Forged cookies are rejected too.
    c.cookie = 'ovps_sid=' + 'A'.repeat(43);
    assert.equal((await c.get('/api/system/overview')).status, 401);
  });

  test('security headers', async () => {
    const r = await new Client(srv.url).get('/api/health');
    assert.match(r.headers.get('content-security-policy')!, /default-src 'self'/);
    assert.equal(r.headers.get('x-frame-options'), 'DENY');
    assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(r.headers.get('cache-control'), 'no-store');
  });

  test('setup requires a valid token and a strong password', async () => {
    const c = new Client(srv.url);
    assert.deepEqual((await c.get('/api/setup/status')).json, { needsSetup: true, tokenIssued: true });

    let r = await c.post('/api/setup', { setupToken: 'wrong-token-value', username: 'admin', password: GOOD_PASSWORD });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'invalid_setup_token');

    r = await c.post('/api/setup', { setupToken: srv.setupToken, username: 'admin', password: 'short' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'weak_password');

    r = await c.post('/api/setup', { setupToken: srv.setupToken, username: '1$bad', password: GOOD_PASSWORD });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.field, 'username');
    assert.equal(srv.app.users.count(), 0);
  });

  test('CSRF: mutating requests need the header and same origin', async () => {
    const c = new Client(srv.url);
    const body = { setupToken: srv.setupToken, username: 'admin', password: GOOD_PASSWORD };
    let r = await c.req('POST', '/api/setup', body, { 'x-openvps-request': '' });
    assert.equal(r.status, 403);
    assert.equal(r.json.error.code, 'csrf');
    r = await c.req('POST', '/api/setup', body, { 'x-openvps-request': '1', origin: 'https://evil.example' });
    assert.equal(r.status, 403);
    r = await c.req('POST', '/api/setup', body, { 'x-openvps-request': '1', 'sec-fetch-site': 'cross-site' });
    assert.equal(r.status, 403);
    r = await c.req('OPTIONS', '/api/setup', undefined, { 'x-openvps-request': '1' });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('access-control-allow-origin'), null);
    assert.equal(srv.app.users.count(), 0);
  });

  test('body validation', async () => {
    const c = new Client(srv.url);
    let r = await c.req('POST', '/api/auth/login', 'not json');
    assert.equal(r.status, 400);
    r = await c.req('POST', '/api/auth/login', '{"a":1}', { 'content-type': 'text/plain', 'x-openvps-request': '1' });
    assert.equal(r.status, 415);
    r = await c.req('POST', '/api/auth/login', JSON.stringify({ username: 'x'.repeat(40_000) }));
    assert.equal(r.status, 413);
    r = await c.req('POST', '/api/auth/login', '[]');
    assert.equal(r.status, 400);
  });

  let admin: Client;

  test('setup creates the admin, signs in, and consumes the token', async () => {
    admin = new Client(srv.url);
    const r = await admin.post('/api/setup', { setupToken: srv.setupToken, username: 'admin', password: GOOD_PASSWORD });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.user.username, 'admin');
    assert.equal(r.json.user.password_hash, undefined, 'never leaks the hash');
    const cookie = r.setCookie[0]!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Strict/);
    assert.match(cookie, /Path=\//);
    assert.equal(existsSync(join(srv.config.dataDir, 'setup-token')), false, 'token file removed');

    const again = await new Client(srv.url).post('/api/setup', { setupToken: srv.setupToken, username: 'evil', password: GOOD_PASSWORD });
    assert.equal(again.status, 409);
    assert.equal((await admin.get('/api/setup/status')).json.needsSetup, false);
  });

  test('authenticated dashboard data (FR-03)', async () => {
    const r = await admin.get('/api/system/overview');
    assert.equal(r.status, 200);
    const o = r.json;
    assert.ok(o.metrics, 'has metrics');
    assert.equal(typeof o.metrics.cpu.percent, 'number');
    assert.ok(o.metrics.memory.totalBytes > 0);
    assert.ok(Array.isArray(o.metrics.disks));
    assert.equal(typeof o.metrics.uptimeSeconds, 'number');
    assert.equal(typeof o.metrics.collectedAt, 'number', 'last-updated timestamp');
    assert.equal(o.stale, false);
    assert.ok(o.host.os.prettyName);
    assert.deepEqual(o.services[0], { name: 'nginx', state: 'active', enabled: true });
    assert.ok(o.activity.recent.some((e: any) => e.action === 'setup.admin_create'));

    const h = await admin.get('/api/system/history');
    assert.equal(h.status, 200);
    assert.ok(h.json.points.length >= 1);
  });

  test('login: generic errors, lockout, audit without secrets', async () => {
    const c = new Client(srv.url);
    let r = await c.post('/api/auth/login', { username: 'nobody', password: 'whatever-password' });
    assert.equal(r.status, 401);
    const unknownMsg = r.json.error.message;
    r = await c.post('/api/auth/login', { username: 'admin', password: 'wrong-password-1' });
    assert.equal(r.status, 401);
    assert.equal(r.json.error.message, unknownMsg, 'same message for unknown user and wrong password');
    await c.post('/api/auth/login', { username: 'admin', password: 'wrong-password-2' });
    await c.post('/api/auth/login', { username: 'admin', password: 'wrong-password-3' });
    r = await c.post('/api/auth/login', { username: 'admin', password: GOOD_PASSWORD });
    assert.equal(r.status, 423, 'locked even with the right password');
    assert.ok(Number(r.headers.get('retry-after')) > 0);

    srv.app.users.unlock(srv.app.users.byUsername('admin')!.id);
    r = await c.post('/api/auth/login', { username: 'ADMIN', password: GOOD_PASSWORD });
    assert.equal(r.status, 200, 'case-insensitive username');

    const audit = await admin.get('/api/audit?action=auth.login&limit=100');
    assert.equal(audit.status, 200);
    const text = JSON.stringify(audit.json);
    assert.ok(!text.includes('wrong-password'), 'no passwords in audit log');
    assert.ok(!text.includes(GOOD_PASSWORD));
    assert.ok(audit.json.entries.some((e: any) => e.outcome === 'failure' && e.details?.reason === 'locked'));
    assert.ok(audit.json.entries.some((e: any) => e.outcome === 'success'));
  });

  test('sessions list, revoke others, logout', async () => {
    const second = new Client(srv.url);
    await second.post('/api/auth/login', { username: 'admin', password: GOOD_PASSWORD });
    const list = await admin.get('/api/auth/sessions');
    assert.ok(list.json.sessions.length >= 2);
    assert.equal(list.json.sessions.filter((s: any) => s.current).length, 1);

    const other = list.json.sessions.find((s: any) => !s.current);
    const del = await admin.req('DELETE', `/api/auth/sessions/${other.id}`);
    assert.equal(del.status, 200);

    const r = await admin.post('/api/auth/sessions/revoke-others');
    assert.equal(r.status, 200);
    assert.equal((await second.get('/api/auth/me')).status, 401, 'other session revoked');

    const tmp = new Client(srv.url);
    await tmp.post('/api/auth/login', { username: 'admin', password: GOOD_PASSWORD });
    const saved = tmp.cookie;
    const out = await tmp.post('/api/auth/logout');
    assert.equal(out.status, 200);
    assert.match(out.setCookie[0]!, /Max-Age=0/);
    tmp.cookie = saved;
    assert.equal((await tmp.get('/api/auth/me')).status, 401, 'token is dead server-side after logout');
  });

  test('password change revokes other sessions', async () => {
    const other = new Client(srv.url);
    await other.post('/api/auth/login', { username: 'admin', password: GOOD_PASSWORD });
    let r = await admin.post('/api/auth/password', { currentPassword: 'nope-nope-nope', newPassword: 'another strong passphrase' });
    assert.equal(r.status, 400);
    r = await admin.post('/api/auth/password', { currentPassword: GOOD_PASSWORD, newPassword: 'another strong passphrase' });
    assert.equal(r.status, 200);
    assert.equal((await other.get('/api/auth/me')).status, 401);
    assert.equal((await admin.get('/api/auth/me')).status, 200, 'current session kept');
    const login = await new Client(srv.url).post('/api/auth/login', { username: 'admin', password: 'another strong passphrase' });
    assert.equal(login.status, 200);
  });

  test('static files: SPA fallback, caching, and no path traversal', async () => {
    const c = new Client(srv.url);
    let r = await c.get('/');
    assert.equal(r.status, 200);
    assert.match(r.text, /OpenVPS/);
    r = await c.get('/dashboard/anything');
    assert.equal(r.status, 200, 'SPA route');
    r = await c.get('/assets/app-abc123.js');
    assert.match(r.headers.get('cache-control')!, /immutable/);
    for (const p of ['/../secret.txt', '/..%2fsecret.txt', '/%2e%2e/secret.txt', '/assets/..%2f..%2fsecret.txt']) {
      r = await c.get(p);
      assert.ok(!r.text.includes('top secret'), p);
    }
    r = await c.get('/missing.js');
    assert.equal(r.status, 404);
    r = await c.get('/api/nope');
    assert.equal(r.status, 404);
    assert.equal(r.json.error.code, 'not_found');
  });

  test('audit query validation', async () => {
    assert.equal((await admin.get('/api/audit?limit=abc')).status, 400);
    assert.equal((await admin.get('/api/audit?outcome=evil')).status, 400);
    assert.equal((await admin.get("/api/audit?action=a'b")).status, 400);
  });
});

describe('API rate limiting', () => {
  let srv: TestServer;
  before(async () => {
    srv = await startTestServer({ auth: { ipAttemptsPerWindow: 3 } });
  });
  after(async () => srv.close());

  test('limits login attempts per IP (FR-02)', async () => {
    const c = new Client(srv.url);
    for (let i = 0; i < 3; i++) {
      assert.equal((await c.post('/api/auth/login', { username: 'x', password: 'y' })).status, 401);
    }
    const r = await c.post('/api/auth/login', { username: 'x', password: 'y' });
    assert.equal(r.status, 429);
    assert.ok(Number(r.headers.get('retry-after')) > 0);
  });
});
