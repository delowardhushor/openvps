import { test, describe, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BackupManager, selectDoomed } from '../src/agent/backup.ts';
import { AgentError } from '../src/agent/pm2.ts';
import { firstExisting } from '../src/agent/exec.ts';
import { ARTIFACT, artifactName, nextRun, parseJobSpec, parseS3Target, type BackupJobSpec, type BackupJobView } from '../src/agent/backup-spec.ts';
import { silentLogger } from '../src/logger.ts';
import { FakeS3 } from './fake-s3.ts';

const FIX = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const MONGO_LOG = join(mkdtempSync(join(tmpdir(), 'openvps-fake-mongo-')), 'calls.log');
const TAR = firstExisting(['/usr/bin/tar', '/bin/tar']);
const URI = 'mongodb://admin:hunter2secret@db.internal:27017/?authSource=admin';

function mongoCalls(): Array<{ tool: string; args: string[]; cfg: string; archive?: string }> {
  return existsSync(MONGO_LOG) ? readFileSync(MONGO_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
}

async function finish(m: BackupManager, v: BackupJobView): Promise<BackupJobView> {
  for (let i = 0; i < 400; i++) {
    const j = m.job(v.id);
    if (j.status !== 'running') return j;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job did not finish');
}

describe('backup engine', { skip: TAR ? false : 'tar not installed' }, () => {
  let root: string; // temp tree
  let apps: string;
  let dir: string; // backup dir
  let m: BackupManager;
  let clock: number;
  let s3: FakeS3;

  const spec = (over: Partial<BackupJobSpec> = {}): BackupJobSpec => ({
    plan: 'nightly',
    sources: [{ type: 'files', name: 'site', path: join(apps, 'site'), exclude: ['node_modules'] }],
    mongoUris: {},
    local: true,
    s3: null,
    retention: { keepLast: 7, maxAgeDays: null },
    ...over,
  });
  const run = async (s: BackupJobSpec) => finish(m, m.startBackup(parseJobSpec(s)));

  let mongodump: string;
  let mongorestore: string;
  before(async () => {
    s3 = await new FakeS3().start();
    // The agent runs tools with a minimal PATH, so the fakes call node by absolute path.
    const bin = mkdtempSync(join(tmpdir(), 'openvps-fake-bin-'));
    const wrap = (name: string) => {
      const file = join(bin, name);
      writeFileSync(file, `#!/bin/sh\nFAKE_MONGO_LOG="${MONGO_LOG}" exec "${process.execPath}" "${join(FIX, `fake-${name}.mjs`)}" "$@"\n`);
      chmodSync(file, 0o755);
      return file;
    };
    mongodump = wrap('mongodump');
    mongorestore = wrap('mongorestore');
  });
  after(() => s3.close());

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'openvps-backup-'));
    apps = join(root, 'apps');
    dir = join(root, 'backups');
    mkdirSync(join(apps, 'site', 'node_modules', 'dep'), { recursive: true });
    mkdirSync(join(apps, 'site', 'public'), { recursive: true });
    writeFileSync(join(apps, 'site', 'index.js'), 'console.log("v1")');
    writeFileSync(join(apps, 'site', 'public', 'logo.txt'), 'logo');
    writeFileSync(join(apps, 'site', 'node_modules', 'dep', 'big.js'), 'x'.repeat(1000));
    clock = Date.UTC(2026, 0, 10, 3, 0, 0);
    rmSync(MONGO_LOG, { force: true });
    s3.objects.clear();
    m = new BackupManager({
      dir,
      fileRoots: [apps],
      tarBin: TAR,
      mongodumpBin: mongodump,
      mongorestoreBin: mongorestore,
      version: 'test',
      hostname: 'vps-test',
      log: silentLogger,
      now: () => new Date((clock += 60_000)),
    });
  });

  test('backs up a folder: artifact, manifest, checksums, exclusions, clean staging', async () => {
    const j = await run(spec());
    assert.equal(j.status, 'succeeded', JSON.stringify(j));
    const res = j.result as any;
    assert.match(res.artifact, ARTIFACT);
    const file = join(dir, 'nightly', res.artifact);
    assert.ok(existsSync(file) && existsSync(`${file}.json`));
    const sidecar = JSON.parse(readFileSync(`${file}.json`, 'utf8'));
    assert.equal(sidecar.artifactSha256, res.sha256);
    assert.equal(sidecar.members.length, 1);
    assert.equal(sidecar.members[0].file, 'files-site.tar.gz');
    assert.equal(sidecar.hostname, 'vps-test');

    const outer = execFileSync(TAR!, ['-tf', file]).toString();
    assert.match(outer, /manifest\.json/);
    assert.match(outer, /files-site\.tar\.gz/);
    const x = join(root, 'x');
    mkdirSync(x);
    execFileSync(TAR!, ['-xf', file, '-C', x, 'files-site.tar.gz']);
    const inner = execFileSync(TAR!, ['-tzf', join(x, 'files-site.tar.gz')]).toString();
    assert.match(inner, /index\.js/);
    assert.match(inner, /logo\.txt/);
    assert.doesNotMatch(inner, /node_modules/);
    assert.deepEqual(readdirSync(join(dir, '.staging')), [], 'staging is cleaned up');
  });

  test('refuses sources outside the backup roots, missing folders and missing tools', () => {
    for (const path of ['/etc', join(root, 'elsewhere'), join(apps, 'nope')]) {
      assert.throws(() => m.startBackup(parseJobSpec(spec({ sources: [{ type: 'files', name: 'x', path, exclude: [] }] }))), (e: unknown) => e instanceof AgentError && e.code === 'invalid');
    }
    // A symlink inside the root that points outside it is not a way out.
    mkdirSync(join(root, 'secret'));
    symlinkSync(join(root, 'secret'), join(apps, 'link'));
    assert.throws(() => m.startBackup(parseJobSpec(spec({ sources: [{ type: 'files', name: 'x', path: join(apps, 'link'), exclude: [] }] }))), (e: unknown) => e instanceof AgentError && e.code === 'invalid');

    const noMongo = new BackupManager({ ...m.o, mongodumpBin: null });
    assert.throws(
      () => noMongo.startBackup(parseJobSpec(spec({ sources: [{ type: 'mongodb', name: 'db', databases: [] }], mongoUris: { db: URI } }))),
      (e: unknown) => e instanceof AgentError && e.code === 'tool_missing',
    );
  });

  test('only one task runs at a time', async () => {
    const first = m.startBackup(parseJobSpec(spec()));
    assert.throws(() => m.startBackup(parseJobSpec(spec())), (e: unknown) => e instanceof AgentError && e.code === 'busy');
    await finish(m, first);
    assert.equal((await run(spec())).status, 'succeeded');
  });

  test('MongoDB: connection string goes through a private config file, never the command line', async () => {
    const j = await run(
      spec({
        sources: [
          { type: 'mongodb', name: 'shop', databases: ['orders', 'users'] },
          { type: 'mongodb', name: 'all', databases: [] },
        ],
        mongoUris: { shop: URI, all: URI },
      }),
    );
    assert.equal(j.status, 'succeeded', JSON.stringify(j));
    const calls = mongoCalls().filter((c) => c.tool === 'mongodump');
    assert.equal(calls.length, 3);
    for (const c of calls) {
      assert.ok(!c.args.join(' ').includes('hunter2secret'), 'password not in argv');
      assert.match(c.cfg, /uri: "mongodb:\/\/admin:hunter2secret@db\.internal/);
    }
    assert.deepEqual(calls.map((c) => (c.args.includes('--db') ? c.args[c.args.indexOf('--db') + 1] : null)), ['orders', 'users', null]);
    const members = (j.result as any).artifact;
    const sidecar = JSON.parse(readFileSync(join(dir, 'nightly', `${members}.json`), 'utf8'));
    assert.deepEqual(sidecar.members.map((x: any) => x.file), ['mongodb-shop--orders.archive.gz', 'mongodb-shop--users.archive.gz', 'mongodb-all.archive.gz']);
    assert.ok(!JSON.stringify(sidecar).includes('hunter2secret'));
    assert.ok(!readFileSync(join(dir, 'nightly', members), 'latin1').includes('hunter2secret'));
  });

  test('MongoDB failures are reported without leaking the password', async () => {
    const j = await run(spec({ sources: [{ type: 'mongodb', name: 'bad', databases: [] }], mongoUris: { bad: 'mongodb://admin:hunter2secret@failhost:27017/' } }));
    assert.equal(j.status, 'failed');
    assert.equal(j.error?.code, 'backup_failed');
    assert.doesNotMatch(JSON.stringify(j), /hunter2secret/);
    assert.deepEqual(readdirSync(join(dir, '.staging')), []);
  });

  test('restores a folder to a separate location, then over the original', async () => {
    const j = await run(spec());
    const ref = { where: 'local' as const, plan: 'nightly', name: (j.result as any).artifact };
    const info = await m.inspect(ref, null);
    assert.equal(info.members[0]!.current?.exists, true);
    assert.equal(info.members[0]!.current?.entries, 3);

    writeFileSync(join(apps, 'site', 'index.js'), 'console.log("BROKEN")');
    rmSync(join(apps, 'site', 'public'), { recursive: true });

    let r = await finish(m, m.startRestore({ ref, s3: null, items: [{ file: 'files-site.tar.gz', target: 'alternate' }], mongoUris: {}, drop: false }));
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
    const alt = (r.result as any).restored[0].target as string;
    assert.ok(alt.startsWith(join(dir, '.restores')));
    assert.equal(readFileSync(join(alt, 'index.js'), 'utf8'), 'console.log("v1")');
    assert.equal(readFileSync(join(apps, 'site', 'index.js'), 'utf8'), 'console.log("BROKEN")', 'original untouched');

    r = await finish(m, m.startRestore({ ref, s3: null, items: [{ file: 'files-site.tar.gz', target: 'original' }], mongoUris: {}, drop: false }));
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
    assert.equal(readFileSync(join(apps, 'site', 'index.js'), 'utf8'), 'console.log("v1")');
    assert.equal(readFileSync(join(apps, 'site', 'public', 'logo.txt'), 'utf8'), 'logo');
    assert.equal(existsSync(join(apps, 'site', 'node_modules')), true, 'files not in the backup are left alone');
  });

  test('restoring to the original location is refused when the recorded folder is outside the roots', async () => {
    const j = await run(spec());
    const name = (j.result as any).artifact;
    const sidecarPath = join(dir, 'nightly', `${name}.json`);
    const doc = JSON.parse(readFileSync(sidecarPath, 'utf8'));
    doc.members[0].path = '/etc/nginx';
    writeFileSync(sidecarPath, JSON.stringify(doc));
    const r = await finish(m, m.startRestore({ ref: { where: 'local', plan: 'nightly', name }, s3: null, items: [{ file: 'files-site.tar.gz', target: 'original' }], mongoUris: {}, drop: false }));
    assert.equal(r.status, 'failed');
    assert.equal(r.error?.code, 'forbidden');
  });

  test('restores MongoDB through mongorestore, optionally dropping collections', async () => {
    const j = await run(spec({ sources: [{ type: 'mongodb', name: 'shop', databases: ['orders'] }], mongoUris: { shop: URI } }));
    const ref = { where: 'local' as const, plan: 'nightly', name: (j.result as any).artifact };
    const file = 'mongodb-shop--orders.archive.gz';
    let r = await finish(m, m.startRestore({ ref, s3: null, items: [{ file, target: 'original' }], mongoUris: {}, drop: false }));
    assert.equal(r.status, 'failed');
    assert.match(r.error!.message, /No MongoDB connection/);

    r = await finish(m, m.startRestore({ ref, s3: null, items: [{ file, target: 'original' }], mongoUris: { shop: URI }, drop: true }));
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
    const call = mongoCalls().find((c) => c.tool === 'mongorestore')!;
    assert.ok(call.args.includes('--drop') && call.args.includes('--gzip'));
    assert.ok(!call.args.join(' ').includes('hunter2secret'));
    assert.equal(call.archive, 'DUMP db=orders\n');
  });

  test('detects a damaged backup before restoring anything', async () => {
    const j = await run(spec());
    const name = (j.result as any).artifact;
    const file = join(dir, 'nightly', name);
    const ref = { where: 'local' as const, plan: 'nightly', name };
    let v = await finish(m, m.startVerify(ref, null, false));
    assert.equal(v.status, 'succeeded', JSON.stringify(v));
    assert.ok((v.result as any).checks.every((c: any) => c.ok));

    const bytes = readFileSync(file);
    bytes[Math.floor(bytes.length / 2)]! ^= 0xff;
    writeFileSync(file, bytes);
    v = await finish(m, m.startVerify(ref, null, false));
    assert.equal(v.status, 'failed');
    assert.equal(v.error?.code, 'verify_failed');

    writeFileSync(join(apps, 'site', 'index.js'), 'console.log("KEEP")');
    const r = await finish(m, m.startRestore({ ref, s3: null, items: [{ file: 'files-site.tar.gz', target: 'original' }], mongoUris: {}, drop: false }));
    assert.equal(r.status, 'failed');
    assert.equal(r.error?.code, 'integrity');
    assert.equal(readFileSync(join(apps, 'site', 'index.js'), 'utf8'), 'console.log("KEEP")');
  });

  test('retention keeps the newest backups and enforces a maximum age', async () => {
    for (let i = 0; i < 5; i++) await run(spec({ retention: { keepLast: 3, maxAgeDays: null } }));
    let names = readdirSync(join(dir, 'nightly')).filter((n) => n.endsWith('.tar'));
    assert.equal(names.length, 3);
    assert.equal(readdirSync(join(dir, 'nightly')).filter((n) => n.endsWith('.json')).length, 3, 'sidecars follow');
    const newest = names.sort().at(-1)!;

    clock += 40 * 86_400_000;
    const j = await run(spec({ retention: { keepLast: 10, maxAgeDays: 30 } }));
    names = readdirSync(join(dir, 'nightly')).filter((n) => n.endsWith('.tar'));
    assert.equal(names.length, 1, 'only the fresh one is younger than 30 days');
    assert.deepEqual(names, [(j.result as any).artifact]);
    assert.notEqual(names[0], newest);
  });

  test('selectDoomed never removes the newest backup', () => {
    const names = ['pp-20260101-000000.ovbk.tar', 'pp-20260102-000000.ovbk.tar'];
    const now = Date.UTC(2027, 0, 1);
    assert.deepEqual(selectDoomed(names, { keepLast: 5, maxAgeDays: 1 }, now), ['pp-20260101-000000.ovbk.tar']);
    assert.deepEqual(selectDoomed(names, { keepLast: 1, maxAgeDays: null }, now), ['pp-20260101-000000.ovbk.tar']);
  });

  test('stores in S3 only, lists, verifies (shallow and deep), restores and deletes', async () => {
    const access = s3.access();
    const j = await run(spec({ local: false, s3: access }));
    assert.equal(j.status, 'succeeded', JSON.stringify(j));
    const name = (j.result as any).artifact;
    assert.deepEqual(s3.keys(), [`vps1/nightly/${name}`, `vps1/nightly/${name}.json`]);
    assert.equal(existsSync(join(dir, 'nightly')), false, 'nothing kept locally');
    assert.ok(!JSON.stringify(j).includes(access.secrets.secretAccessKey));

    const listing = await m.list('nightly', access);
    assert.equal(listing.local.length, 0);
    assert.deepEqual(listing.remote!.map((a) => [a.name, a.complete]), [[name, true]]);

    const ref = { where: 's3' as const, plan: 'nightly', name };
    let v = await finish(m, m.startVerify(ref, access, false));
    assert.equal(v.status, 'succeeded', JSON.stringify(v));
    v = await finish(m, m.startVerify(ref, access, true));
    assert.equal(v.status, 'succeeded', JSON.stringify(v));

    writeFileSync(join(apps, 'site', 'index.js'), 'console.log("BROKEN")');
    const r = await finish(m, m.startRestore({ ref, s3: access, items: [{ file: 'files-site.tar.gz', target: 'original' }], mongoUris: {}, drop: false }));
    assert.equal(r.status, 'succeeded', JSON.stringify(r));
    assert.equal(readFileSync(join(apps, 'site', 'index.js'), 'utf8'), 'console.log("v1")');

    await m.delete(ref, access);
    assert.deepEqual(s3.keys(), []);
  });

  test('applies retention in the bucket and flags uploads that have no manifest', async () => {
    const access = s3.access();
    for (let i = 0; i < 4; i++) await run(spec({ local: false, s3: access, retention: { keepLast: 2, maxAgeDays: null } }));
    assert.equal(s3.keys().filter((k) => k.endsWith('.tar')).length, 2);
    assert.equal(s3.keys().filter((k) => k.endsWith('.json')).length, 2);
    const orphan = `vps1/nightly/${artifactName('nightly', new Date(clock - 5_000_000))}`;
    s3.objects.set(orphan, { body: Buffer.from('x'), sha256: null, modified: 1 });
    const l = await m.list('nightly', access);
    assert.equal(l.remote!.filter((a) => !a.complete).length, 1);
  });

  test('a local copy survives a failed upload (partial), and an upload-only failure is a failure', async () => {
    const access = s3.access();
    s3.denyAll = true;
    try {
      let j = await run(spec({ local: true, s3: access }));
      assert.equal(j.status, 'partial', JSON.stringify(j));
      assert.match((j.result as any).warnings.join(' '), /Upload failed: AccessDenied/);
      assert.equal(existsSync(join(dir, 'nightly', (j.result as any).artifact)), true);
      assert.doesNotMatch(JSON.stringify(j), /test-secret-access-key/);

      j = await run(spec({ local: false, s3: access }));
      assert.equal(j.status, 'failed');
      assert.equal(j.error?.code, 'backup_failed');
    } finally {
      s3.denyAll = false;
    }
  });

  test('tests the storage connection and cleans up after itself', async () => {
    const r = await m.testS3(s3.access());
    assert.equal(r.ok, true);
    assert.deepEqual(s3.keys(), []);
    s3.denyAll = true;
    try {
      await assert.rejects(m.testS3(s3.access()), (e: unknown) => e instanceof AgentError && e.code === 's3_failed' && /AccessDenied/.test(e.message));
    } finally {
      s3.denyAll = false;
    }
  });

  test('status reports tools and space; unknown jobs are not_found', async () => {
    const s = await m.status();
    assert.equal(s.tar, true);
    assert.match(s.mongodump!.version!, /100\.9/);
    assert.deepEqual(s.fileRoots, [apps]);
    assert.ok((s.freeBytes ?? 0) > 0);
    assert.throws(() => m.job('0123456789abcdef'), (e: unknown) => e instanceof AgentError && e.code === 'not_found');
  });
});

describe('backup specs', () => {
  test('schedules fire at the next matching local time', () => {
    const from = new Date(2026, 0, 14, 10, 30, 15); // Wednesday
    assert.equal(nextRun({ kind: 'manual' }, from), null);
    assert.deepEqual(nextRun({ kind: 'hourly', minute: 45 }, from), new Date(2026, 0, 14, 10, 45));
    assert.deepEqual(nextRun({ kind: 'hourly', minute: 15 }, from), new Date(2026, 0, 14, 11, 15));
    assert.deepEqual(nextRun({ kind: 'daily', hour: 3, minute: 0 }, from), new Date(2026, 0, 15, 3, 0));
    assert.deepEqual(nextRun({ kind: 'daily', hour: 23, minute: 30 }, from), new Date(2026, 0, 14, 23, 30));
    assert.deepEqual(nextRun({ kind: 'weekly', weekday: 0, hour: 2, minute: 0 }, from), new Date(2026, 0, 18, 2, 0));
    assert.deepEqual(nextRun({ kind: 'weekly', weekday: 3, hour: 10, minute: 30 }, from), new Date(2026, 0, 21, 10, 30), 'same minute already passed → next week');
  });

  test('storage targets are validated', () => {
    const ok = parseS3Target({ endpoint: 'https://s3.eu-central-1.amazonaws.com/', region: 'eu-central-1', bucket: 'my-backups', prefix: '/vps/1', pathStyle: false });
    assert.equal(ok.endpoint, 'https://s3.eu-central-1.amazonaws.com');
    assert.equal(ok.prefix, 'vps/1/');
    const good = parseS3Target({ endpoint: 'https://s3.example.com', bucket: 'my-backups', prefix: 'vps/one', pathStyle: true });
    assert.equal(good.prefix, 'vps/one/');
    assert.equal(good.region, 'us-east-1');
    for (const bad of [
      { endpoint: 'http://s3.example.com', bucket: 'abc' },
      { endpoint: 'ftp://s3.example.com', bucket: 'abc' },
      { endpoint: 'https://user:pw@s3.example.com', bucket: 'abc' },
      { endpoint: 'https://s3.example.com/x', bucket: 'abc' },
      { endpoint: 'https://s3.example.com', bucket: 'A_B' },
      { endpoint: 'https://s3.example.com', bucket: 'abc', prefix: '../x' },
    ]) {
      assert.throws(() => parseS3Target({ pathStyle: true, ...bad }), bad.endpoint + (bad.prefix ?? ''));
    }
    assert.equal(parseS3Target({ endpoint: 'http://192.168.1.5:9000', bucket: 'abc', pathStyle: true }).endpoint, 'http://192.168.1.5:9000');
    assert.equal(parseS3Target({ endpoint: 'http://minio:9000', bucket: 'abc', pathStyle: true }).endpoint, 'http://minio:9000');
  });

  test('job specs need a destination, unique source names and a connection string per MongoDB source', () => {
    const base = { plan: 'nightly', sources: [{ type: 'files', name: 'a', path: '/srv/apps/a', exclude: [] }], local: true, retention: { keepLast: 7, maxAgeDays: null } };
    assert.ok(parseJobSpec(base));
    assert.throws(() => parseJobSpec({ ...base, local: false }), /where to keep/);
    assert.throws(() => parseJobSpec({ ...base, sources: [...base.sources, ...base.sources] }), /Two sources/);
    assert.throws(() => parseJobSpec({ ...base, sources: [{ type: 'files', name: 'a', path: '/srv/apps/../etc', exclude: [] }] }));
    assert.throws(() => parseJobSpec({ ...base, sources: [{ type: 'mongodb', name: 'db', databases: [] }] }), /connection string/);
    assert.throws(() => parseJobSpec({ ...base, sources: [{ type: 'files', name: 'a', path: '/srv/apps/a', exclude: ['--use-compress-program=x y'] }] }));
  });
});
