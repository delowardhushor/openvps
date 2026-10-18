import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import type { Logger } from './logger.ts';
import type { Audit } from './audit.ts';
import type { Users } from './auth/users.ts';
import type { Sessions } from './auth/sessions.ts';
import type { RateLimiter } from './auth/ratelimit.ts';
import type { MetricsCollector, HostInfo } from './metrics/collector.ts';
import type { Runner } from './system/exec.ts';
import type { AgentClient } from './agent-client.ts';
import type { AppsStore } from './apps-store.ts';
import type { SitesStore } from './sites-store.ts';
import type { BackupService } from './backups.ts';

/** Shared services handed to route modules. */
export interface AppContext {
  config: Config;
  db: Db;
  log: Logger;
  audit: Audit;
  users: Users;
  sessions: Sessions;
  loginLimiter: RateLimiter;
  setupLimiter: RateLimiter;
  metrics: MetricsCollector;
  host: HostInfo;
  run: Runner;
  agent: AgentClient;
  apps: AppsStore;
  sites: SitesStore;
  backups: BackupService;
  startedAt: number;
}
