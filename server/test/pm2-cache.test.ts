import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pm2Target } from '../src/agent/pm2.ts';

const FAKE_PM2 = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-pm2.mjs');

describe('pm2 list cache', () => {
  let dir: string;
  let home: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'openvps-pm2cache-'));
    home = join(dir, '.pm2');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'pm2.pid'), String(process.pid));
    const proc = { id: 0, name: 'web', status: 'online', pid: 4242, started: Date.now() - 1000, restarts: 0, mode: 'fork', script: '/srv/apps/web/index.js', cwd: '/srv/apps/web', interpreter: 'node', out: join(home, 'logs', 'web-out.log'), err: join(home, 'logs', 'web-err.log'), env: {} };
    writeFileSync(join(home, 'state.json'), JSON.stringify({ procs: [proc], nextId: 1, calls: [] }));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const target = (listCacheMs: number) =>
    new Pm2Target({ owner: 'apps', bin: FAKE_PM2, node: process.execPath, pm2Home: home, userHome: dir, runAs: null, pathDirs: [], logOwnerUid: null, listCacheMs });

  const jlistRuns = () => (JSON.parse(readFileSync(join(home, 'state.json'), 'utf8')) as { calls: string[] }).calls.filter((c) => c === 'jlist').length;

  test('without a cache every listing starts PM2', async () => {
    const t = target(0);
    await t.list();
    await t.list();
    await t.find('web');
    assert.equal(jlistRuns(), 3);
  });

  test('a cached listing is reused', async () => {
    const t = target(60_000);
    const a = await t.list();
    const b = await t.list();
    assert.equal(await t.find('web').then((p) => p?.status), 'online');
    assert.deepEqual(a, b);
    assert.equal(jlistRuns(), 1);
  });

  test('concurrent callers share one run', async () => {
    const t = target(60_000);
    const all = await Promise.all([t.list(), t.list(), t.list(), t.find('web')]);
    assert.equal(all[0].length, 1);
    assert.equal(jlistRuns(), 1);
  });

  test('fresh bypasses the cache', async () => {
    const t = target(60_000);
    await t.list();
    await t.list({ fresh: true });
    assert.equal(jlistRuns(), 2);
  });

  test('a change drops the cache so the next read sees it', async () => {
    const t = target(60_000);
    assert.equal((await t.find('web'))?.status, 'online');
    const after = await t.control('web', 'stop');
    assert.equal(after.status, 'stopped');
    assert.equal((await t.find('web'))?.status, 'stopped');
  });

  test('an old result is not reused after the cache time passes', async () => {
    const t = target(30);
    await t.list();
    await new Promise((r) => setTimeout(r, 60));
    await t.list();
    assert.equal(jlistRuns(), 2);
  });

  test('log paths may come from an older listing', async () => {
    const t = target(1); // short default, logs accept up to 30 s
    mkdirSync(join(home, 'logs'), { recursive: true });
    writeFileSync(join(home, 'logs', 'web-out.log'), 'one\ntwo\n');
    await t.logs('web', 'out', 10);
    await new Promise((r) => setTimeout(r, 20));
    const l = await t.logs('web', 'out', 10);
    assert.deepEqual(l.lines, ['one', 'two']);
    assert.equal(jlistRuns(), 1);
  });
});
