import type { Config } from './config.ts';
import type { Db } from './db/index.ts';
import type { Logger } from './logger.ts';
import type { Audit } from './audit.ts';
import type { Users } from './auth/users.ts';
import type { Sessions } from './auth/sessions.ts';
import type { RateLimiter } from './auth/ratelimit.ts';
import type { MetricsCollector, HostInfo } from './metrics/collector.ts';
import type { Runner } from './system/exec.ts';

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
  startedAt: number;
}
