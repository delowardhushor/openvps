import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkPasswordPolicy, hashPassword, needsRehash, verifyPassword } from '../src/auth/password.ts';
import { RateLimiter } from '../src/auth/ratelimit.ts';
import { Sessions } from '../src/auth/sessions.ts';
import { Users } from '../src/auth/users.ts';
import { Audit } from '../src/audit.ts';
import { migrate, openMemoryDb, currentSchemaVersion } from '../src/db/index.ts';
import { loadConfig, ConfigError } from '../src/config.ts';
import { redact, REDACTED } from '../src/redact.ts';
import {
  cpuPercent,
  parseLoadavg,
  parseMeminfo,
  parseMounts,
  parseNetDev,
  parseOsRelease,
  parseProcStat,
  parseUptime,
} from '../src/metrics/proc.ts';
import { MetricsCollector, hostInfo, type Sources } from '../src/metrics/collector.ts';
import { serviceStatus } from '../src/system/services.ts';
import { runAllowed } from '../src/system/exec.ts';
import { fakeRunner } from './helpers.ts';

const fx = (name: string) => readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8');

describe('password hashing', () => {
  test('hashes verify and reject wrong passwords', async () => {
    const h = await hashPassword('s3cret-passphrase!');
    assert.match(h, /^scrypt\$15\$8\$1\$/);
    assert.equal(await verifyPassword('s3cret-passphrase!', h), true);
    assert.equal(await verifyPassword('s3cret-passphrasE!', h), false);
    assert.equal(needsRehash(h), false);
  });

  test('salts are unique', async () => {
    assert.notEqual(await hashPassword('same'), await hashPassword('same'));
  });

  test('malformed hashes never verify', async () => {
    for (const bad of ['', 'plain', 'scrypt$15$8$1$$', 'bcrypt$x', 'scrypt$99$8$1$AAAAAAAAAAA=$AAAA']) {
      assert.equal(await verifyPassword('x', bad), false);
    }
  });

  test('weaker parameters are flagged for rehash', async () => {
    const weak = await hashPassword('pw', { log2N: 10, r: 8, p: 1, keyLen: 64, saltLen: 16 });
    assert.equal(await verifyPassword('pw', weak), true);
    assert.equal(needsRehash(weak), true);
  });

  test('policy', () => {
    assert.equal(checkPasswordPolicy('short', 'admin', 12).ok, false);
    assert.equal(checkPasswordPolicy('myadminpassword', 'admin', 12).ok, false);
    assert.equal(checkPasswordPolicy('aaaaaaaaaaaaaaa', 'bob', 12).ok, false);
    assert.equal(checkPasswordPolicy('password1234', 'bob', 12).ok, false);
    assert.equal(checkPasswordPolicy('correct horse battery', 'admin', 12).ok, true);
  });
});

describe('rate limiter', () => {
  test('blocks after limit and resets after window', () => {
    const rl = new RateLimiter(3, 1000);
    assert.equal(rl.hit('a', 0).allowed, true);
    rl.hit('a', 1);
    assert.equal(rl.hit('a', 2).allowed, true);
    const blocked = rl.hit('a', 3);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, 997);
    assert.equal(rl.hit('b', 3).allowed, true, 'keys are independent');
    assert.equal(rl.hit('a', 1001).allowed, true);
  });
});

describe('database', () => {
  test('migrations apply once and are idempotent', () => {
    const db = openMemoryDb();
    const r1 = migrate(db);
    assert.deepEqual(r1.applied, [1]);
    const r2 = migrate(db);
    assert.deepEqual(r2.applied, []);
    assert.equal(currentSchemaVersion(db), 1);
  });

  test('refuses a database newer than the build', () => {
    const db = openMemoryDb();
    migrate(db);
    db.prepare('INSERT INTO schema_migrations VALUES (99, ?, ?)').run('future', Date.now());
    assert.throws(() => migrate(db), /newer than this OpenVPS build/);
  });

  test('failed migration rolls back completely', () => {
    const db = openMemoryDb();
    migrate(db);
    assert.throws(() =>
      migrate(db, [
        { version: 1, name: 'initial', sql: '' },
        { version: 2, name: 'broken', sql: 'CREATE TABLE t2 (x); THIS IS NOT SQL;' },
      ]),
    );
    assert.equal(currentSchemaVersion(db), 1);
    assert.equal(db.prepare("SELECT name FROM sqlite_master WHERE name = 't2'").get(), undefined);
  });
});

describe('sessions', () => {
  test('idle and absolute expiry, hashed storage', () => {
    const db = openMemoryDb();
    migrate(db);
    const u = new Users(db).create('alice', 'x');
    const s = new Sessions(db, { idleMs: 1000, absoluteMs: 5000 });
    const { token, row } = s.create(u.id, '1.2.3.4', 'ua');
    assert.notEqual(row.id, token, 'stores hash, not token');
    assert.equal(db.prepare('SELECT COUNT(*) n FROM sessions WHERE id = ?').get(token)!.n, 0);
    assert.ok(s.validate(token, row.created_at + 500));
    assert.equal(s.validate(token, row.created_at + 1500), null, 'idle timeout');

    const b = s.create(u.id, null, null);
    // Keep it alive with activity, but absolute lifetime still wins.
    let t = b.row.created_at;
    for (let i = 0; i < 10; i++) {
      t += 900;
      const v = s.validate(b.token, t);
      if (t < b.row.expires_at) {
        assert.ok(v, `alive at ${t - b.row.created_at}ms`);
        db.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').run(t, b.row.id);
      } else assert.equal(v, null, 'absolute timeout');
    }
    assert.equal(s.validate('garbage'), null);
    assert.equal(s.validate(undefined), null);
  });
});

describe('users', () => {
  test('lockout after max failures', () => {
    const db = openMemoryDb();
    migrate(db);
    const users = new Users(db);
    const u = users.create('Bob', 'h');
    assert.ok(users.byUsername('bob'), 'usernames are case-insensitive');
    for (let i = 0; i < 2; i++) assert.equal(users.recordFailure(u.id, 3, 60_000).locked, false);
    assert.equal(users.recordFailure(u.id, 3, 60_000).locked, true);
    assert.equal(users.isLocked(users.byId(u.id)!), true);
    users.unlock(u.id);
    assert.equal(users.isLocked(users.byId(u.id)!), false);
  });
});

describe('redaction and audit', () => {
  test('redacts sensitive keys recursively and private keys in values', () => {
    const out = redact({
      password: 'x',
      nested: { apiKey: 'k', ok: 1, list: [{ token: 't' }] },
      Authorization: 'Bearer y',
      pem: '-----BEGIN RSA PRIVATE KEY-----\nabc',
      revokedCount: 3,
    }) as any;
    assert.equal(out.password, REDACTED);
    assert.equal(out.nested.apiKey, REDACTED);
    assert.equal(out.nested.ok, 1);
    assert.equal(out.nested.list[0].token, REDACTED);
    assert.equal(out.Authorization, REDACTED);
    assert.equal(out.pem, REDACTED);
    assert.equal(out.revokedCount, 3);
  });

  test('audit stores redacted details and filters', () => {
    const db = openMemoryDb();
    migrate(db);
    const a = new Audit(db);
    a.record({ action: 'auth.login', outcome: 'failure', details: { password: 'hunter2', reason: 'bad' } });
    a.record({ action: 'setup.admin_create', outcome: 'success' });
    const all = a.list();
    assert.equal(all.length, 2);
    assert.equal(all[0]!.action, 'setup.admin_create', 'newest first');
    assert.equal(all[1]!.details!.password, REDACTED);
    assert.equal(a.list({ outcome: 'failure' }).length, 1);
    assert.equal(a.list({ actionPrefix: 'auth.' }).length, 1);
    assert.equal(a.list({ actionPrefix: '%' }).length, 0, 'LIKE wildcards are escaped');
    assert.throws(() => a.record({ action: 'Bad Action', outcome: 'info' }));
  });
});

describe('config', () => {
  test('defaults and env overrides', () => {
    const c = loadConfig({ OPENVPS_DEV: '1', OPENVPS_PORT: '9000', OPENVPS_DATA_DIR: '/tmp/x' });
    assert.equal(c.listen.port, 9000);
    assert.equal(c.listen.host, '127.0.0.1');
    assert.equal(c.tls.enabled, false);
    assert.equal(c.dataDir, '/tmp/x');
  });
  test('production defaults are TLS on 7443', () => {
    const c = loadConfig({ OPENVPS_CONFIG: undefined }, {});
    assert.equal(c.tls.enabled, true);
    assert.equal(c.listen.port, 7443);
  });
  test('rejects unknown keys and bad values', () => {
    assert.throws(() => loadConfig({ OPENVPS_DEV: '1' }, { nope: 1 }), ConfigError);
    assert.throws(() => loadConfig({ OPENVPS_DEV: '1' }, { listen: { port: 70000 } }), ConfigError);
    assert.throws(() => loadConfig({ OPENVPS_DEV: '1' }, { services: ['nginx; rm -rf /'] }), ConfigError);
    assert.throws(() => loadConfig({ OPENVPS_CONFIG: '/does/not/exist.json' }), ConfigError);
  });
});

describe('/proc parsers', () => {
  test('stat', () => {
    const s = parseProcStat(fx('stat.txt'));
    assert.ok(s.total.total > 0);
    assert.ok(s.cores.length >= 1);
    const a = parseProcStat('cpu  100 0 100 800 0 0 0 0 0 0\n');
    const b = parseProcStat('cpu  150 0 150 900 0 0 0 0 0 0\n');
    assert.equal(cpuPercent(a.total, b.total), 50);
    assert.equal(cpuPercent(b.total, b.total), 0);
  });
  test('meminfo', () => {
    const m = parseMeminfo(fx('meminfo.txt'));
    assert.ok(m.totalBytes > 0 && m.availableBytes > 0 && m.usedBytes >= 0);
    const legacy = parseMeminfo('MemTotal: 1000 kB\nMemFree: 200 kB\nBuffers: 100 kB\nCached: 300 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB');
    assert.equal(legacy.availableBytes, 600 * 1024, 'estimates MemAvailable on old kernels');
  });
  test('loadavg, uptime', () => {
    assert.deepEqual(parseLoadavg('0.52 0.58 0.59 1/389 12345\n'), [0.52, 0.58, 0.59]);
    assert.equal(parseUptime('350735.47 234388.90\n'), 350735);
  });
  test('net/dev skips loopback and virtual interfaces', () => {
    const text = `Inter-|   Receive                                                |  Transmit
 face |bytes    packets errs drop fifo frame compressed multicast|bytes    packets errs drop fifo colls carrier compressed
    lo: 1000 10 0 0 0 0 0 0 1000 10 0 0 0 0 0 0
  eth0: 5000 50 0 0 0 0 0 0 7000 70 0 0 0 0 0 0
docker0: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0
vethab12: 1 1 0 0 0 0 0 0 1 1 0 0 0 0 0 0`;
    assert.deepEqual(parseNetDev(text), [{ iface: 'eth0', rxBytes: 5000, txBytes: 7000 }]);
    assert.ok(parseNetDev(fx('netdev.txt')).length >= 1);
  });
  test('mounts keep real filesystems once and decode escapes', () => {
    const m = parseMounts(fx('mounts.txt'));
    assert.deepEqual(
      m.map((x) => x.mountpoint),
      ['/', '/mnt/data disk'],
    );
  });
  test('os-release', () => {
    const r = parseOsRelease('NAME="Ubuntu"\nVERSION_ID="24.04"\nID=ubuntu\nPRETTY_NAME="Ubuntu 24.04.1 LTS"\n# c\n');
    assert.equal(r.ID, 'ubuntu');
    assert.equal(r.VERSION_ID, '24.04');
    assert.ok(parseOsRelease(fx('os-release.txt')).ID);
  });
});

describe('metrics collector', () => {
  const makeSources = (state: { stat: string; net: string }): Sources => ({
    read: async (p) =>
      ({
        '/proc/stat': state.stat,
        '/proc/meminfo': 'MemTotal: 2000000 kB\nMemFree: 500000 kB\nMemAvailable: 1000000 kB\nBuffers: 0 kB\nCached: 0 kB\nSwapTotal: 0 kB\nSwapFree: 0 kB\n',
        '/proc/loadavg': '1.00 0.50 0.25 1/100 1\n',
        '/proc/uptime': '3600.5 100\n',
        '/proc/net/dev': state.net,
        '/proc/mounts': '/dev/sda1 / ext4 rw 0 0\n',
        '/etc/os-release': 'ID=ubuntu\nVERSION_ID="22.04"\nPRETTY_NAME="Ubuntu 22.04 LTS"\n',
      })[p] ?? Promise.reject(new Error('ENOENT ' + p)),
    statfs: async () => ({ blocks: 1000, bsize: 4096, bfree: 400, bavail: 350 }),
  });
  const net = (rx: number, tx: number) => `h1\nh2\n  eth0: ${rx} 0 0 0 0 0 0 0 ${tx} 0 0 0 0 0 0 0\n`;

  test('computes deltas, rates and a bounded history', async () => {
    const state = { stat: 'cpu  100 0 100 800 0 0 0 0 0 0\ncpu0 100 0 100 800 0 0 0 0 0 0\n', net: net(0, 0) };
    const c = new MetricsCollector({ intervalSeconds: 30, historyMinutes: 1, sources: makeSources(state), linux: true });
    const first = await c.sample(1_000);
    assert.equal(first!.cpu.percent, 0, 'first sample has no delta');
    state.stat = 'cpu  175 0 175 850 0 0 0 0 0 0\ncpu0 175 0 175 850 0 0 0 0 0 0\n';
    state.net = net(10_000, 4_000);
    const s = (await c.sample(3_000))!;
    assert.equal(s.cpu.percent, 75);
    assert.equal(s.cpu.cores[0], 75);
    assert.equal(s.memory.usedPercent, 50);
    assert.equal(s.network!.rxBytesPerSec, 5_000);
    assert.equal(s.network!.txBytesPerSec, 2_000);
    assert.equal(s.uptimeSeconds, 3600);
    assert.equal(s.disks[0]!.usedPercent, 63.2); // 600 used / (600 + 350)
    await c.sample(5_000);
    assert.equal(c.history().length, 2, 'history capped at historyMinutes / interval');
  });

  test('records errors without throwing', async () => {
    const c = new MetricsCollector({
      intervalSeconds: 5,
      historyMinutes: 1,
      linux: true,
      sources: { read: async () => { throw new Error('boom'); }, statfs: async () => { throw new Error('x'); } },
    });
    assert.equal(await c.sample(), null);
    assert.equal(c.lastError, 'boom');
  });

  test('host info flags unsupported OS versions', async () => {
    const h = await hostInfo(makeSources({ stat: '', net: '' }));
    assert.equal(h.supported, false);
    assert.match(h.supportNote!, /not a supported OS/);
  });
});

describe('services and exec', () => {
  test('parses systemctl show output', async () => {
    const s = await serviceStatus(fakeRunner, ['nginx', 'ufw', 'cron', 'bad;name']);
    assert.deepEqual(s, [
      { name: 'nginx', state: 'active', enabled: true },
      { name: 'ufw', state: 'not-installed', enabled: null },
      { name: 'cron', state: 'failed', enabled: false },
    ]);
  });
  test('exec refuses unlisted programs and unsafe arguments', async () => {
    await assert.rejects(runAllowed('bash' as any, ['-c', 'id']), /not allowed/);
    await assert.rejects(runAllowed('systemctl', ['status', 'x;id']), /Unsafe argument/);
    await assert.rejects(runAllowed('systemctl', ['$(id)']), /Unsafe argument/);
  });
});
