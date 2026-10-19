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
import { BackupsStore } from './backups-store.ts';
import { BackupService } from './backups.ts';
import { MongoStore } from './mongo-store.ts';
import { MongoPool } from './mongo/pool.ts';
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
  const box = secrets(config.dataDir);
  const audit = new Audit(db);
  const agent = opts.agent ?? new AgentClient(config.agent.socket);
  return {
    config,
    db,
    log,
    audit,
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
    agent,
    apps: new AppsStore(db, box),
    sites: new SitesStore(db),
    backups: new BackupService({ agent, audit, log, store: new BackupsStore(db, box) }),
    mongo: new MongoStore(db, box),
    mongoPool: new MongoPool(),
    startedAt: Date.now(),
  };
}
