import { SpecError } from './spec.ts';

/**
 * Shared definitions for backups: the plan model, what the panel sends the agent
 * (validated again on both sides) and the on-disk manifest format.
 */

export const PLAN_NAME = /^[a-z][a-z0-9-]{1,39}$/;
export const SOURCE_NAME = /^[a-z][a-z0-9-]{0,29}$/;
export const DESTINATION_NAME = /^[a-z][a-z0-9-]{1,39}$/;
const DB_NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const EXCLUDE = /^[A-Za-z0-9._*?/-]{1,100}$/;
/** <plan>-<UTC yyyymmdd>-<hhmmss>.ovbk.tar */
export const ARTIFACT = /^([a-z][a-z0-9-]{1,39})-(\d{8})-(\d{6})\.ovbk\.tar$/;
/** Files inside an artifact, as written by the agent. */
export const MEMBER_FILE = /^(files|mongodb)-[a-z0-9-]+(--[A-Za-z0-9_.-]+)?\.(tar|archive)\.gz$/;

export const BACKUP_LIMITS = { sources: 20, excludes: 20, databases: 20, keepLast: 1000, maxAgeDays: 3650, restoreItems: 40 };

// ---- model ---------------------------------------------------------------------

export interface FileSource {
  type: 'files';
  name: string;
  /** Absolute directory inside one of the configured backup roots. */
  path: string;
  /** tar --exclude patterns, e.g. "node_modules" or "*.log". */
  exclude: string[];
}

export interface MongoSource {
  type: 'mongodb';
  name: string;
  /** Empty = whatever the connection string selects (all databases when it names none). */
  databases: string[];
}

export type BackupSource = FileSource | MongoSource;

export type Schedule =
  | { kind: 'manual' }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number };

export interface Retention {
  /** Keep this many of the newest backups. */
  keepLast: number;
  /** Also delete backups older than this many days (the newest is always kept). */
  maxAgeDays: number | null;
}

/** S3-compatible bucket: everything but the credentials. */
export interface S3Target {
  endpoint: string;
  region: string;
  bucket: string;
  /** Normalised: empty or "folder/sub/" (no leading slash, trailing slash). */
  prefix: string;
  /** http(s)://endpoint/bucket/key instead of http(s)://bucket.endpoint/key. */
  pathStyle: boolean;
}

export interface S3Secrets {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface S3Access {
  target: S3Target;
  secrets: S3Secrets;
}

/** What the panel hands the agent to run one backup. Contains secrets; never logged. */
export interface BackupJobSpec {
  plan: string;
  sources: BackupSource[];
  /** Connection strings by MongoDB source name. */
  mongoUris: Record<string, string>;
  local: boolean;
  s3: S3Access | null;
  retention: Retention;
}

export interface ArtifactRef {
  where: 'local' | 's3';
  plan: string;
  name: string;
}

export interface RestoreItem {
  /** Member file name from the manifest. */
  file: string;
  /** Files only: put them back where they came from, or into a separate folder to inspect. */
  target: 'original' | 'alternate';
}

export interface RestoreSpec {
  ref: ArtifactRef;
  s3: S3Access | null;
  items: RestoreItem[];
  mongoUris: Record<string, string>;
  /** MongoDB only: drop each collection before restoring it. */
  drop: boolean;
}

export interface ManifestMember {
  file: string;
  kind: 'files' | 'mongodb';
  source: string;
  sizeBytes: number;
  sha256: string;
  /** files: the directory that was archived. */
  path?: string;
  exclude?: string[];
  /** mongodb: the database, or null for "as selected by the connection string". */
  database?: string | null;
}

export interface Manifest {
  format: 1;
  plan: string;
  artifact: string;
  createdAt: number;
  hostname: string;
  openvpsVersion: string;
  members: ManifestMember[];
  /** Only in the sidecar copy (a file cannot contain its own hash). */
  artifactSizeBytes?: number;
  artifactSha256?: string;
}

export interface ArtifactInfo {
  where: 'local' | 's3';
  plan: string;
  name: string;
  sizeBytes: number;
  createdAt: number;
  /** false = no manifest next to it, so it cannot be restored. */
  complete: boolean;
}

export type BackupJobStatus = 'running' | 'succeeded' | 'partial' | 'failed';

export interface BackupJobView {
  id: string;
  kind: 'backup' | 'restore' | 'verify';
  plan: string;
  status: BackupJobStatus;
  startedAt: number;
  finishedAt: number | null;
  step: string;
  log: string[];
  result: unknown;
  error: { code: string; message: string } | null;
}

export interface BackupStatus {
  dir: string;
  freeBytes: number | null;
  tar: boolean;
  mongodump: { path: string; version: string | null } | null;
  mongorestore: { path: string; version: string | null } | null;
  fileRoots: string[];
  running: { id: string; kind: string; plan: string } | null;
}

// ---- helpers -------------------------------------------------------------------

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function int(field: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new SpecError(field, `Must be a whole number between ${min} and ${max}.`);
  }
  return v;
}

export function parseSchedule(input: unknown): Schedule {
  if (!isObj(input)) throw new SpecError('schedule', 'Choose when the backup runs.');
  switch (input.kind) {
    case 'manual':
      return { kind: 'manual' };
    case 'hourly':
      return { kind: 'hourly', minute: int('schedule', input.minute, 0, 59) };
    case 'daily':
      return { kind: 'daily', hour: int('schedule', input.hour, 0, 23), minute: int('schedule', input.minute, 0, 59) };
    case 'weekly':
      return {
        kind: 'weekly',
        weekday: int('schedule', input.weekday, 0, 6),
        hour: int('schedule', input.hour, 0, 23),
        minute: int('schedule', input.minute, 0, 59),
      };
    default:
      throw new SpecError('schedule', 'Schedule must be manual, hourly, daily or weekly.');
  }
}

/** The next time a schedule fires strictly after `from`, in the server's local time. null = manual. */
export function nextRun(schedule: Schedule, from: Date): Date | null {
  const d = new Date(from.getTime());
  d.setSeconds(0, 0);
  switch (schedule.kind) {
    case 'manual':
      return null;
    case 'hourly':
      d.setMinutes(schedule.minute);
      if (d.getTime() <= from.getTime()) d.setHours(d.getHours() + 1);
      return d;
    case 'daily':
      d.setHours(schedule.hour, schedule.minute);
      if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 1);
      return d;
    case 'weekly': {
      d.setHours(schedule.hour, schedule.minute);
      d.setDate(d.getDate() + ((schedule.weekday - d.getDay() + 7) % 7));
      if (d.getTime() <= from.getTime()) d.setDate(d.getDate() + 7);
      return d;
    }
  }
}

export function parseRetention(input: unknown): Retention {
  if (input === undefined || input === null) return { keepLast: 7, maxAgeDays: null };
  if (!isObj(input)) throw new SpecError('retention', 'Invalid retention settings.');
  const keepLast = int('keepLast', input.keepLast ?? 7, 1, BACKUP_LIMITS.keepLast);
  const maxAgeDays = input.maxAgeDays === null || input.maxAgeDays === undefined ? null : int('maxAgeDays', input.maxAgeDays, 1, BACKUP_LIMITS.maxAgeDays);
  return { keepLast, maxAgeDays };
}

export function parseSources(input: unknown): BackupSource[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > BACKUP_LIMITS.sources) {
    throw new SpecError('sources', `Choose between 1 and ${BACKUP_LIMITS.sources} things to back up.`);
  }
  const seen = new Set<string>();
  return input.map((raw, i): BackupSource => {
    const field = `sources[${i}]`;
    if (!isObj(raw)) throw new SpecError(field, 'Invalid source.');
    const name = raw.name;
    if (typeof name !== 'string' || !SOURCE_NAME.test(name)) {
      throw new SpecError(field, 'Source names are 1–30 characters: lowercase letters, digits and dashes, starting with a letter.');
    }
    if (seen.has(name)) throw new SpecError(field, `Two sources are named "${name}".`);
    seen.add(name);
    if (raw.type === 'files') {
      const path = raw.path;
      if (typeof path !== 'string' || !path.startsWith('/') || path.length > 512 || path.includes('\0') || path.split('/').includes('..')) {
        throw new SpecError(field, `"${name}": the folder must be an absolute path.`);
      }
      const exclude = raw.exclude ?? [];
      if (!Array.isArray(exclude) || exclude.length > BACKUP_LIMITS.excludes || !exclude.every((e) => typeof e === 'string' && EXCLUDE.test(e))) {
        throw new SpecError(field, `"${name}": exclusions are file or folder names such as node_modules or *.log (at most ${BACKUP_LIMITS.excludes}).`);
      }
      return { type: 'files', name, path: path.length > 1 ? path.replace(/\/+$/, '') : path, exclude: exclude as string[] };
    }
    if (raw.type === 'mongodb') {
      const databases = raw.databases ?? [];
      if (!Array.isArray(databases) || databases.length > BACKUP_LIMITS.databases || !databases.every((d) => typeof d === 'string' && DB_NAME.test(d))) {
        throw new SpecError(field, `"${name}": database names may use letters, digits, dots, dashes and underscores.`);
      }
      return { type: 'mongodb', name, databases: [...new Set(databases as string[])] };
    }
    throw new SpecError(field, 'A source is either a folder or a MongoDB connection.');
  });
}

const URI = /^mongodb(\+srv)?:\/\/[^\s\u0000-\u001f]+$/;

export function parseMongoUri(field: string, v: unknown): string {
  if (typeof v !== 'string' || v.length < 12 || v.length > 1024 || !URI.test(v)) {
    throw new SpecError(field, 'Enter a connection string starting with mongodb:// or mongodb+srv://.');
  }
  return v;
}

/** mongodb://user:pass@host/db -> mongodb://user:***@host/db, for display and error messages. */
export function redactMongoUri(uri: string): string {
  return uri.replace(/^(mongodb(?:\+srv)?:\/\/[^:@/]*):[^@/]*@/, '$1:***@');
}

export function parseMongoUris(field: string, sources: BackupSource[], input: unknown, required: boolean): Record<string, string> {
  const raw = isObj(input) ? input : {};
  const out: Record<string, string> = {};
  for (const s of sources) {
    if (s.type !== 'mongodb') continue;
    if (raw[s.name] === undefined && !required) continue;
    out[s.name] = parseMongoUri(field, raw[s.name]);
  }
  return out;
}

function isPrivateHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return (
    h === 'localhost' ||
    h === '::1' ||
    !h.includes('.') ||
    h.endsWith('.local') ||
    h.endsWith('.internal') ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h)
  );
}

export function parseS3Target(input: unknown): S3Target {
  if (!isObj(input)) throw new SpecError('target', 'Expected storage settings.');
  const rawEndpoint = input.endpoint;
  if (typeof rawEndpoint !== 'string' || rawEndpoint.length > 256) throw new SpecError('endpoint', 'Enter the storage endpoint, e.g. https://s3.eu-central-1.amazonaws.com.');
  let u: URL;
  try {
    u = new URL(rawEndpoint.trim());
  } catch {
    throw new SpecError('endpoint', 'The endpoint must be a URL such as https://s3.eu-central-1.amazonaws.com.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new SpecError('endpoint', 'The endpoint must start with https://.');
  if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) {
    throw new SpecError('endpoint', 'The endpoint must be just a host (no path, login or query).');
  }
  if (u.protocol === 'http:' && !isPrivateHost(u.hostname)) {
    throw new SpecError('endpoint', 'Use https:// for storage on the internet. Plain http:// is only accepted for local or private-network servers.');
  }
  const region = typeof input.region === 'string' && input.region.trim() ? input.region.trim() : 'us-east-1';
  if (!/^[A-Za-z0-9-]{1,32}$/.test(region)) throw new SpecError('region', 'Invalid region.');
  const bucket = input.bucket;
  if (typeof bucket !== 'string' || !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) {
    throw new SpecError('bucket', 'Bucket names are 3–63 characters: lowercase letters, digits, dots and dashes.');
  }
  let prefix = typeof input.prefix === 'string' ? input.prefix.trim().replace(/^\/+/, '') : '';
  if (prefix && !prefix.endsWith('/')) prefix += '/';
  if (prefix.length > 200 || (prefix && (!/^[A-Za-z0-9._/-]+$/.test(prefix) || prefix.includes('//') || prefix.split('/').some((p) => p === '..' || p === '.')))) {
    throw new SpecError('prefix', 'The folder may use letters, digits, dots, dashes, underscores and slashes.');
  }
  if (typeof input.pathStyle !== 'boolean') throw new SpecError('pathStyle', 'pathStyle must be true or false.');
  return { endpoint: u.origin, region, bucket, prefix, pathStyle: input.pathStyle };
}

export function parseS3Secrets(input: unknown): S3Secrets {
  if (!isObj(input)) throw new SpecError('secrets', 'Enter the access key.');
  const { accessKeyId, secretAccessKey } = input;
  if (typeof accessKeyId !== 'string' || !/^[A-Za-z0-9+/=_.-]{3,128}$/.test(accessKeyId)) throw new SpecError('accessKeyId', 'Enter the access key ID.');
  if (typeof secretAccessKey !== 'string' || !/^[\x21-\x7e]{8,256}$/.test(secretAccessKey)) throw new SpecError('secretAccessKey', 'Enter the secret access key.');
  return { accessKeyId, secretAccessKey };
}

export function parseS3Access(field: string, input: unknown): S3Access {
  if (!isObj(input)) throw new SpecError(field, 'Missing storage settings.');
  return { target: parseS3Target(input.target), secrets: parseS3Secrets(input.secrets) };
}

export function parseArtifactRef(input: unknown): ArtifactRef {
  if (!isObj(input)) throw new SpecError('ref', 'Invalid backup reference.');
  if (input.where !== 'local' && input.where !== 's3') throw new SpecError('ref', 'Invalid backup location.');
  const name = input.name;
  const m = typeof name === 'string' ? ARTIFACT.exec(name) : null;
  if (!m || input.plan !== m[1]) throw new SpecError('ref', 'Invalid backup name.');
  return { where: input.where, plan: m[1]!, name: name as string };
}

export function parseJobSpec(input: unknown): BackupJobSpec {
  if (!isObj(input)) throw new SpecError('job', 'Expected an object.');
  if (typeof input.plan !== 'string' || !PLAN_NAME.test(input.plan)) throw new SpecError('plan', 'Invalid plan name.');
  const sources = parseSources(input.sources);
  const local = input.local === true;
  const s3 = input.s3 === null || input.s3 === undefined ? null : parseS3Access('s3', input.s3);
  if (!local && !s3) throw new SpecError('destination', 'Choose where to keep the backup.');
  return {
    plan: input.plan,
    sources,
    mongoUris: parseMongoUris('mongoUris', sources, input.mongoUris, true),
    local,
    s3,
    retention: parseRetention(input.retention),
  };
}

export function parseRestoreSpec(input: unknown): RestoreSpec {
  if (!isObj(input)) throw new SpecError('restore', 'Expected an object.');
  const ref = parseArtifactRef(input.ref);
  const s3 = input.s3 === null || input.s3 === undefined ? null : parseS3Access('s3', input.s3);
  if (ref.where === 's3' && !s3) throw new SpecError('s3', 'Missing storage settings.');
  const items = input.items;
  if (!Array.isArray(items) || items.length === 0 || items.length > BACKUP_LIMITS.restoreItems) {
    throw new SpecError('items', 'Choose what to restore.');
  }
  const parsed = items.map((it): RestoreItem => {
    if (!isObj(it) || typeof it.file !== 'string' || !MEMBER_FILE.test(it.file)) throw new SpecError('items', 'Invalid item.');
    if (it.target !== 'original' && it.target !== 'alternate') throw new SpecError('items', 'Choose where to restore each folder.');
    return { file: it.file, target: it.target };
  });
  const mongoUris: Record<string, string> = {};
  if (isObj(input.mongoUris)) {
    for (const [k, v] of Object.entries(input.mongoUris)) {
      if (!SOURCE_NAME.test(k)) throw new SpecError('mongoUris', 'Invalid source name.');
      mongoUris[k] = parseMongoUri('mongoUris', v);
    }
  }
  return { ref, s3, items: parsed, mongoUris, drop: input.drop === true };
}

/** Timestamp part of an artifact name, as epoch ms. */
export function artifactTime(name: string): number | null {
  const m = ARTIFACT.exec(name);
  if (!m) return null;
  const [d, t] = [m[2]!, m[3]!];
  return Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8), +t.slice(0, 2), +t.slice(2, 4), +t.slice(4, 6));
}

export function artifactName(plan: string, at: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${plan}-${at.getUTCFullYear()}${p(at.getUTCMonth() + 1)}${p(at.getUTCDate())}-${p(at.getUTCHours())}${p(at.getUTCMinutes())}${p(at.getUTCSeconds())}.ovbk.tar`;
}
