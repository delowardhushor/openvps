import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:net';
import { loadConfig } from '../src/config.ts';
import { buildAgent } from '../src/agent.ts';
import { createDispatcher, listenAgent } from '../src/agent/server.ts';
import { AgentClient } from '../src/agent-client.ts';
import type { AppSpec } from '../src/agent/spec.ts';
import { silentLogger } from '../src/logger.ts';

const FAKE_PM2 = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-pm2.mjs');

export interface AgentFixture {
  dir: string;
  socket: string;
  appsRoot: string;
  rootHome: string;
  appsPm2Home: string;
  server: Server;
  client: AgentClient;
  close(): Promise<void>;
}

/** Start a real agent (unprivileged) on a temp socket, wired to the fake pm2. */
export async function startAgentFixture(opts: { manageRoot?: boolean; withRoot?: boolean } = {}): Promise<AgentFixture> {
  chmodSync(FAKE_PM2, 0o755);
  const dir = mkdtempSync(join(tmpdir(), 'openvps-agent-'));
  const rootHome = join(dir, 'root-pm2');
  const appsHome = join(dir, 'apps-home');
  const appsPm2Home = join(appsHome, '.pm2');
  const appsRoot = join(dir, 'srv-apps');
  for (const d of [rootHome, appsPm2Home, appsRoot, join(rootHome, 'logs')]) mkdirSync(d, { recursive: true });
  // Both "daemons" are alive: point pm2.pid at this test process.
  writeFileSync(join(rootHome, 'pm2.pid'), String(process.pid));
  writeFileSync(join(appsPm2Home, 'pm2.pid'), String(process.pid));
  // root already runs an app (as on the user's VPS).
  const out = join(rootHome, 'logs', 'legacy-api-out.log');
  writeFileSync(out, Array.from({ length: 50 }, (_, i) => `legacy line ${i + 1}`).join('\n') + '\n');
  writeFileSync(join(rootHome, 'logs', 'legacy-api-error.log'), 'legacy error\n');
  writeFileSync(
    join(rootHome, 'state.json'),
    JSON.stringify({
      nextId: 1,
      calls: [],
      procs: [
        { id: 0, name: 'legacy-api', status: 'online', pid: 1234, started: Date.now() - 60_000, restarts: 2, mode: 'fork', script: '/root/legacy/index.js', cwd: '/root/legacy', interpreter: 'node', out, err: join(rootHome, 'logs', 'legacy-api-error.log'), env: { API_KEY: 'root-secret' } },
      ],
    }),
  );
  // An app the user wants to run through OpenVPS.
  const hello = join(appsRoot, 'hello');
  mkdirSync(join(hello, 'dist'), { recursive: true });
  writeFileSync(join(hello, 'dist', 'server.js'), 'console.log("hi")');
  writeFileSync(join(hello, 'package.json'), JSON.stringify({ name: 'hello', scripts: { start: 'node dist/server.js' } }));

  const socket = join(dir, 'run', 'agent.sock');
  const config = loadConfig(
    { OPENVPS_DEV: '1' },
    {
      dataDir: join(dir, 'data'),
      agent: { socket, manageRootPm2: opts.manageRoot ?? true, rootPm2Bin: opts.withRoot === false ? null : FAKE_PM2, rootPm2Home: rootHome, stateFile: join(dir, 'state.json') },
      apps: {
        user: null,
        home: appsHome,
        allowedRoots: [appsRoot],
        pm2Bin: FAKE_PM2,
        pm2Node: process.execPath,
        service: null,
        specDir: join(dir, 'specs'),
        runtimeCandidates: [process.execPath, '/definitely/missing/node'],
      },
    },
  );
  const deps = buildAgent(config, silentLogger);
  const server = await listenAgent(socket, null, createDispatcher(deps), silentLogger);
  return {
    dir,
    socket,
    appsRoot,
    rootHome,
    appsPm2Home,
    server,
    client: new AgentClient(socket),
    close: () => new Promise((r) => server.close(() => r())),
  };
}

export function helloSpec(appsRoot: string, over: Partial<AppSpec> = {}): AppSpec {
  return {
    name: 'hello',
    cwd: join(appsRoot, 'hello'),
    startType: 'file',
    script: 'dist/server.js',
    npmScript: null,
    args: ['--port', '3000'],
    runtime: process.execPath,
    instances: 1,
    execMode: 'fork',
    maxMemoryMb: 256,
    ...over,
  };
}

