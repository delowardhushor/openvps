import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Client, GOOD_PASSWORD, startTestServer, type TestServer } from './helpers.ts';
import { helloSpec, startAgentFixture, type AgentFixture } from './agent-fixture.ts';
import { SecretBox } from '../src/secretbox.ts';

describe('secretbox', () => {
  test('round trip, tamper detection, unique IVs', () => {
    const box = new SecretBox(Buffer.alloc(32, 7));
    const a = box.seal('hello');
    assert.notEqual(a, box.seal('hello'));
    assert.equal(box.open(a), 'hello');
    const parts = a.split(':');
    parts[3] = Buffer.from('jello').toString('base64');
    assert.throws(() => box.open(parts.join(':')));
    assert.throws(() => new SecretBox(Buffer.alloc(32, 8)).open(a), 'wrong key fails');
  });
});

describe('applications API', () => {
  let fx: AgentFixture;
  let srv: TestServer;
  let c: Client;

  before(async () => {
    fx = await startAgentFixture();
    srv = await startTestServer({ agent: { socket: fx.socket } });
    c = new Client(srv.url);
    const r = await c.post('/api/setup', { setupToken: srv.setupToken, username: 'admin', password: GOOD_PASSWORD });
    assert.equal(r.status, 200);
  });
  after(async () => {
    await srv.close();
    await fx.close();
  });

  test('requires authentication', async () => {
    const anon = new Client(srv.url);
    for (const p of ['/api/agent', '/api/processes', '/api/apps']) assert.equal((await anon.get(p)).status, 401, p);
    assert.equal((await anon.post('/api/processes/root/legacy-api/stop')).status, 401);
  });

  test('agent info and the process overview include root apps', async () => {
    const a = await c.get('/api/agent');
    assert.equal(a.json.available, true);
    assert.equal(a.json.info.root.available, true);
    const p = await c.get('/api/processes');
    assert.equal(p.status, 200);
    assert.equal(p.json.agent.available, true);
    assert.equal(p.json.root.processes[0].name, 'legacy-api');
    assert.ok(!p.text.includes('root-secret'));
  });

  test('controls a root process, audited, with logs', async () => {
    let r = await c.post('/api/processes/root/legacy-api/restart');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'online');
    r = await c.post('/api/processes/root/legacy-api/destroy');
    assert.equal(r.status, 404);
    r = await c.get('/api/processes/root/legacy-api/logs?stream=out&lines=10');
    assert.equal(r.status, 200);
    assert.equal(r.json.lines.length, 10);
    const audit = await c.get('/api/audit?action=process.');
    assert.ok(audit.json.entries.some((e: any) => e.target === 'root:legacy-api' && e.details.op === 'restart' && e.outcome === 'success'));
  });

  test('creates an app: validated by the agent, env sealed, never returned', async () => {
    let r = await c.post('/api/apps', { spec: helloSpec(fx.appsRoot, { cwd: '/etc' }), env: {} });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.field, 'cwd');
    assert.equal((await c.get('/api/apps')).json.apps.length, 0, 'nothing stored when the agent refuses');

    r = await c.post('/api/apps', { spec: helloSpec(fx.appsRoot), env: { PORT: '3000', DB_PASSWORD: 'hunter2-secret' } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.process.status, 'online');
    assert.deepEqual(r.json.app.envKeys, ['DB_PASSWORD', 'PORT']);
    assert.ok(!r.text.includes('hunter2-secret'), 'env values never leave the server');

    const db = readFileSync(join(srv.config.dataDir, 'openvps.db'));
    assert.ok(!db.includes(Buffer.from('hunter2-secret')), 'not stored in plain text');
    assert.equal((statSync(join(srv.config.dataDir, 'secret.key')).mode & 0o777).toString(8), '600');

    const all = await c.get('/api/apps');
    assert.ok(!all.text.includes('hunter2-secret'));
    const dup = await c.post('/api/apps', { spec: helloSpec(fx.appsRoot), env: {} });
    assert.equal(dup.status, 409);

    const audit = await c.get('/api/audit?action=app.');
    assert.ok(!audit.text.includes('hunter2-secret'), 'audit lists keys only');
    assert.ok(audit.json.entries.some((e: any) => e.action === 'app.create' && e.details.envKeys.includes('DB_PASSWORD')));
  });

  test('env updates merge, unset, and restart with the new values', async () => {
    const r = await c.req('PUT', '/api/apps/hello/env', { set: { PORT: '4000', NEW_VAR: 'x' }, unset: ['DB_PASSWORD'] });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(r.json.app.envKeys, ['NEW_VAR', 'PORT']);
    const spec = JSON.parse(readFileSync(join(fx.dir, 'specs', 'hello.json'), 'utf8')).apps[0];
    assert.equal(spec.env.PORT, '4000');
    assert.equal(spec.env.DB_PASSWORD, undefined);
    const bad = await c.req('PUT', '/api/apps/hello/env', { set: { PM2_HOME: '/tmp' } });
    assert.equal(bad.status, 400);
  });

  test('updates settings; name is immutable', async () => {
    const r = await c.req('PUT', '/api/apps/hello', { spec: { ...helloSpec(fx.appsRoot), name: 'renamed', args: [] } });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.app.name, 'hello');
    assert.deepEqual(r.json.app.spec.args, []);
  });

  test('stop and start a managed app; start re-deploys if PM2 forgot it', async () => {
    let r = await c.post('/api/processes/apps/hello/stop');
    assert.equal(r.json.status, 'stopped');
    // Simulate the app disappearing from PM2 (e.g. someone ran pm2 delete).
    await fx.client.call({ action: 'app.remove', params: { name: 'hello' } });
    r = await c.post('/api/processes/apps/hello/start');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.status, 'online');
  });

  test('delete removes it from PM2 and the database', async () => {
    const r = await c.req('DELETE', '/api/apps/hello');
    assert.equal(r.status, 200);
    assert.equal((await c.get('/api/apps/hello')).status, 404);
    const p = await c.get('/api/processes');
    assert.equal(p.json.apps.processes.length, 0);
  });
});

describe('applications API without an agent', () => {
  let srv: TestServer;
  let c: Client;
  before(async () => {
    srv = await startTestServer({ agent: { socket: '/nonexistent/agent.sock' } });
    c = new Client(srv.url);
    await c.post('/api/setup', { setupToken: srv.setupToken, username: 'admin', password: GOOD_PASSWORD });
  });
  after(async () => srv.close());

  test('degrades gracefully with a clear message', async () => {
    const a = await c.get('/api/agent');
    assert.equal(a.json.available, false);
    assert.match(a.json.reason, /openvps provision/);
    const p = await c.get('/api/processes');
    assert.equal(p.status, 200);
    assert.equal(p.json.agent.available, false);
    const x = await c.post('/api/processes/root/legacy-api/restart');
    assert.equal(x.status, 503);
    assert.equal(x.json.error.code, 'agent_unavailable');
  });
});
