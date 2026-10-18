import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:net';
import { AgentClient, AgentCallError, AgentUnavailableError } from '../src/agent-client.ts';
import { helloSpec, startAgentFixture, type AgentFixture } from './agent-fixture.ts';
import { normalize, parseJlist, tailFile } from '../src/agent/pm2.ts';
import { parseAppSpec, parseEnv, parseRequest, SpecError, type AppSpec, type AgentInfo, type ProcessInfo } from '../src/agent/spec.ts';

function rawSend(path: string, payload: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const s = connect(path);
    let buf = '';
    s.on('connect', () => s.write(payload));
    s.on('data', (d) => (buf += d));
    s.on('end', () => resolve(buf));
    s.on('error', reject);
  });
}

describe('protocol validation', () => {
  test('only allowlisted actions', () => {
    assert.throws(() => parseRequest({ action: 'exec', params: { cmd: 'id' } }), SpecError);
    assert.throws(() => parseRequest({ action: 'pm2.control', params: { owner: 'root', name: 'x', op: 'kill' } }), SpecError);
    assert.throws(() => parseRequest({ action: 'pm2.list', params: { owner: 'admin' } }), SpecError);
    assert.throws(() => parseRequest({ action: 'pm2.control', params: { owner: 'root', name: 'a;rm -rf /', op: 'stop' } }), SpecError);
    assert.throws(() => parseRequest({ action: 'app.remove', params: { name: '../etc' } }), SpecError);
    assert.deepEqual(parseRequest({ action: 'pm2.logs', params: { owner: 'apps', name: 'x', stream: 'out', lines: 999999 } }).params, {
      owner: 'apps', name: 'x', stream: 'out', lines: 2000,
    });
  });

  test('app spec rules', () => {
    const base = helloSpec('/srv/apps');
    assert.equal(parseAppSpec(base).name, 'hello');
    const bad = (o: Partial<AppSpec> & Record<string, unknown>, field: string) =>
      assert.throws(() => parseAppSpec({ ...base, ...o }), (e: unknown) => e instanceof SpecError && e.field === field);
    bad({ name: 'Hello' }, 'name');
    bad({ name: 'a' }, 'name');
    bad({ cwd: 'relative/dir' }, 'cwd');
    bad({ script: '../../etc/passwd' }, 'script');
    bad({ script: '/abs/server.js' }, 'script');
    bad({ startType: 'shell' as never }, 'startType');
    bad({ args: Array(21).fill('x') }, 'args');
    bad({ instances: 4 }, 'instances'); // fork with >1 instance
    bad({ execMode: 'cluster', startType: 'npm', script: null, npmScript: 'start' }, 'execMode');
    bad({ maxMemoryMb: 1 }, 'maxMemoryMb');
    bad({ startType: 'npm', script: null, npmScript: 'start; rm -rf /' }, 'npmScript');
  });

  test('env rules', () => {
    assert.deepEqual(parseEnv({ PORT: '3000', DATABASE_URL: 'mongodb://x' }), { PORT: '3000', DATABASE_URL: 'mongodb://x' });
    assert.throws(() => parseEnv({ 'BAD-KEY': 'x' }), SpecError);
    assert.throws(() => parseEnv({ PM2_HOME: '/tmp' }), SpecError);
    assert.throws(() => parseEnv({ HOME: '/root' }), SpecError);
    assert.throws(() => parseEnv({ X: 1 }), SpecError);
    assert.throws(() => parseEnv({ X: 'a'.repeat(9000) }), SpecError);
  });
});

describe('pm2 output handling', () => {
  test('parses jlist after warnings and strips env', () => {
    const raw = parseJlist('>>>> In-memory PM2 is out-of-date\n[{"name":"a","pid":5,"monit":{"cpu":2,"memory":10},"pm2_env":{"status":"online","exec_mode":"fork_mode","env":{"SECRET":"x"},"pm_uptime":100}}]\n');
    const n = normalize(raw, 'root');
    assert.equal(n[0]!.status, 'online');
    assert.ok(!JSON.stringify(n).includes('SECRET'));
  });

  test('cluster instances are grouped and the worst status wins', () => {
    const inst = (status: string, cpu: number) => ({ name: 'api', pid: 1, monit: { cpu, memory: 100 }, pm2_env: { status, exec_mode: 'cluster_mode', restart_time: 1, pm_uptime: 5 } });
    const n = normalize([inst('online', 1), inst('errored', 2), inst('online', 3)], 'apps');
    assert.equal(n.length, 1);
    assert.equal(n[0]!.instances, 3);
    assert.equal(n[0]!.status, 'errored');
    assert.equal(n[0]!.cpu, 6);
    assert.equal(n[0]!.memoryBytes, 300);
    assert.equal(n[0]!.restarts, 3);
    assert.equal(n[0]!.execMode, 'cluster');
  });

  test('tailFile refuses symlinks and foreign owners, reads the end only', async () => {
    const d = mkdtempSync(join(tmpdir(), 'tail-'));
    const f = join(d, 'out.log');
    writeFileSync(f, Array.from({ length: 1000 }, (_, i) => `line ${i}`).join('\n') + '\n');
    assert.deepEqual(await tailFile(f, 2, null), ['line 998', 'line 999']);
    const small = await tailFile(f, 5, null, 30);
    assert.ok(small.length <= 5 && small.at(-1) === 'line 999');
    symlinkSync('/etc/passwd', join(d, 'evil.log'));
    await assert.rejects(tailFile(join(d, 'evil.log'), 5, null), /symbolic link/);
    await assert.rejects(tailFile(f, 5, statSync(f).uid + 1), /not owned/);
    assert.deepEqual(await tailFile(join(d, 'missing.log'), 5, null), []);
  });
});

describe('agent over its socket', () => {
  let fx: AgentFixture;
  before(async () => {
    fx = await startAgentFixture();
  });
  after(async () => fx.close());

  test('rejects garbage and unknown actions', async () => {
    assert.match(await rawSend(fx.socket, 'not json\n'), /"code":"invalid"/);
    assert.match(await rawSend(fx.socket, '{"action":"shell","params":{"cmd":"id"}}\n'), /Unknown action/);
    assert.match(await rawSend(fx.socket, 'x'.repeat(300 * 1024)), /too_large/);
  });

  test('info reports both PM2s and runnable runtimes', async () => {
    const info = await fx.client.call<AgentInfo>({ action: 'agent.info' });
    assert.equal(info.root.available, true);
    assert.equal(info.root.manage, true);
    assert.equal(info.apps.available, true);
    assert.deepEqual(info.runtimes.map((r) => r.path), [process.execPath], 'missing candidates are skipped');
    assert.match(info.runtimes[0]!.version, /^v\d+/);
  });

  test("lists root's existing processes without leaking env", async () => {
    const r = await fx.client.call<{ processes: ProcessInfo[] }>({ action: 'pm2.list', params: { owner: 'root' } });
    assert.equal(r.processes.length, 1);
    assert.equal(r.processes[0]!.name, 'legacy-api');
    assert.equal(r.processes[0]!.restarts, 2);
    const text = JSON.stringify(r);
    for (const secret of ['root-secret', 'must-never-leave-the-agent', 'also-secret']) assert.ok(!text.includes(secret), secret);
  });

  test('controls root processes and reads their logs', async () => {
    const stopped = await fx.client.call<ProcessInfo>({ action: 'pm2.control', params: { owner: 'root', name: 'legacy-api', op: 'stop' } });
    assert.equal(stopped.status, 'stopped');
    const started = await fx.client.call<ProcessInfo>({ action: 'pm2.control', params: { owner: 'root', name: 'legacy-api', op: 'start' } });
    assert.equal(started.status, 'online');
    const logs = await fx.client.call<{ lines: string[] }>({ action: 'pm2.logs', params: { owner: 'root', name: 'legacy-api', stream: 'out', lines: 3 } });
    assert.deepEqual(logs.lines, ['legacy line 48', 'legacy line 49', 'legacy line 50']);
    await assert.rejects(
      fx.client.call({ action: 'pm2.control', params: { owner: 'root', name: 'nope', op: 'restart' } }),
      (e: unknown) => e instanceof AgentCallError && e.code === 'not_found',
    );
  });

  test('creates, replaces and removes an app in the apps PM2', async () => {
    const p = await fx.client.call<ProcessInfo>({
      action: 'app.apply',
      params: { spec: helloSpec(fx.appsRoot), env: { PORT: '3000', API_SECRET: 's3cr3t' }, start: true },
    });
    assert.equal(p.status, 'online');
    assert.equal(p.owner, 'apps');
    const spec = JSON.parse(readFileSync(join(fx.dir, 'specs', 'hello.json'), 'utf8'));
    const app = spec.apps[0];
    assert.equal(app.script, join(fx.appsRoot, 'hello', 'dist', 'server.js'));
    assert.deepEqual(app.args, ['--port', '3000']);
    assert.equal(app.env.PORT, '3000');
    assert.equal(app.env.NODE_ENV, 'production');
    assert.equal(app.max_memory_restart, '256M');
    assert.equal((statSync(join(fx.dir, 'specs', 'hello.json')).mode & 0o777).toString(8), '640');

    // Re-applying replaces the process (delete + start), it does not fail with "already launched".
    const again = await fx.client.call<ProcessInfo>({
      action: 'app.apply',
      params: { spec: helloSpec(fx.appsRoot, { startType: 'npm', script: null, npmScript: 'start', args: [] }), env: {}, start: true },
    });
    assert.equal(again.status, 'online');
    const calls = JSON.parse(readFileSync(join(fx.appsPm2Home, 'state.json'), 'utf8')).calls as string[];
    assert.ok(calls.includes('delete hello'));
    assert.ok(calls.filter((c) => c === 'save --force').length >= 2, 'process list saved for reboot');
    const npmApp = JSON.parse(readFileSync(join(fx.dir, 'specs', 'hello.json'), 'utf8')).apps[0];
    assert.deepEqual(npmApp.args, ['run', 'start']);
    assert.match(npmApp.script, /npm-cli\.js$/);

    const list = await fx.client.call<{ processes: ProcessInfo[] }>({ action: 'pm2.list', params: { owner: 'apps' } });
    assert.deepEqual(list.processes.map((x) => x.name), ['hello']);
    const logs = await fx.client.call<{ lines: string[] }>({ action: 'pm2.logs', params: { owner: 'apps', name: 'hello', stream: 'err', lines: 10 } });
    assert.ok(logs.lines.some((l) => l.includes('warning from hello')));

    await fx.client.call({ action: 'app.remove', params: { name: 'hello' } });
    assert.equal(existsSync(join(fx.dir, 'specs', 'hello.json')), false);
    const after = await fx.client.call<{ processes: ProcessInfo[] }>({ action: 'pm2.list', params: { owner: 'apps' } });
    assert.equal(after.processes.length, 0);
  });

  test('refuses apps outside the allowed roots, missing files and unknown runtimes', async () => {
    const reject = async (spec: AppSpec, field: string) =>
      assert.rejects(
        fx.client.call({ action: 'app.apply', params: { spec, env: {}, start: true } }),
        (e: unknown) => e instanceof AgentCallError && e.field === field,
      );
    await reject(helloSpec(fx.appsRoot, { cwd: '/etc' }), 'cwd');
    await reject(helloSpec(fx.appsRoot, { cwd: fx.appsRoot }), 'cwd'); // the root itself is not an app dir
    await reject(helloSpec(fx.appsRoot, { cwd: join(fx.appsRoot, 'missing') }), 'cwd');
    await reject(helloSpec(fx.appsRoot, { script: 'dist/nope.js' }), 'script');
    await reject(helloSpec(fx.appsRoot, { runtime: '/usr/bin/python3' }), 'runtime');
    // A symlink inside the app pointing outside it must not be accepted as the entry file.
    symlinkSync('/etc/hostname', join(fx.appsRoot, 'hello', 'escape.js'));
    await reject(helloSpec(fx.appsRoot, { script: 'escape.js' }), 'script');
    // A symlinked app directory that resolves outside the allowed roots.
    symlinkSync('/etc', join(fx.appsRoot, 'sneaky'));
    await reject(helloSpec(fx.appsRoot, { name: 'sneaky', cwd: join(fx.appsRoot, 'sneaky'), script: 'hostname' }), 'cwd');
  });
});

describe('agent policy', () => {
  test('root control can be disabled; root PM2 may be absent', async () => {
    const fx = await startAgentFixture({ manageRoot: false });
    try {
      await assert.rejects(
        fx.client.call({ action: 'pm2.control', params: { owner: 'root', name: 'legacy-api', op: 'stop' } }),
        (e: unknown) => e instanceof AgentCallError && e.code === 'forbidden',
      );
      // Read-only listing still works.
      const r = await fx.client.call<{ processes: ProcessInfo[] }>({ action: 'pm2.list', params: { owner: 'root' } });
      assert.equal(r.processes.length, 1);
    } finally {
      await fx.close();
    }
    const noRoot = await startAgentFixture({ withRoot: false });
    try {
      const info = await noRoot.client.call<AgentInfo>({ action: 'agent.info' });
      assert.equal(info.root.available, false);
      await assert.rejects(noRoot.client.call({ action: 'pm2.list', params: { owner: 'root' } }), /not found/);
    } finally {
      await noRoot.close();
    }
  });

  test('never spawns a PM2 daemon when it is down', async () => {
    const fx = await startAgentFixture();
    try {
      writeFileSync(join(fx.rootHome, 'pm2.pid'), '999999'); // dead pid
      const r = await fx.client.call<{ status: { available: boolean }; processes: unknown[] }>({ action: 'pm2.list', params: { owner: 'root' } });
      assert.equal(r.status.available, false);
      await assert.rejects(
        fx.client.call({ action: 'pm2.control', params: { owner: 'root', name: 'legacy-api', op: 'restart' } }),
        (e: unknown) => e instanceof AgentCallError && e.code === 'pm2_unavailable',
      );
      const calls = JSON.parse(readFileSync(join(fx.rootHome, 'state.json'), 'utf8')).calls as string[];
      assert.equal(calls.length, 0, 'pm2 CLI was not invoked at all');
    } finally {
      await fx.close();
    }
  });

  test('client reports an unreachable agent distinctly', async () => {
    await assert.rejects(new AgentClient('/nonexistent/agent.sock').call({ action: 'agent.info' }), AgentUnavailableError);
  });
});
