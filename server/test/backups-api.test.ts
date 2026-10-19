import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Client, GOOD_PASSWORD, startTestServer, type TestServer } from './helpers.ts';
import { startAgentFixture, type AgentFixture } from './agent-fixture.ts';
import { FakeS3 } from './fake-s3.ts';

const URI = 'mongodb://admin:hunter2secret@db.internal:27017/?authSource=admin';

describe('backups API', () => {
  let fx: AgentFixture;
  let srv: TestServer;
  let s3: FakeS3;
  let c: Client;
  let site: string;

  const plan = (over: Record<string, unknown> = {}) => ({
    name: 'nightly',
    enabled: true,
    sources: [
      { type: 'files', name: 'hello', path: site, exclude: ['node_modules'] },
      { type: 'mongodb', name: 'shop', databases: ['orders'] },
    ],
    mongoUris: { shop: URI },
    schedule: { kind: 'daily', hour: 3, minute: 15 },
    retention: { keepLast: 3, maxAgeDays: null },
    keepLocal: true,
    destination: 'offsite',
    ...over,
  });

  const wait = async (id: number) => {
    for (let i = 0; i < 400; i++) {
      const r = await c.get(`/api/backups/runs/${id}`);
      assert.equal(r.status, 200, r.text);
      if (r.json.run.status !== 'running') return r.json.run;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('run did not finish');
  };
  const backupNow = async (name = 'nightly') => {
    const r = await c.post(`/api/backups/plans/${name}/run`);
    assert.equal(r.status, 200, r.text);
    return wait(r.json.run.id);
  };

  before(async () => {
    fx = await startAgentFixture();
    s3 = await new FakeS3().start();
    srv = await startTestServer({ agent: { socket: fx.socket } });
    // Set after loading: config validation (rightly) refuses roots under /tmp, where CI keeps its temp dirs.
    srv.config.backups.fileRoots = [fx.appsRoot];
    site = join(fx.appsRoot, 'hello');
    c = new Client(srv.url);
    assert.equal((await c.post('/api/setup', { setupToken: srv.setupToken, username: 'admin', password: GOOD_PASSWORD })).status, 200);
  });
  after(async () => {
    // Tolerate a failed `before`: anything left listening would keep the test process alive forever.
    await srv?.close();
    await fx?.close();
    await s3?.close();
  });

  const dest = () => ({
    name: 'offsite',
    target: { endpoint: s3.endpoint, region: 'us-east-1', bucket: s3.bucket, prefix: 'vps1/', pathStyle: true },
    secrets: { accessKeyId: 'AKIATESTKEY', secretAccessKey: 'test-secret-access-key-123' },
  });

  test('requires authentication', async () => {
    const anon = new Client(srv.url);
    for (const p of ['/api/backups', '/api/backups/runs/1', '/api/backups/plans/nightly/artifacts']) assert.equal((await anon.get(p)).status, 401, p);
    for (const p of ['/api/backups/plans', '/api/backups/destinations', '/api/backups/plans/nightly/run', '/api/backups/destinations/test']) {
      assert.equal((await anon.post(p, {})).status, 401, p);
    }
  });

  test('overview starts empty and reports the tools on this server', async () => {
    const r = await c.get('/api/backups');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.agent.available, true);
    assert.equal(r.json.status.tar, true);
    assert.match(r.json.status.mongodump.version, /100\.9/);
    assert.deepEqual(r.json.plans, []);
    assert.deepEqual(r.json.destinations, []);
  });

  test('destinations: validated, tested against the real bucket, secrets never returned', async () => {
    let r = await c.post('/api/backups/destinations', { ...dest(), target: { ...dest().target, endpoint: 'http://s3.example.com' } });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.field, 'endpoint');
    r = await c.post('/api/backups/destinations', { ...dest(), secrets: { accessKeyId: '', secretAccessKey: '' } });
    assert.equal(r.status, 400);

    r = await c.post('/api/backups/destinations/test', dest());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.ok, true);
    r = await c.post('/api/backups/destinations/test', { ...dest(), secrets: { accessKeyId: 'WRONGKEY', secretAccessKey: 'whatever-secret-1' } });
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 's3_failed');
    assert.match(r.json.error.message, /AccessDenied/);

    r = await c.post('/api/backups/destinations', dest());
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.destination.keyHint, 'AKIA…');
    assert.ok(!r.text.includes('test-secret-access-key'));
    assert.equal((await c.post('/api/backups/destinations', dest())).status, 409);

    // Testing a saved destination without re-entering keys uses the stored ones and records the result.
    r = await c.post('/api/backups/destinations/test', { name: 'offsite', target: dest().target });
    assert.equal(r.status, 200, r.text);
    const o = await c.get('/api/backups');
    assert.equal(o.json.destinations[0].lastTestOk, true);
    assert.ok(!o.text.includes('test-secret-access-key'));

    // Editing with blank keys keeps the stored ones.
    r = await c.req('PUT', '/api/backups/destinations/offsite', { target: { ...dest().target, prefix: 'vps1' }, secrets: {} });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.destination.target.prefix, 'vps1/');
    assert.equal((await c.post('/api/backups/destinations/test', { name: 'offsite', target: dest().target })).status, 200);
  });

  test('plans: validation', async () => {
    let r = await c.post('/api/backups/plans', plan({ name: 'Bad Name' }));
    assert.equal(r.json.error.field, 'name');
    r = await c.post('/api/backups/plans', plan({ sources: [{ type: 'files', name: 'etc', path: '/etc', exclude: [] }] }));
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /must be inside/);
    r = await c.post('/api/backups/plans', plan({ mongoUris: {} }));
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /connection string/);
    r = await c.post('/api/backups/plans', plan({ mongoUris: { shop: 'postgres://x' } }));
    assert.equal(r.status, 400);
    r = await c.post('/api/backups/plans', plan({ keepLocal: false, destination: null }));
    assert.match(r.json.error.message, /where to keep/);
    r = await c.post('/api/backups/plans', plan({ destination: 'nowhere' }));
    assert.equal(r.json.error.field, 'destination');
    r = await c.post('/api/backups/plans', plan({ schedule: { kind: 'daily', hour: 30, minute: 0 } }));
    assert.equal(r.status, 400);
    r = await c.post('/api/backups/plans', plan({ retention: { keepLast: 0 } }));
    assert.equal(r.status, 400);
    assert.equal((await c.get('/api/backups')).json.plans.length, 0);
  });

  test('create a plan; the connection string is hidden and kept when editing', async () => {
    let r = await c.post('/api/backups/plans', plan());
    assert.equal(r.status, 200, r.text);
    assert.ok(!r.text.includes('hunter2secret'));
    assert.equal(r.json.plan.mongo.shop, 'mongodb://admin:***@db.internal:27017/?authSource=admin');
    assert.ok(r.json.plan.nextRunAt > Date.now());
    assert.equal((await c.post('/api/backups/plans', plan())).status, 409);

    r = await c.req('PUT', '/api/backups/plans/nightly', plan({ mongoUris: {}, schedule: { kind: 'manual' } }));
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.plan.nextRunAt, null);
    assert.equal(r.json.plan.mongo.shop, 'mongodb://admin:***@db.internal:27017/?authSource=admin');
    assert.equal(srv.app.backups.store.mongoUris('nightly').shop, URI);

    r = await c.req('PUT', '/api/backups/plans/nightly', plan({ sources: [{ type: 'mongodb', name: 'other', databases: [] }], mongoUris: {} }));
    assert.equal(r.status, 400, 'a new MongoDB source needs its own connection string');
    assert.equal((await c.req('PUT', '/api/backups/plans/nightly', plan())).status, 200);
  });

  test('run a backup: files + MongoDB, kept here and in the bucket', async () => {
    let r = await c.post('/api/backups/plans/nightly/run');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.run.status, 'running');
    const id = r.json.run.id;
    const again = await c.post('/api/backups/plans/nightly/run');
    assert.equal(again.status, 409, 'one task per plan at a time');

    const done = await wait(id);
    assert.equal(done.status, 'succeeded', JSON.stringify(done));
    assert.match(done.artifact, /^nightly-\d{8}-\d{6}\.ovbk\.tar$/);
    assert.ok(done.sizeBytes > 0);
    assert.ok(existsSync(join(fx.backupsDir, 'nightly', done.artifact)));
    assert.ok(s3.keys().includes(`vps1/nightly/${done.artifact}`));
    assert.ok(s3.keys().includes(`vps1/nightly/${done.artifact}.json`));
    const dump = fx.mongoCalls().find((x) => x.tool === 'mongodump')!;
    assert.ok(!dump.args.join(' ').includes('hunter2secret'));

    r = await c.get('/api/backups');
    const p = r.json.plans[0];
    assert.equal(p.lastBackup.status, 'succeeded');
    assert.ok(p.lastSuccessAt > 0);
    assert.equal(p.running, null);
    assert.ok(!r.text.includes('hunter2secret') && !r.text.includes('test-secret-access-key'));
  });

  test('lists backups here and in the bucket, inspects, and verifies them', async () => {
    const done = (await c.get('/api/backups')).json.runs.find((x: any) => x.kind === 'backup');
    let r = await c.get('/api/backups/plans/nightly/artifacts');
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.local[0].name, done.artifact);
    assert.equal(r.json.remote[0].name, done.artifact);
    assert.equal(r.json.remote[0].complete, true);

    for (const where of ['local', 'remote']) {
      r = await c.get(`/api/backups/plans/nightly/inspect?where=${where}&artifact=${done.artifact}`);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.members.map((m: any) => m.kind), ['files', 'mongodb']);
      assert.equal(r.json.members[0].current.exists, true);
      assert.deepEqual(r.json.mongoSources, ['shop']);
    }
    assert.equal((await c.get('/api/backups/plans/nightly/inspect?where=local&artifact=../../etc/passwd')).status, 400);
    assert.equal((await c.get('/api/backups/plans/nightly/inspect?where=sideways&artifact=x')).status, 400);

    for (const [where, deep] of [['local', false], ['remote', false], ['remote', true]] as const) {
      r = await c.post('/api/backups/plans/nightly/verify', { where, artifact: done.artifact, deep });
      assert.equal(r.status, 200, r.text);
      const v = await wait(r.json.run.id);
      assert.equal(v.status, 'succeeded', `${where} ${deep}: ${JSON.stringify(v)}`);
    }
  });

  test('restore needs the plan name typed, then puts files back and restores MongoDB', async () => {
    const done = (await c.get('/api/backups')).json.runs.find((x: any) => x.kind === 'backup');
    const body = (over: Record<string, unknown> = {}) => ({
      where: 'remote',
      artifact: done.artifact,
      items: [{ file: 'files-hello.tar.gz', target: 'original' }, { file: 'mongodb-shop--orders.archive.gz', target: 'original' }],
      drop: true,
      confirm: 'nightly',
      ...over,
    });
    let r = await c.post('/api/backups/plans/nightly/restore', body({ confirm: 'yes' }));
    assert.equal(r.status, 400);
    assert.equal(r.json.error.code, 'confirmation_required');
    r = await c.post('/api/backups/plans/nightly/restore', body({ items: [] }));
    assert.equal(r.status, 400);
    r = await c.post('/api/backups/plans/nightly/restore', body({ items: [{ file: '../x', target: 'original' }] }));
    assert.equal(r.status, 400);

    const original = readFileSync(join(site, 'dist', 'server.js'), 'utf8');
    writeFileSync(join(site, 'dist', 'server.js'), 'BROKEN');
    r = await c.post('/api/backups/plans/nightly/restore', body());
    assert.equal(r.status, 200, r.text);
    const run = await wait(r.json.run.id);
    assert.equal(run.status, 'succeeded', JSON.stringify(run));
    assert.equal(readFileSync(join(site, 'dist', 'server.js'), 'utf8'), original);
    const restore = fx.mongoCalls().find((x) => x.tool === 'mongorestore')!;
    assert.ok(restore.args.includes('--drop'));
    assert.match(restore.cfg, /hunter2secret/);
    assert.ok(!restore.args.join(' ').includes('hunter2secret'));
  });

  test('delete a backup from the bucket and from this server', async () => {
    const done = (await c.get('/api/backups')).json.runs.find((x: any) => x.kind === 'backup');
    let r = await c.req('DELETE', `/api/backups/plans/nightly/artifacts?where=remote&artifact=${done.artifact}`);
    assert.equal(r.status, 200, r.text);
    assert.deepEqual(s3.keys(), []);
    r = await c.req('DELETE', `/api/backups/plans/nightly/artifacts?where=local&artifact=${done.artifact}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(existsSync(join(fx.backupsDir, 'nightly', done.artifact)), false);
    r = await c.req('DELETE', `/api/backups/plans/nightly/artifacts?where=local&artifact=${done.artifact}`);
    assert.equal(r.status, 404);
  });

  test('the scheduler starts plans that are due, once, and skips manual and disabled plans', async () => {
    const store = srv.app.backups.store;
    const past = Date.now() - 1000;
    store.setNextRun('nightly', past);
    assert.equal(await srv.app.backups.schedule(), 1);
    const run = store.listRuns({ plan: 'nightly', limit: 1 })[0]!;
    assert.equal(run.trigger, 'schedule');
    assert.equal(run.actor, 'scheduler');
    const after = store.getPlan('nightly')!;
    assert.ok(after.nextRunAt! > Date.now(), 'next run moved to the future');
    assert.equal(await srv.app.backups.schedule(), 0, 'not started twice');
    assert.equal((await wait(run.id)).status, 'succeeded');

    store.setNextRun('nightly', past);
    await c.req('PUT', '/api/backups/plans/nightly', plan({ enabled: false }));
    store.setNextRun('nightly', past);
    assert.equal(await srv.app.backups.schedule(), 0, 'disabled');
    await c.req('PUT', '/api/backups/plans/nightly', plan({ schedule: { kind: 'manual' } }));
    store.setNextRun('nightly', past);
    assert.equal(await srv.app.backups.schedule(), 0, 'manual');
  });

  test('a scheduled run that cannot start is recorded as failed, once', async () => {
    const store = srv.app.backups.store;
    await c.req('PUT', '/api/backups/plans/nightly', plan({ sources: [{ type: 'files', name: 'gone', path: join(fx.appsRoot, 'does-not-exist'), exclude: [] }], mongoUris: {} }));
    store.setNextRun('nightly', Date.now() - 1000);
    assert.equal(await srv.app.backups.schedule(), 0);
    const run = store.listRuns({ plan: 'nightly', limit: 1 })[0]!;
    assert.equal(run.status, 'failed');
    assert.match(run.message!, /does not exist/);
    assert.ok(store.getPlan('nightly')!.nextRunAt! > Date.now());
    await c.req('PUT', '/api/backups/plans/nightly', plan());
  });

  test('a run the agent no longer knows about is marked failed', async () => {
    const store = srv.app.backups.store;
    const run = store.createRun({ plan: 'nightly', kind: 'backup', trigger: 'manual', jobId: '0123456789abcdef', actor: 'admin' });
    const r = await c.get(`/api/backups/runs/${run.id}`);
    assert.equal(r.json.run.status, 'failed');
    assert.match(r.json.run.message, /agent restarted/);
  });

  test('destinations in use cannot be removed; plans can be deleted and history remains', async () => {
    let r = await c.req('DELETE', '/api/backups/destinations/offsite');
    assert.equal(r.status, 409);
    assert.match(r.json.error.message, /nightly/);
    r = await c.req('DELETE', '/api/backups/plans/nightly');
    assert.equal(r.status, 200, r.text);
    assert.equal((await c.get('/api/backups/plans/nightly/artifacts')).status, 404);
    assert.ok((await c.get('/api/backups')).json.runs.length > 0, 'history is kept');
    assert.equal((await c.req('DELETE', '/api/backups/destinations/offsite')).status, 200);
  });

  test('everything is in the activity log, and no secret is', async () => {
    const entries = srv.app.db.prepare('SELECT action, actor, details FROM audit_log').all() as Array<{ action: string; actor: string; details: string | null }>;
    const actions = new Set(entries.map((e) => e.action));
    for (const a of ['backup.destination_create', 'backup.plan_create', 'backup.plan_update', 'backup.run', 'backup.restore', 'backup.verify', 'backup.delete', 'backup.finished', 'backup.plan_delete', 'backup.destination_delete']) {
      assert.ok(actions.has(a), `audit has ${a}`);
    }
    assert.ok(entries.some((e) => e.action === 'backup.run' && e.actor === 'scheduler'));
    const all = JSON.stringify(entries);
    assert.ok(!all.includes('hunter2secret') && !all.includes('test-secret-access-key'));
  });
});
