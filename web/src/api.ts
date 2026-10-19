/** Typed client for the OpenVPS API. Same-origin only; the session lives in an HttpOnly cookie. */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly field?: string;
  readonly retryAfterSeconds?: number;
  constructor(status: number, code: string, message: string, extra: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.field = typeof extra.field === 'string' ? extra.field : undefined;
    this.retryAfterSeconds = typeof extra.retryAfterSeconds === 'number' ? extra.retryAfterSeconds : undefined;
  }
}

type Listener = () => void;
const unauthListeners = new Set<Listener>();
/** Called whenever any request comes back 401, so the app can return to the sign-in screen. */
export function onUnauthenticated(fn: Listener): () => void {
  unauthListeners.add(fn);
  return () => unauthListeners.delete(fn);
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' };
  if (method !== 'GET') headers['X-OpenVPS-Request'] = '1';
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'same-origin',
      cache: 'no-store',
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the OpenVPS server.');
  }
  const data = (await res.json().catch(() => null)) as { error?: { code: string; message: string } & Record<string, unknown> } | null;
  if (!res.ok) {
    const err = data?.error;
    if (res.status === 401 && path !== '/api/auth/login') unauthListeners.forEach((l) => l());
    throw new ApiError(res.status, err?.code ?? 'http_' + res.status, err?.message ?? `Request failed (${res.status}).`, err ?? {});
  }
  return data as T;
}

// ---- Types mirroring the server responses ----

export interface User {
  id: number;
  username: string;
  role: 'admin';
  last_login_at: number | null;
  created_at: number;
}

export interface Disk {
  mountpoint: string;
  device: string;
  fstype: string;
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
}

export interface Snapshot {
  collectedAt: number;
  cpu: { percent: number; cores: number[]; count: number };
  load: [number, number, number];
  memory: {
    totalBytes: number;
    usedBytes: number;
    availableBytes: number;
    buffersCacheBytes: number;
    usedPercent: number;
    swapTotalBytes: number;
    swapUsedBytes: number;
  };
  disks: Disk[];
  network: { rxBytesPerSec: number; txBytesPerSec: number; interfaces: string[] } | null;
  uptimeSeconds: number;
}

export interface MetricsResponse {
  metrics: Snapshot | null;
  intervalSeconds: number;
  stale: boolean;
  error: string | null;
  serverTime: number;
}

export interface HistoryPoint {
  t: number;
  cpu: number;
  mem: number;
  disk: number;
  rx: number;
  tx: number;
}

export interface ServiceStatus {
  name: string;
  state: 'active' | 'inactive' | 'failed' | 'activating' | 'deactivating' | 'not-installed' | 'unknown';
  enabled: boolean | null;
}

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string | null;
  ip: string | null;
  action: string;
  target: string | null;
  outcome: 'success' | 'failure' | 'info';
  details: Record<string, unknown> | null;
}

export interface Overview extends MetricsResponse {
  version: string;
  host: {
    hostname: string;
    os: { name: string; version: string; id: string; prettyName: string };
    kernel: string;
    arch: string;
    cpuModel: string;
    cpuCount: number;
    supported: boolean;
    supportNote: string | null;
  };
  panel: { startedAt: number; tls: boolean; port: number; pid: number; nodeVersion: string; memoryRssBytes: number };
  services: ServiceStatus[];
  activity: { recent: AuditEntry[]; failures: AuditEntry[] };
  modules: Record<string, { available: boolean; phase: number }>;
}

export interface SessionInfo {
  id: string;
  current: boolean;
  createdAt: number;
  lastSeenAt: number;
  expiresAt: number;
  ip: string | null;
  userAgent: string | null;
}

export type Owner = 'root' | 'apps';
export type ControlOp = 'start' | 'stop' | 'restart' | 'reload';

export interface ProcessInfo {
  name: string;
  owner: Owner;
  status: 'online' | 'stopped' | 'errored' | 'launching' | 'stopping' | 'one-launch-status' | 'unknown';
  instances: number;
  pids: number[];
  cpu: number;
  memoryBytes: number;
  startedAt: number | null;
  restarts: number;
  unstableRestarts: number;
  execMode: 'fork' | 'cluster' | 'unknown';
  script: string | null;
  cwd: string | null;
  interpreter: string | null;
  nodeVersion: string | null;
}

export interface Pm2Status {
  available: boolean;
  reason: string | null;
  version: string | null;
}

export interface Runtime {
  path: string;
  version: string;
  npmCli: string | null;
}

export interface AgentInfo {
  version: string;
  root: Pm2Status & { manage: boolean };
  apps: Pm2Status & { user: string | null };
  runtimes: Runtime[];
  allowedRoots: string[];
}

export interface AppSpec {
  name: string;
  cwd: string;
  startType: 'file' | 'npm';
  script: string | null;
  npmScript: string | null;
  args: string[];
  runtime: string;
  instances: number;
  execMode: 'fork' | 'cluster';
  maxMemoryMb: number | null;
}

export interface AppRecord {
  id: number;
  name: string;
  spec: AppSpec;
  envKeys: string[];
  createdAt: number;
  updatedAt: number;
  lastAppliedAt: number | null;
  lastError: string | null;
}

export interface ProcessesResponse {
  agent: { available: boolean; reason: string | null };
  root: { status: Pm2Status; processes: ProcessInfo[] };
  apps: { status: Pm2Status; processes: ProcessInfo[] };
  registered: { name: string; spec: AppSpec; envKeys: string[]; lastError: string | null; process: ProcessInfo | null }[];
  fetchedAt: number;
}

export interface LogsResponse {
  path: string | null;
  lines: string[];
  stream: 'out' | 'err';
  fetchedAt: number;
}

export type SiteType = 'proxy' | 'static' | 'spa' | 'panel';

export interface SiteSpec {
  name: string;
  domains: string[];
  type: SiteType;
  upstreamPort: number | null;
  root: string | null;
  https: boolean;
  forceHttps: boolean;
  hsts: boolean;
  maxBodyMb: number;
}

export interface CertInfo {
  name: string | null;
  path: string;
  domains: string[];
  issuer: string;
  notBefore: number;
  notAfter: number;
  daysLeft: number;
  managed: boolean;
  renewable: boolean;
  usedBy: string[];
}

export interface ExistingServer {
  file: string;
  serverNames: string[];
  listens: string[];
  ssl: boolean;
  certificate: string | null;
  proxyPass: string[];
  root: string | null;
}

export interface NginxStatus {
  installed: boolean;
  version: string | null;
  running: boolean;
  configOk: boolean;
  configError: string | null;
  layout: 'sites' | 'confd' | null;
  ipv6: boolean;
  certbot: { installed: boolean; version: string | null; renewalTimer: string | null };
  existing: ExistingServer[];
}

export interface SiteState {
  name: string;
  file: string;
  enabled: boolean;
  certificate: CertInfo | null;
  httpsActive: boolean;
}

export interface SiteRecord {
  name: string;
  spec: SiteSpec;
  createdAt: number;
  updatedAt: number;
  lastError: string | null;
  state: SiteState | null;
}

export interface CheckResult {
  domain: string;
  addresses: string[];
  dnsOk: boolean;
  httpOk: boolean;
  message: string;
}

export interface SitesOverview {
  agent: { available: boolean; reason: string | null };
  nginx: NginxStatus | null;
  sites: SiteRecord[];
  certificates: CertInfo[];
  targets: { name: string; port: number | null }[];
  panel: { port: number; tls: boolean };
  certEmail: string | null;
}

export interface CertificateResult {
  checks: CheckResult[] | null;
  certificate: CertInfo | null;
  certificateError: string | null;
  state?: SiteState;
}

// ---- Backups ----

export type Schedule =
  | { kind: 'manual' }
  | { kind: 'hourly'; minute: number }
  | { kind: 'daily'; hour: number; minute: number }
  | { kind: 'weekly'; weekday: number; hour: number; minute: number };

export type BackupSource =
  | { type: 'files'; name: string; path: string; exclude: string[] }
  | { type: 'mongodb'; name: string; databases: string[] };

export interface Retention {
  keepLast: number;
  maxAgeDays: number | null;
}

export interface S3Target {
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
}

export type RunStatus = 'running' | 'succeeded' | 'partial' | 'failed';

export interface BackupRun {
  id: number;
  plan: string;
  kind: 'backup' | 'restore' | 'verify';
  trigger: 'manual' | 'schedule';
  jobId: string | null;
  status: RunStatus;
  startedAt: number;
  finishedAt: number | null;
  artifact: string | null;
  sizeBytes: number | null;
  step: string | null;
  message: string | null;
  result: { restored?: { source: string; kind: string; target: string }[]; checks?: { name: string; ok: boolean; detail: string }[] } | null;
  actor: string | null;
}

export interface BackupPlan {
  name: string;
  enabled: boolean;
  sources: BackupSource[];
  schedule: Schedule;
  retention: Retention;
  keepLocal: boolean;
  destination: string | null;
  nextRunAt: number | null;
  /** Connection strings with the password hidden, by MongoDB source name. */
  mongo: Record<string, string>;
  createdAt: number;
  updatedAt: number;
}

export interface BackupPlanView extends BackupPlan {
  running: BackupRun | null;
  lastBackup: BackupRun | null;
  lastSuccessAt: number | null;
}

export interface BackupDestination {
  name: string;
  target: S3Target;
  keyHint: string;
  createdAt: number;
  updatedAt: number;
  lastTestAt: number | null;
  lastTestOk: boolean | null;
  lastTestMessage: string | null;
  usedBy: string[];
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

export interface BackupsOverview {
  agent: { available: boolean; reason: string | null };
  status: BackupStatus | null;
  plans: BackupPlanView[];
  destinations: BackupDestination[];
  runs: BackupRun[];
  scheduler: boolean;
  timezone: string;
  serverTime: number;
}

export interface ArtifactInfo {
  where: 'local' | 's3';
  plan: string;
  name: string;
  sizeBytes: number;
  createdAt: number;
  complete: boolean;
}

export interface ManifestMember {
  file: string;
  kind: 'files' | 'mongodb';
  source: string;
  sizeBytes: number;
  sha256: string;
  path?: string;
  exclude?: string[];
  database?: string | null;
  current: { exists: boolean; entries: number; allowed: boolean } | null;
}

export interface InspectResult {
  manifest: { plan: string; artifact: string; createdAt: number; hostname: string; openvpsVersion: string };
  members: ManifestMember[];
  mongoSources: string[];
}

export interface PlanInput {
  name?: string;
  enabled: boolean;
  sources: BackupSource[];
  mongoUris: Record<string, string>;
  schedule: Schedule;
  retention: Retention;
  keepLocal: boolean;
  destination: string | null;
}

export interface DestinationInput {
  name?: string;
  target: S3Target;
  secrets: { accessKeyId: string; secretAccessKey: string };
}

export interface RestoreInput {
  where: 'local' | 'remote';
  artifact: string;
  items: { file: string; target: 'original' | 'alternate' }[];
  drop: boolean;
  confirm: string;
}

export interface MongoConnection {
  id: number;
  name: string;
  /** Connection string with the password hidden. */
  uri: string;
  createdAt: number;
  updatedAt: number;
  lastOkAt: number | null;
  lastError: string | null;
}

export interface MongoServer {
  version: string | null;
  topology: string;
  setName: string | null;
  role: string | null;
  host: string;
  port: number;
  tls: boolean;
  authenticated: boolean;
  canListDatabases: boolean;
}

export interface MongoDatabase {
  name: string;
  sizeOnDisk: number | null;
  empty: boolean;
}

export interface MongoCollection {
  name: string;
  type: string;
  capped: boolean;
  viewOn: string | null;
  system: boolean;
}

export interface MongoStats {
  count: number | null;
  size: number | null;
  avgObjSize: number | null;
  storageSize: number | null;
  totalIndexSize: number | null;
  indexCount: number | null;
  capped: boolean;
}

export interface MongoIndex {
  name: string;
  key: unknown;
  unique: boolean;
  sparse: boolean;
  ttlSeconds: number | null;
  partial: unknown | null;
  sizeBytes: number | null;
}

export interface MongoQuery {
  db: string;
  collection: string;
  filter: string;
  sort: string;
  projection: string;
  skip: number;
  limit: number;
}

export interface MongoFindResult {
  /** Documents in canonical Extended JSON. */
  documents: unknown[];
  total: number | null;
  skip: number;
  limit: number;
  ms: number;
}

// ---- File manager ----

export interface FileEntry {
  name: string;
  type: 'file' | 'dir' | 'link' | 'other';
  size: number;
  mtimeMs: number;
  mode: number;
  link?: 'file' | 'dir' | 'broken' | 'outside' | 'other';
}

export interface FileListing {
  root: string;
  path: string;
  entries: FileEntry[];
  truncated: boolean;
  disk: { availableBytes: number; totalBytes: number } | null;
}

export interface FilesInfo {
  roots: { path: string }[];
  maxUploadBytes: number;
  maxEditBytes: number;
}

export interface FileText {
  name: string;
  size: number;
  mtimeMs: number;
  content: string;
}

export interface UploadHandle {
  promise: Promise<{ size: number; mtimeMs: number; replaced: boolean }>;
  abort: () => void;
}

const q = (root: string, path: string) => `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`;

/** Link that makes the browser download a file (the session cookie authorises it). */
export const fileDownloadUrl = (root: string, path: string) => `/api/files/download?${q(root, path)}`;

/**
 * Send one file as the raw request body, reporting progress. `path` is the file's path below the
 * root and may contain folders, which the server creates.
 */
export function uploadFile(root: string, path: string, file: Blob, opts: { overwrite?: boolean; onProgress?: (sent: number, total: number) => void } = {}): UploadHandle {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ size: number; mtimeMs: number; replaced: boolean }>((resolve, reject) => {
    xhr.open('POST', `/api/files/upload?${q(root, path)}${opts.overwrite ? '&overwrite=1' : ''}`);
    xhr.setRequestHeader('X-OpenVPS-Request', '1');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    xhr.responseType = 'json';
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) opts.onProgress?.(e.loaded, e.total);
    };
    xhr.onerror = () => reject(new ApiError(0, 'network', 'The connection was lost during the upload.'));
    xhr.onabort = () => reject(new ApiError(0, 'aborted', 'The upload was cancelled.'));
    xhr.ontimeout = () => reject(new ApiError(0, 'timeout', 'The upload timed out.'));
    xhr.onload = () => {
      const data = xhr.response as ({ error?: { code: string; message: string } & Record<string, unknown> } & { size: number; mtimeMs: number; replaced: boolean }) | null;
      if (xhr.status >= 200 && xhr.status < 300 && data) return resolve(data);
      if (xhr.status === 401) unauthListeners.forEach((l) => l());
      const err = data?.error;
      reject(new ApiError(xhr.status, err?.code ?? 'http_' + xhr.status, err?.message ?? `Upload failed (${xhr.status}).`, err ?? {}));
    };
    xhr.send(file);
  });
  return { promise, abort: () => xhr.abort() };
}

export const api = {
  setupStatus: () => request<{ needsSetup: boolean; tokenIssued: boolean }>('GET', '/api/setup/status'),
  setup: (setupToken: string, username: string, password: string) =>
    request<{ user: User }>('POST', '/api/setup', { setupToken, username, password }),
  login: (username: string, password: string) => request<{ user: User }>('POST', '/api/auth/login', { username, password }),
  logout: () => request<{ ok: true }>('POST', '/api/auth/logout', {}),
  me: () => request<{ user: User; session: { createdAt: number; expiresAt: number; idleTimeoutMinutes: number } }>('GET', '/api/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<{ ok: true; otherSessionsRevoked: number }>('POST', '/api/auth/password', { currentPassword, newPassword }),
  sessions: () => request<{ sessions: SessionInfo[] }>('GET', '/api/auth/sessions'),
  revokeSession: (id: string) => request<{ ok: true }>('DELETE', `/api/auth/sessions/${encodeURIComponent(id)}`),
  revokeOtherSessions: () => request<{ ok: true; revoked: number }>('POST', '/api/auth/sessions/revoke-others', {}),
  overview: () => request<Overview>('GET', '/api/system/overview'),
  metrics: () => request<MetricsResponse>('GET', '/api/system/metrics'),
  history: () => request<{ intervalSeconds: number; points: HistoryPoint[] }>('GET', '/api/system/history'),
  audit: (q: { limit?: number; before?: number; outcome?: string; action?: string } = {}) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    return request<{ entries: AuditEntry[]; nextBefore: number | null }>('GET', `/api/audit?${p}`);
  },
  agent: () => request<{ available: true; info: AgentInfo } | { available: false; reason: string }>('GET', '/api/agent'),
  processes: () => request<ProcessesResponse>('GET', '/api/processes'),
  control: (owner: Owner, name: string, op: ControlOp) =>
    request<ProcessInfo>('POST', `/api/processes/${owner}/${encodeURIComponent(name)}/${op}`, {}),
  logs: (owner: Owner, name: string, stream: 'out' | 'err', lines: number) =>
    request<LogsResponse>('GET', `/api/processes/${owner}/${encodeURIComponent(name)}/logs?stream=${stream}&lines=${lines}`),
  apps: () => request<{ apps: AppRecord[] }>('GET', '/api/apps'),
  app: (name: string) => request<{ app: AppRecord }>('GET', `/api/apps/${encodeURIComponent(name)}`),
  createApp: (spec: AppSpec, env: Record<string, string>, start: boolean) =>
    request<{ app: AppRecord; process: ProcessInfo | null }>('POST', '/api/apps', { spec, env, start }),
  updateApp: (name: string, spec: AppSpec, restart: boolean) =>
    request<{ app: AppRecord; process: ProcessInfo | null }>('PUT', `/api/apps/${encodeURIComponent(name)}`, { spec, restart }),
  updateEnv: (name: string, set: Record<string, string>, unset: string[], restart: boolean) =>
    request<{ app: AppRecord; process: ProcessInfo | null }>('PUT', `/api/apps/${encodeURIComponent(name)}/env`, { set, unset, restart }),
  deleteApp: (name: string) => request<{ ok: true }>('DELETE', `/api/apps/${encodeURIComponent(name)}`),
  sites: () => request<SitesOverview>('GET', '/api/sites'),
  createSite: (spec: SiteSpec, issueCertificate: boolean) =>
    request<{ site: SiteRecord; state: SiteState; warnings: string[]; reload: string } & Partial<CertificateResult>>('POST', '/api/sites', {
      spec,
      issueCertificate,
    }),
  updateSite: (name: string, spec: SiteSpec) =>
    request<{ site: SiteRecord; state: SiteState; warnings: string[]; reload: string }>('PUT', `/api/sites/${encodeURIComponent(name)}`, { spec }),
  deleteSite: (name: string, deleteCertificate: boolean) =>
    request<{ ok: true; certificateDeleted: boolean }>('DELETE', `/api/sites/${encodeURIComponent(name)}?deleteCertificate=${deleteCertificate ? 1 : 0}`),
  checkSite: (name: string) => request<{ checks: CheckResult[] }>('POST', `/api/sites/${encodeURIComponent(name)}/check`, {}),
  issueCertificate: (name: string, skipChecks = false) =>
    request<CertificateResult>('POST', `/api/sites/${encodeURIComponent(name)}/certificate`, { skipChecks }),
  siteConfig: (name: string) => request<{ content: string; current: string | null }>('GET', `/api/sites/${encodeURIComponent(name)}/config`),
  certificates: () =>
    request<{ available: boolean; certificates: CertInfo[]; certbot: NginxStatus['certbot'] | null; nginxInstalled: boolean }>('GET', '/api/certificates'),
  certEmail: () => request<{ email: string | null }>('GET', '/api/settings/certificates'),
  setCertEmail: (email: string) => request<{ email: string | null }>('PUT', '/api/settings/certificates', { email }),
  backups: () => request<BackupsOverview>('GET', '/api/backups'),
  backupRun: (id: number) => request<{ run: BackupRun; log: string[] }>('GET', `/api/backups/runs/${id}`),
  createPlan: (input: PlanInput) => request<{ plan: BackupPlan }>('POST', '/api/backups/plans', input),
  updatePlan: (name: string, input: PlanInput) => request<{ plan: BackupPlan }>('PUT', `/api/backups/plans/${encodeURIComponent(name)}`, input),
  deletePlan: (name: string) => request<{ ok: true }>('DELETE', `/api/backups/plans/${encodeURIComponent(name)}`),
  runPlan: (name: string) => request<{ run: BackupRun }>('POST', `/api/backups/plans/${encodeURIComponent(name)}/run`, {}),
  artifacts: (name: string) =>
    request<{ local: ArtifactInfo[]; remote: ArtifactInfo[] | null; remoteError: string | null; hasRemote: boolean }>('GET', `/api/backups/plans/${encodeURIComponent(name)}/artifacts`),
  inspectBackup: (name: string, where: 'local' | 'remote', artifact: string) =>
    request<InspectResult>('GET', `/api/backups/plans/${encodeURIComponent(name)}/inspect?where=${where}&artifact=${encodeURIComponent(artifact)}`),
  verifyBackup: (name: string, where: 'local' | 'remote', artifact: string, deep: boolean) =>
    request<{ run: BackupRun }>('POST', `/api/backups/plans/${encodeURIComponent(name)}/verify`, { where, artifact, deep }),
  restoreBackup: (name: string, input: RestoreInput) => request<{ run: BackupRun }>('POST', `/api/backups/plans/${encodeURIComponent(name)}/restore`, input),
  deleteBackup: (name: string, where: 'local' | 'remote', artifact: string) =>
    request<{ ok: true }>('DELETE', `/api/backups/plans/${encodeURIComponent(name)}/artifacts?where=${where}&artifact=${encodeURIComponent(artifact)}`),
  createDestination: (input: DestinationInput) => request<{ destination: BackupDestination }>('POST', '/api/backups/destinations', input),
  updateDestination: (name: string, input: DestinationInput) =>
    request<{ destination: BackupDestination }>('PUT', `/api/backups/destinations/${encodeURIComponent(name)}`, input),
  deleteDestination: (name: string) => request<{ ok: true }>('DELETE', `/api/backups/destinations/${encodeURIComponent(name)}`),
  testDestination: (input: DestinationInput) => request<{ ok: true; ms: number }>('POST', '/api/backups/destinations/test', input),
  mongoConnections: () => request<{ connections: MongoConnection[] }>('GET', '/api/mongo/connections'),
  createMongoConnection: (name: string, uri: string) => request<{ connection: MongoConnection }>('POST', '/api/mongo/connections', { name, uri }),
  updateMongoConnection: (id: number, name: string, uri: string) => request<{ connection: MongoConnection }>('PUT', `/api/mongo/connections/${id}`, { name, uri }),
  deleteMongoConnection: (id: number) => request<{ ok: true }>('DELETE', `/api/mongo/connections/${id}`),
  testMongo: (input: { uri?: string; id?: number }) => request<{ ok: true; ms: number; server: MongoServer }>('POST', '/api/mongo/test', input),
  mongoDatabases: (id: number) => request<{ databases: MongoDatabase[]; note: string | null; server: MongoServer | null }>('GET', `/api/mongo/connections/${id}/databases`),
  mongoCollections: (id: number, db: string) =>
    request<{ collections: MongoCollection[] }>('GET', `/api/mongo/connections/${id}/databases/${encodeURIComponent(db)}/collections`),
  mongoStats: (id: number, db: string, collection: string) =>
    request<{ stats: MongoStats | null; indexes: MongoIndex[]; note: string | null }>(
      'GET',
      `/api/mongo/connections/${id}/databases/${encodeURIComponent(db)}/collections/${encodeURIComponent(collection)}/stats`,
    ),
  mongoQuery: (id: number, q: MongoQuery) => request<MongoFindResult>('POST', `/api/mongo/connections/${id}/query`, q),
  filesInfo: () => request<FilesInfo>('GET', '/api/files/roots'),
  filesList: (root: string, path: string) => request<FileListing>('GET', `/api/files/list?${q(root, path)}`),
  filesMkdir: (root: string, path: string) => request<{ ok: true }>('POST', '/api/files/mkdir', { root, path }),
  filesMove: (root: string, from: string, to: string) => request<{ ok: true }>('POST', '/api/files/move', { root, from, to }),
  filesDelete: (root: string, path: string) => request<{ ok: true; type: string }>('POST', '/api/files/delete', { root, path }),
  filesText: (root: string, path: string) => request<FileText>('GET', `/api/files/text?${q(root, path)}`),
  filesSaveText: (input: { root: string; path: string; content: string; mtimeMs?: number | null; create?: boolean }) =>
    request<{ size: number; mtimeMs: number }>('PUT', '/api/files/text', input),
};
