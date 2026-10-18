import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { ConfigError, loadConfig, type Config } from './config.ts';
import { createLogger, type Logger } from './logger.ts';
import { Pm2Target } from './agent/pm2.ts';
import { AppsManager } from './agent/apps.ts';
import { RuntimeDetector } from './agent/runtimes.ts';
import { createDispatcher, listenAgent, type AgentDeps } from './agent/server.ts';
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
