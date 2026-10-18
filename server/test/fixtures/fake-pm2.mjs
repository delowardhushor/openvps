#!/usr/bin/env node
// Minimal stand-in for the pm2 CLI used by the agent tests (PM2 itself is exercised in CI).
// State lives in $PM2_HOME/state.json. Supports: jlist, start, stop, restart, reload, delete, save.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

const home = process.env.PM2_HOME;
if (!home) {
  console.error('PM2_HOME not set');
  process.exit(2);
}
const stateFile = join(home, 'state.json');
const logs = join(home, 'logs');
mkdirSync(logs, { recursive: true });
const load = () => (existsSync(stateFile) ? JSON.parse(readFileSync(stateFile, 'utf8')) : { procs: [], nextId: 0, calls: [] });
const state = load();
const save = () => writeFileSync(stateFile, JSON.stringify(state, null, 2));
const [cmd, arg] = process.argv.slice(2);
state.calls.push(process.argv.slice(2).join(' '));

const byName = (n) => state.procs.filter((p) => p.name === n);
const notFound = (n) => {
  save();
  console.error(`[PM2][ERROR] Process or Namespace ${n} not found`);
  process.exit(1);
};
const now = () => Date.now();

switch (cmd) {
  case 'jlist': {
    console.log('>>>> In-memory PM2 is out-of-date, do:\n>>>> $ pm2 update'); // real PM2 sometimes prints this first
    const list = state.procs.map((p) => ({
      name: p.name,
      pid: p.status === 'online' ? p.pid : 0,
      pm_id: p.id,
      monit: { cpu: p.status === 'online' ? 1.5 : 0, memory: p.status === 'online' ? 50 * 1024 * 1024 : 0 },
      pm2_env: {
        status: p.status,
        pm_uptime: p.started,
        restart_time: p.restarts,
        unstable_restarts: 0,
        exec_mode: p.mode === 'cluster' ? 'cluster_mode' : 'fork_mode',
        pm_exec_path: p.script,
        pm_cwd: p.cwd,
        exec_interpreter: p.interpreter,
        node_version: '22.0.0',
        pm_out_log_path: p.out,
        pm_err_log_path: p.err,
        env: { ...p.env, SECRET_TOKEN: 'must-never-leave-the-agent' },
        DB_PASSWORD: 'also-secret',
      },
    }));
    save();
    console.log(JSON.stringify(list));
    break;
  }
  case 'start': {
    if (arg && arg.endsWith('.json')) {
      const eco = JSON.parse(readFileSync(arg, 'utf8'));
      for (const a of eco.apps) {
        if (byName(a.name).length) {
          save();
          console.error(`[PM2][ERROR] Script already launched, add -f option to force re-execution`);
          process.exit(1);
        }
        const n = a.exec_mode === 'cluster' ? a.instances : 1;
        for (let i = 0; i < n; i++) {
          const out = join(logs, `${a.name}-out.log`);
          const err = join(logs, `${a.name}-error.log`);
          appendFileSync(out, `started ${a.name} ${JSON.stringify(a.args)}\n`);
          appendFileSync(err, `warning from ${a.name}\n`);
          state.procs.push({
            id: state.nextId++,
            name: a.name,
            status: String(a.script).includes('crash') ? 'errored' : 'online',
            pid: 40000 + state.nextId,
            started: now(),
            restarts: 0,
            mode: a.exec_mode,
            script: a.script,
            cwd: a.cwd,
            interpreter: a.interpreter,
            out,
            err,
            env: a.env,
          });
        }
      }
    } else {
      const ps = byName(arg);
      if (!ps.length) notFound(arg);
      for (const p of ps) Object.assign(p, { status: 'online', started: now() });
    }
    break;
  }
  case 'stop':
  case 'restart':
  case 'reload':
  case 'delete': {
    const ps = byName(arg);
    if (!ps.length) notFound(arg);
    if (cmd === 'delete') state.procs = state.procs.filter((p) => p.name !== arg);
    for (const p of ps) {
      if (cmd === 'stop') p.status = 'stopped';
      else if (cmd !== 'delete') Object.assign(p, { status: 'online', restarts: p.restarts + 1, started: now() });
    }
    console.log(`[PM2] Applying action ${cmd}Process on app [${arg}]`);
    break;
  }
  case 'resurrect': {
    // Start a stand-in daemon process and record it, like PM2's God daemon.
    const d = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { detached: true, stdio: 'ignore' });
    d.unref();
    writeFileSync(join(home, 'pm2.pid'), String(d.pid));
    break;
  }
  case 'kill': {
    try {
      process.kill(Number(readFileSync(join(home, 'pm2.pid'), 'utf8')), 'SIGTERM');
    } catch {}
    rmSync(join(home, 'pm2.pid'), { force: true });
    break;
  }
  case 'save':
    writeFileSync(join(home, 'dump.pm2'), JSON.stringify(state.procs.map((p) => p.name)));
    break;
  default:
    save();
    console.error(`unknown command ${cmd}`);
    process.exit(1);
}
save();
