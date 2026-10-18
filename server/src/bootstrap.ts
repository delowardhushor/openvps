import type { Config } from './config.ts';
import { migrate, openDb, openMemoryDb, type Db } from './db/index.ts';
import { createLogger, type Logger } from './logger.ts';
import { Audit } from './audit.ts';
import { Users } from './auth/users.ts';
import { Sessions } from './auth/sessions.ts';
import { RateLimiter } from './auth/ratelimit.ts';
import { MetricsCollector, hostInfo, type Sources } from './metrics/collector.ts';
import { runAllowed, type Runner } from './system/exec.ts';
import type { AppContext } from './context.ts';
import { AgentClient } from './agent-client.ts';
import { AppsStore } from './apps-store.ts';
import { SitesStore } from './sites-store.ts';
import { SecretBox } from './secretbox.ts';
import { mkdirSync } from 'node:fs';

export interface BootstrapOptions {
  log?: Logger;
  db?: Db;
  memoryDb?: boolean;
  run?: Runner;
  metricsSources?: Sources;
  agent?: AgentClient;
}

function secrets(dataDir: string): SecretBox {
  mkdirSync(dataDir, { recursive: true, mode: 0o750 });
  return SecretBox.fromDataDir(dataDir);
}

export async function bootstrap(config: Config, opts: BootstrapOptions = {}): Promise<AppContext> {
  const log = opts.log ?? createLogger(config.logLevel);
  const db = opts.db ?? (opts.memoryDb ? openMemoryDb() : openDb(config.dataDir));
  const m = migrate(db);
  if (m.applied.length) log.info('database migrated', { from: m.from, to: m.to });

  const a = config.auth;
  return {
    config,
    db,
    log,
    audit: new Audit(db),
    users: new Users(db),
    sessions: new Sessions(db, {
      idleMs: config.session.idleMinutes * 60_000,
      absoluteMs: config.session.absoluteHours * 3_600_000,
    }),
    loginLimiter: new RateLimiter(a.ipAttemptsPerWindow, a.ipWindowMinutes * 60_000),
    setupLimiter: new RateLimiter(10, 15 * 60_000),
    metrics: new MetricsCollector({ ...config.metrics, sources: opts.metricsSources }),
    host: await hostInfo(opts.metricsSources),
    run: opts.run ?? runAllowed,
    agent: opts.agent ?? new AgentClient(config.agent.socket),
    apps: new AppsStore(db, secrets(config.dataDir)),
    sites: new SitesStore(db),
    startedAt: Date.now(),
  };
}
