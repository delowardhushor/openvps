import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LogLevel } from './logger.ts';

export interface Config {
  /** Path the config was loaded from, or null when running on defaults. */
  source: string | null;
  dev: boolean;
  listen: { host: string; port: number };
  tls: { enabled: boolean; certFile: string; keyFile: string };
  /** Honour X-Forwarded-For / X-Forwarded-Proto. Enable only behind a trusted reverse proxy. */
  trustProxy: boolean;
  dataDir: string;
  webRoot: string;
  logLevel: LogLevel;
  session: { idleMinutes: number; absoluteHours: number };
  auth: {
    minPasswordLength: number;
    /** Failed logins per username before temporary lockout. */
    maxFailedAttempts: number;
    lockoutMinutes: number;
    /** Login requests per IP per window, regardless of outcome. */
    ipAttemptsPerWindow: number;
    ipWindowMinutes: number;
  };
  metrics: { intervalSeconds: number; historyMinutes: number };
  /** systemd units whose state is shown on the dashboard (read-only checks). */
  services: string[];
  audit: { retentionDays: number };
}

export const DEFAULT_CONFIG_PATH = '/etc/openvps/config.json';

const here = dirname(fileURLToPath(import.meta.url));
// src/ or dist/ -> server/ -> repo root -> web/dist
const DEFAULT_WEB_ROOT = resolve(here, '..', '..', 'web', 'dist');

function defaults(dev: boolean): Omit<Config, 'source'> {
  return {
    dev,
    listen: { host: dev ? '127.0.0.1' : '0.0.0.0', port: dev ? 7800 : 7443 },
    tls: {
      enabled: !dev,
      certFile: '/etc/openvps/tls/cert.pem',
      keyFile: '/etc/openvps/tls/key.pem',
    },
    trustProxy: false,
    dataDir: dev ? resolve(process.cwd(), '.data') : '/var/lib/openvps',
    webRoot: DEFAULT_WEB_ROOT,
    logLevel: dev ? 'debug' : 'info',
    session: { idleMinutes: 120, absoluteHours: 12 },
    auth: {
      minPasswordLength: 12,
      maxFailedAttempts: 5,
      lockoutMinutes: 15,
      ipAttemptsPerWindow: 20,
      ipWindowMinutes: 15,
    },
    metrics: { intervalSeconds: 5, historyMinutes: 60 },
    services: ['nginx', 'ssh', 'cron', 'ufw'],
    audit: { retentionDays: 180 },
  };
}

export class ConfigError extends Error {}

type Json = Record<string, unknown>;

function isObj(v: unknown): v is Json {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Deep-merge plain objects; arrays and scalars from `over` replace `base`. */
function merge<T>(base: T, over: unknown): T {
  if (!isObj(over)) return base;
  const out: Json = { ...(base as Json) };
  for (const [k, v] of Object.entries(over)) {
    if (!(k in out)) throw new ConfigError(`Unknown config key "${k}"`);
    out[k] = isObj(v) && isObj(out[k]) ? merge(out[k], v) : v;
  }
  return out as T;
}

function int(name: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new ConfigError(`${name} must be an integer between ${min} and ${max}`);
  }
  return v;
}

function bool(name: string, v: unknown): boolean {
  if (typeof v !== 'boolean') throw new ConfigError(`${name} must be true or false`);
  return v;
}

function str(name: string, v: unknown): string {
  if (typeof v !== 'string' || v.length === 0) throw new ConfigError(`${name} must be a non-empty string`);
  return v;
}

const UNIT_NAME = /^[A-Za-z0-9@._-]{1,64}$/;

export function validate(c: Omit<Config, 'source'>): void {
  str('listen.host', c.listen.host);
  int('listen.port', c.listen.port, 1, 65535);
  bool('tls.enabled', c.tls.enabled);
  if (c.tls.enabled) {
    str('tls.certFile', c.tls.certFile);
    str('tls.keyFile', c.tls.keyFile);
  }
  bool('trustProxy', c.trustProxy);
  if (!isAbsolute(str('dataDir', c.dataDir))) throw new ConfigError('dataDir must be an absolute path');
  if (!isAbsolute(str('webRoot', c.webRoot))) throw new ConfigError('webRoot must be an absolute path');
  if (!['debug', 'info', 'warn', 'error'].includes(c.logLevel)) {
    throw new ConfigError('logLevel must be one of debug, info, warn, error');
  }
  int('session.idleMinutes', c.session.idleMinutes, 5, 7 * 24 * 60);
  int('session.absoluteHours', c.session.absoluteHours, 1, 24 * 30);
  int('auth.minPasswordLength', c.auth.minPasswordLength, 8, 256);
  int('auth.maxFailedAttempts', c.auth.maxFailedAttempts, 1, 100);
  int('auth.lockoutMinutes', c.auth.lockoutMinutes, 1, 24 * 60);
  int('auth.ipAttemptsPerWindow', c.auth.ipAttemptsPerWindow, 1, 10_000);
  int('auth.ipWindowMinutes', c.auth.ipWindowMinutes, 1, 24 * 60);
  int('metrics.intervalSeconds', c.metrics.intervalSeconds, 1, 300);
  int('metrics.historyMinutes', c.metrics.historyMinutes, 1, 24 * 60);
  int('audit.retentionDays', c.audit.retentionDays, 1, 3650);
  if (!Array.isArray(c.services) || c.services.length > 32) {
    throw new ConfigError('services must be an array of at most 32 systemd unit names');
  }
  for (const s of c.services) {
    if (typeof s !== 'string' || !UNIT_NAME.test(s)) throw new ConfigError(`Invalid service name "${String(s)}"`);
  }
}

/** Apply OPENVPS_* environment overrides (handy for development and containers). */
function envOverrides(env: NodeJS.ProcessEnv): Json {
  const o: Json = {};
  if (env.OPENVPS_HOST) o.listen = { ...((o.listen as Json) ?? {}), host: env.OPENVPS_HOST };
  if (env.OPENVPS_PORT) o.listen = { ...((o.listen as Json) ?? {}), port: Number(env.OPENVPS_PORT) };
  if (env.OPENVPS_TLS !== undefined) o.tls = { enabled: env.OPENVPS_TLS === '1' || env.OPENVPS_TLS === 'true' };
  if (env.OPENVPS_DATA_DIR) o.dataDir = resolve(env.OPENVPS_DATA_DIR);
  if (env.OPENVPS_WEB_ROOT) o.webRoot = resolve(env.OPENVPS_WEB_ROOT);
  if (env.OPENVPS_LOG_LEVEL) o.logLevel = env.OPENVPS_LOG_LEVEL;
  return o;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Json = {}): Config {
  const dev = env.OPENVPS_DEV === '1';
  const explicit = env.OPENVPS_CONFIG;
  const path = explicit ?? (dev ? null : DEFAULT_CONFIG_PATH);
  let fileJson: unknown = {};
  let source: string | null = null;
  if (path && existsSync(path)) {
    try {
      fileJson = JSON.parse(readFileSync(path, 'utf8'));
    } catch (e) {
      throw new ConfigError(`Could not parse ${path}: ${(e as Error).message}`);
    }
    source = path;
  } else if (explicit) {
    throw new ConfigError(`Config file ${explicit} does not exist`);
  }
  let c = defaults(dev);
  c = merge(c, fileJson);
  c = merge(c, envOverrides(env));
  c = merge(c, overrides);
  if (source && !isAbsolute(c.dataDir)) c.dataDir = join(dirname(source), c.dataDir);
  validate(c);
  return { ...c, source };
}
