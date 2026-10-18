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
};
