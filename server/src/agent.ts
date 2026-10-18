import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { createLogger, type Logger } from './logger.ts';
import { Pm2Target } from './agent/pm2.ts';
import { AppsManager } from './agent/apps.ts';
import { RuntimeDetector } from './agent/runtimes.ts';
import { createDispatcher, listenAgent, type AgentDeps } from './agent/server.ts';
import { SitesManager, type SitesOptions } from './agent/sites.ts';
import { BackupManager } from './agent/backup.ts';
import { hostname } from 'node:os';
import { firstExisting, runTool } from './agent/exec.ts';
import { VERSION } from './version.ts';

/**
 * OpenVPS agent: the only privileged component. Runs as root (systemd unit
 * openvps-agent) and performs a fixed set of validated actions requested by the
 * panel over a Unix socket. It never executes arbitrary commands.
 */

interface AgentState {
  rootPm2Bin?: string | null;
}

function lookupId(file: '/etc/passwd' | '/etc/group', name: string): { id: number; gid: number; home: string } | null {
  try {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      const f = line.split(':');
      if (f[0] === name) return { id: Number(f[2]), gid: Number(f[3]), home: f[5] ?? '' };
    }
  } catch {
    /* fallthrough */
  }
  return null;
}

function systemctlStart(unit: string): () => Promise<void> {
  return () =>
    new Promise((resolve, reject) => {
      execFile('/usr/bin/systemctl', ['start', unit], { timeout: 30_000, env: { PATH: '/usr/bin:/bin' } }, (err) =>
        err ? reject(err) : setTimeout(resolve, 500),
      );
    });
}

const SYSTEMCTL = '/usr/bin/systemctl';

function hasSystemd(): boolean {
  return firstExisting(['/run/systemd/system']) !== null;
}

/** Reload Nginx through systemd when available, falling back to the nginx binary. */
function nginxControl(nginxBin: string, nginxConf: string): Pick<SitesOptions, 'reload' | 'isRunning' | 'renewalTimer'> {
  const pidAlive = (): boolean => {
    try {
      const pid = Number(readFileSync('/run/nginx.pid', 'utf8').trim());
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  };
  const isRunning = async () => {
    if (hasSystemd()) {
      const r = await runTool(SYSTEMCTL, ['is-active', '--quiet', 'nginx'], { timeoutMs: 5000 });
      if (r.code === 0) return true;
    }
    return pidAlive();
  };
  // A reload only signals the master; give it a moment to start workers with the new
  // configuration so that "done" in the panel means the change is live.
  const settle = () => new Promise((r) => setTimeout(r, 400));
  return {
    isRunning,
    reload: async () => {
      const running = await isRunning();
      if (hasSystemd()) {
        const r = await runTool(SYSTEMCTL, [running ? 'reload' : 'start', 'nginx'], { timeoutMs: 30_000 });
        if (r.code === 0) {
          await settle();
          return { ok: true, message: running ? 'Nginx reloaded.' : 'Nginx started.' };
        }
      }
      const r = await runTool(nginxBin, running ? ['-c', nginxConf, '-s', 'reload'] : ['-c', nginxConf], { timeoutMs: 30_000 });
      if (r.code === 0) await settle();
      return r.code === 0
        ? { ok: true, message: running ? 'Nginx reloaded.' : 'Nginx started.' }
        : { ok: false, message: `Configuration saved, but Nginx could not be ${running ? 'reloaded' : 'started'}: ${r.stderr.trim().slice(0, 300)}` };
    },
    renewalTimer: async () => {
      if (!hasSystemd()) return null;
      for (const t of ['certbot.timer', 'snap.certbot.renew.timer']) {
        const r = await runTool(SYSTEMCTL, ['is-active', '--quiet', t], { timeoutMs: 5000 });
        if (r.code === 0) return t;
      }
      return null;
    },
  };
}

export function buildSites(config: Config, overrides: Partial<SitesOptions> = {}): SitesManager {
  const s = config.sites;
  return new SitesManager({
    nginxBin: s.nginxBin,
    nginxConf: s.nginxConf,
    sitesAvailable: s.sitesAvailable,
    sitesEnabled: s.sitesEnabled,
    confD: s.confD,
    letsencryptDir: s.letsencryptDir,
    certbotBin: s.certbotBin ?? firstExisting(['/usr/bin/certbot', '/snap/bin/certbot', '/usr/local/bin/certbot']),
    acmeRoot: s.acmeRoot,
    staticRoots: s.staticRoots,
    panel: { port: config.listen.port, tls: config.tls.enabled },
    version: VERSION,
    acmeServer: s.acmeServer,
    certbotEnv: s.acmeCaBundle ? { REQUESTS_CA_BUNDLE: s.acmeCaBundle } : {},
    dnsServers: s.dnsServers,
    checkPort: 80,
    ipv6: null,
    ...nginxControl(s.nginxBin, s.nginxConf),
    ...overrides,
  });
}

export function buildBackups(config: Config, log: Logger, overrides: Partial<ConstructorParameters<typeof BackupManager>[0]> = {}): BackupManager {
  const b = config.backups;
  return new BackupManager({
    dir: b.dir,
    fileRoots: b.fileRoots,
    tarBin: b.tarBin ?? firstExisting(['/usr/bin/tar', '/bin/tar', '/usr/local/bin/tar']),
    niceBin: firstExisting(['/usr/bin/nice', '/bin/nice']),
    mongodumpBin: b.mongodumpBin ?? firstExisting(['/usr/bin/mongodump', '/usr/local/bin/mongodump', '/snap/bin/mongodump']),
    mongorestoreBin: b.mongorestoreBin ?? firstExisting(['/usr/bin/mongorestore', '/usr/local/bin/mongorestore', '/snap/bin/mongorestore']),
    version: VERSION,
    hostname: hostname(),
    log,
    ...overrides,
  });
}

export function buildAgent(config: Config, log: Logger, overrides: Partial<AgentDeps> = {}): AgentDeps {
  let state: AgentState = {};
  try {
    state = JSON.parse(readFileSync(config.agent.stateFile, 'utf8')) as AgentState;
  } catch {
    /* not provisioned yet */
  }
  const asRoot = process.getuid?.() === 0;
  const appsUser = config.apps.user;
  const appsAccount = appsUser ? lookupId('/etc/passwd', appsUser) : null;
  if (appsUser && asRoot && !appsAccount) log.warn('apps user does not exist; run: sudo openvps provision', { user: appsUser });

  const rootBin = config.agent.rootPm2Bin ?? state.rootPm2Bin ?? null;
  const root = rootBin
    ? new Pm2Target({
        owner: 'root',
        bin: rootBin,
        node: null,
        pm2Home: config.agent.rootPm2Home,
        userHome: '/root',
        runAs: null,
        // pm2 installed via nvm finds its node in the same bin directory.
        pathDirs: [rootBin.slice(0, rootBin.lastIndexOf('/'))],
        logOwnerUid: asRoot ? 0 : null,
      })
    : null;

  const apps = new Pm2Target({
    owner: 'apps',
    bin: config.apps.pm2Bin,
    node: config.apps.pm2Node,
    pm2Home: `${config.apps.home}/.pm2`,
    userHome: config.apps.home,
    runAs: appsUser,
    pathDirs: config.apps.pm2Node ? [config.apps.pm2Node.slice(0, config.apps.pm2Node.lastIndexOf('/'))] : [],
    logOwnerUid: asRoot && appsAccount ? appsAccount.id : null,
    ensureDaemon: config.apps.service ? systemctlStart(config.apps.service) : undefined,
  });

  const runtimes = new RuntimeDetector(config.apps.runtimeCandidates, appsUser);
  const manager = new AppsManager({
    target: apps,
    runtimes,
    allowedRoots: config.apps.allowedRoots,
    specDir: config.apps.specDir,
    specGid: asRoot && appsAccount ? appsAccount.gid : null,
    daemonNode: config.apps.pm2Node,
  });

  return {
    version: VERSION,
    log,
    root,
    manageRoot: config.agent.manageRootPm2,
    apps,
    appsUser,
    manager,
    runtimes,
    sites: buildSites(config),
    backups: buildBackups(config, log),
    ...overrides,
  };
}

async function main(): Promise<void> {
  let config: Config;
  try {
    config = loadConfig();
  } catch (e) {
    if (e instanceof ConfigError) {
      process.stderr.write(`Configuration error: ${e.message}\n`);
      process.exit(78);
    }
    throw e;
  }
  const log = createLogger(config.logLevel);
  if (!config.dev && process.getuid?.() !== 0) {
    log.error('the agent must run as root (it is started by systemd as openvps-agent.service)');
    process.exit(1);
  }
  const deps = buildAgent(config, log);
  const group = config.agent.socketGroup ? lookupId('/etc/group', config.agent.socketGroup)?.id ?? null : null;
  if (config.agent.socketGroup && group === null) log.warn('socket group not found; socket left root-only', { group: config.agent.socketGroup });
  const server = await listenAgent(config.agent.socket, group, createDispatcher(deps), log);
  log.info('OpenVPS agent listening', {
    version: VERSION,
    socket: config.agent.socket,
    rootPm2: deps.root ? deps.root.opts.bin : null,
    appsUser: deps.appsUser,
  });
  const stop = () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// Only start when this file itself is the entry point (tests import buildAgent).
function isEntryPoint(): boolean {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}
if (isEntryPoint()) {
  main().catch((e: unknown) => {
    process.stderr.write(`Fatal: ${(e as Error).stack ?? String(e)}\n`);
    process.exit(1);
  });
}
