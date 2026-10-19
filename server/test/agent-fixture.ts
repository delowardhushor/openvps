import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Server } from 'node:net';
import { loadConfig } from '../src/config.ts';
import { buildAgent, buildSites } from '../src/agent.ts';
import { execFileSync } from 'node:child_process';
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
  /** Where local backups are written. */
  backupsDir: string;
  /** Calls made to the fake mongodump / mongorestore. */
  mongoCalls(): Array<{ tool: string; args: string[]; cfg: string; archive?: string }>;
  close(): Promise<void>;
}

/** Start a real agent (unprivileged) on a temp socket, wired to the fake pm2. */
export async function startAgentFixture(opts: { manageRoot?: boolean; withRoot?: boolean; sites?: boolean; buildSites?: (config: ReturnType<typeof loadConfig>) => ReturnType<typeof buildSites> } = {}): Promise<AgentFixture> {
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

  // Fake MongoDB tools; the agent runs tools with a minimal PATH, so they call node by absolute path.
  const mongoLog = join(dir, 'mongo-calls.log');
  const wrap = (name: string) => {
    const file = join(dir, `bin-${name}`);
    writeFileSync(file, `#!/bin/sh\nFAKE_MONGO_LOG="${mongoLog}" exec "${process.execPath}" "${join(dirname(FAKE_PM2), `fake-${name}.mjs`)}" "$@"\n`);
    chmodSync(file, 0o755);
    return file;
  };
  const backupsDir = join(dir, 'backups');

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
  config.backups.dir = backupsDir;
  config.backups.fileRoots = [appsRoot];
  config.files.roots = [appsRoot];
  config.backups.mongodumpBin = wrap('mongodump');
  config.backups.mongorestoreBin = wrap('mongorestore');
  let deps = buildAgent(config, silentLogger);
  if (opts.sites) deps = { ...deps, sites: sitesFixture(dir, config) };
  if (opts.buildSites) deps = { ...deps, sites: opts.buildSites(config) };
  const server = await listenAgent(socket, null, createDispatcher(deps), silentLogger);
  return {
    dir,
    socket,
    appsRoot,
    rootHome,
    appsPm2Home,
    server,
    client: new AgentClient(socket),
    backupsDir,
    mongoCalls: () => (existsSync(mongoLog) ? readFileSync(mongoLog, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []),
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


const FAKE_CERTBOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-certbot.mjs');

/** A private nginx config tree (validated with the real nginx binary) plus fake certbot. */
function sitesFixture(dir: string, config: ReturnType<typeof loadConfig>) {
  const n = join(dir, 'nginx');
  for (const d of ['sites-available', 'sites-enabled', 'conf.d', 'le/live/thesportsarena.com', 'le/renewal', 'acme', 'logs']) {
    mkdirSync(join(n, d), { recursive: true });
  }
  writeFileSync(join(n, 'nginx.conf'), `pid ${n}/nginx.pid;\nerror_log ${n}/logs/error.log;\nevents {}\nhttp {\n  include ${n}/sites-enabled/*;\n}\n`);
  const live = join(n, 'le/live/thesportsarena.com');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '15', '-subj', '/CN=thesportsarena.com',
    '-addext', 'subjectAltName=DNS:thesportsarena.com,DNS:www.thesportsarena.com', '-keyout', join(live, 'privkey.pem'), '-out', join(live, 'fullchain.pem')], { stdio: 'ignore' });
  writeFileSync(join(n, 'sites-enabled', 'thesportsarena.com'),
    `server {\n  listen 80;\n  server_name thesportsarena.com www.thesportsarena.com;\n  location / { proxy_pass http://localhost:3000; }\n}\nserver {\n  listen 443 ssl;\n  server_name thesportsarena.com www.thesportsarena.com;\n  ssl_certificate ${live}/fullchain.pem;\n  ssl_certificate_key ${live}/privkey.pem;\n}\n`);
  mkdirSync(join(dir, 'srv-apps', 'admin', 'dist'), { recursive: true });
  writeFileSync(join(dir, 'srv-apps', 'admin', 'dist', 'index.html'), '<h1>admin</h1>');
  chmodSync(FAKE_CERTBOT, 0o755);
  const c = {
    ...config,
    sites: {
      ...config.sites,
      nginxConf: join(n, 'nginx.conf'),
      sitesAvailable: join(n, 'sites-available'),
      sitesEnabled: join(n, 'sites-enabled'),
      confD: join(n, 'conf.d'),
      letsencryptDir: join(n, 'le'),
      certbotBin: FAKE_CERTBOT,
      acmeRoot: join(n, 'acme'),
      staticRoots: [join(dir, 'srv-apps')],
    },
  };
  return buildSites(c, {
    certbotEnv: { FAKE_LE_DIR: join(n, 'le') },
    ipv6: false,
    reload: async () => ({ ok: true, message: 'Nginx reloaded.' }),
    isRunning: async () => true,
    renewalTimer: async () => 'certbot.timer',
  });
}

/**
 * Whether the real nginx binary can check configs here. `nginx -t` binds the ports it
 * listens on and opens its log files, so as a normal user (e.g. CI's test job) it fails on
 * port 80. Those paths are covered as root by scripts/ci/sites-e2e.sh instead.
 */
export function realNginxSkip(): string | false {
  const bin = '/usr/sbin/nginx';
  if (!existsSync(bin)) return 'nginx not installed';
  if (process.getuid?.() !== 0) return 'nginx -t needs root to bind port 80 (covered by scripts/ci/sites-e2e.sh)';
  return false;
}
