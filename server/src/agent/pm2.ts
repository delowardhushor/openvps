import { execFile } from 'node:child_process';
import { constants as FS, readFileSync, realpathSync } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Owner, ProcessInfo, ControlOp, Pm2Status } from './spec.ts';

export class AgentError extends Error {
  readonly code: string;
  readonly field: string | undefined;
  constructor(code: string, message: string, field?: string) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

export interface Pm2TargetOptions {
  owner: Owner;
  /** pm2 entry point: the pm2 executable, or its bin/pm2 JS file when `node` is set. */
  bin: string;
  /** Node.js binary used to run `bin`. When null, `bin` is executed directly. */
  node: string | null;
  /** PM2_HOME of this PM2 instance. */
  pm2Home: string;
  /** HOME of the user the daemon runs as. */
  userHome: string;
  /** Run commands as this user via runuser (agent runs as root). null = as the agent's own user. */
  runAs: string | null;
  /** Directories prepended to PATH (so a pm2 installed under nvm finds its node). */
  pathDirs: string[];
  /** Uid that owns this daemon's log files; used to refuse symlinked/foreign files. null = skip check. */
  logOwnerUid: number | null;
  /**
   * Make sure the daemon is running before talking to it, e.g. `systemctl start openvps-apps`.
   * When absent, commands are refused while the daemon is down, because invoking the pm2 CLI
   * would otherwise spawn a daemon inside the agent's own service.
   */
  ensureDaemon?: () => Promise<void>;
  timeoutMs?: number;
  /**
   * How long a `pm2 jlist` result is reused, in ms. Every listing starts a whole Node + PM2 CLI
   * process, which is the most expensive thing the agent does on a small VPS. Concurrent
   * callers share one run, and any change made through this target drops the cache. 0 = off.
   */
  listCacheMs?: number;
  /** Directory for Node's compile cache, which makes each PM2 CLI start noticeably cheaper. */
  compileCacheDir?: string;
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin';
const RUNUSER = ['/usr/sbin/runuser', '/sbin/runuser', '/usr/bin/runuser'];

function findRunuser(): string {
  for (const p of RUNUSER) {
    try {
      realpathSync(p);
      return p;
    } catch {
      /* try next */
    }
  }
  throw new AgentError('agent_misconfigured', 'runuser not found');
}

/** Raw PM2 `jlist` entry: only the fields we read. Everything else (notably env) is dropped. */
interface RawProc {
  name?: string;
  pid?: number;
  pm_id?: number;
  monit?: { cpu?: number; memory?: number };
  pm2_env?: {
    status?: string;
    pm_uptime?: number;
    restart_time?: number;
    unstable_restarts?: number;
    exec_mode?: string;
    pm_exec_path?: string;
    pm_cwd?: string;
    exec_interpreter?: string;
    node_version?: string;
    pm_out_log_path?: string;
    pm_err_log_path?: string;
  };
}

const STATUSES: ProcessInfo['status'][] = ['online', 'stopped', 'errored', 'launching', 'stopping', 'one-launch-status'];

/** Parse `pm2 jlist` output, tolerating warnings PM2 sometimes prints before the JSON. */
export function parseJlist(stdout: string): RawProc[] {
  const start = stdout.indexOf('[');
  const end = stdout.lastIndexOf(']');
  if (start < 0 || end < start) throw new AgentError('pm2_error', 'PM2 returned no process list.');
  let data: unknown;
  try {
    data = JSON.parse(stdout.slice(start, end + 1));
  } catch {
    throw new AgentError('pm2_error', 'PM2 returned an unreadable process list.');
  }
  if (!Array.isArray(data)) throw new AgentError('pm2_error', 'PM2 returned an unexpected process list.');
  return data as RawProc[];
}

/** Group instances by name (cluster mode lists one entry per instance) and keep only safe fields. */
export function normalize(raw: RawProc[], owner: Owner): ProcessInfo[] {
  const byName = new Map<string, RawProc[]>();
  for (const p of raw) {
    if (typeof p.name !== 'string') continue;
    const list = byName.get(p.name) ?? [];
    list.push(p);
    byName.set(p.name, list);
  }
  const out: ProcessInfo[] = [];
  for (const [name, procs] of byName) {
    const statuses = procs.map((p) => p.pm2_env?.status ?? 'unknown');
    // Worst status wins so problems are never hidden behind a healthy instance.
    const rank = ['errored', 'stopping', 'launching', 'stopped', 'one-launch-status', 'online'];
    let status = statuses.reduce((a, b) => (rank.indexOf(a) <= rank.indexOf(b) ? a : b), 'online');
    if (!STATUSES.includes(status as ProcessInfo['status'])) status = 'unknown';
    const first = procs[0]!.pm2_env ?? {};
    const online = procs.filter((p) => p.pm2_env?.status === 'online');
    const uptimes = online.map((p) => p.pm2_env?.pm_uptime).filter((u): u is number => typeof u === 'number');
    const em = first.exec_mode ?? '';
    out.push({
      name,
      owner,
      status: status as ProcessInfo['status'],
      instances: procs.length,
      pids: procs.map((p) => p.pid).filter((x): x is number => typeof x === 'number' && x > 0),
      cpu: Math.round(procs.reduce((s, p) => s + (p.monit?.cpu ?? 0), 0) * 10) / 10,
      memoryBytes: procs.reduce((s, p) => s + (p.monit?.memory ?? 0), 0),
      startedAt: uptimes.length ? Math.min(...uptimes) : null,
      restarts: procs.reduce((s, p) => s + (p.pm2_env?.restart_time ?? 0), 0),
      unstableRestarts: procs.reduce((s, p) => s + (p.pm2_env?.unstable_restarts ?? 0), 0),
      execMode: em.startsWith('cluster') ? 'cluster' : em.startsWith('fork') ? 'fork' : 'unknown',
      script: first.pm_exec_path ?? null,
      cwd: first.pm_cwd ?? null,
      interpreter: first.exec_interpreter ?? null,
      nodeVersion: first.node_version ?? null,
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function logPaths(raw: RawProc[], name: string, stream: 'out' | 'err'): string[] {
  const set = new Set<string>();
  for (const p of raw) {
    if (p.name !== name) continue;
    const path = stream === 'out' ? p.pm2_env?.pm_out_log_path : p.pm2_env?.pm_err_log_path;
    if (typeof path === 'string' && path.startsWith('/') && path !== '/dev/null') set.add(path);
  }
  return [...set];
}

/**
 * Read the last `lines` lines of a log file, reading at most `maxBytes` from the end.
 * The file is opened without following a final symlink and must be a regular file owned
 * by `ownerUid`, so an unprivileged app cannot point its log path at another user's file.
 */
export async function tailFile(path: string, lines: number, ownerUid: number | null, maxBytes = 512 * 1024): Promise<string[]> {
  let fh;
  try {
    fh = await open(path, FS.O_RDONLY | FS.O_NOFOLLOW | FS.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return [];
    if (code === 'ELOOP') throw new AgentError('log_refused', 'Log file is a symbolic link; refusing to read it.');
    throw new AgentError('log_unreadable', `Cannot open log file (${code}).`);
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new AgentError('log_refused', 'Log path is not a regular file.');
    if (ownerUid !== null && st.uid !== ownerUid) throw new AgentError('log_refused', 'Log file is not owned by the application user.');
    const size = st.size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.alloc(len);
    await fh.read(buf, 0, len, size - len);
    let text = buf.toString('utf8');
    if (len < size) text = text.slice(text.indexOf('\n') + 1); // drop the partial first line
    const all = text.split('\n');
    if (all.at(-1) === '') all.pop();
    return all.slice(-lines);
  } finally {
    await fh.close();
  }
}

export class Pm2Target {
  readonly opts: Pm2TargetOptions;
  constructor(opts: Pm2TargetOptions) {
    this.opts = opts;
  }

  get owner(): Owner {
    return this.opts.owner;
  }

  env(): Record<string, string> {
    return {
      HOME: this.opts.userHome,
      PM2_HOME: this.opts.pm2Home,
      PATH: [...this.opts.pathDirs, SYSTEM_PATH].join(':'),
      LANG: 'C.UTF-8',
      // Node >= 22.1 reuses compiled code between runs; older Nodes ignore it.
      ...(this.opts.compileCacheDir ? { NODE_COMPILE_CACHE: this.opts.compileCacheDir } : {}),
    };
  }

  private listCache: { at: number; raw: RawProc[] } | null = null;
  private listInflight: { epoch: number; p: Promise<RawProc[]> } | null = null;
  /** Bumped by every change so a listing that started before it is never cached. */
  private listEpoch = 0;

  /** Forget the cached process list; call after anything that can change it. */
  invalidate(): void {
    this.listEpoch++;
    this.listCache = null;
  }

  run(args: string[], timeoutMs = this.opts.timeoutMs ?? 60_000): Promise<RunResult> {
    const env = this.env();
    const cmd = this.opts.node ? [this.opts.node, this.opts.bin, ...args] : [this.opts.bin, ...args];
    let file: string;
    let argv: string[];
    if (this.opts.runAs && process.getuid?.() === 0) {
      file = findRunuser();
      argv = ['-u', this.opts.runAs, '--', '/usr/bin/env', '-i', ...Object.entries(env).map(([k, v]) => `${k}=${v}`), ...cmd];
    } else {
      file = cmd[0]!;
      argv = cmd.slice(1);
    }
    return new Promise((resolve) => {
      execFile(
        file,
        argv,
        { env: this.opts.runAs && process.getuid?.() === 0 ? { PATH: SYSTEM_PATH } : env, timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, cwd: '/' },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
          if (e?.code === 'ENOENT') {
            resolve({ code: 127, stdout: '', stderr: `${file}: not found` });
            return;
          }
          resolve({
            code: e ? (e.killed ? 124 : typeof e.code === 'number' ? e.code : 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
          });
        },
      );
    });
  }

  /** True when the PM2 daemon for this target is running (checked without invoking pm2). */
  daemonAlive(): boolean {
    let pid: number;
    try {
      pid = Number(readFileSync(join(this.opts.pm2Home, 'pm2.pid'), 'utf8').trim());
    } catch {
      return false;
    }
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === 'EPERM';
    }
  }

  binaryExists(): boolean {
    try {
      realpathSync(this.opts.bin);
      if (this.opts.node) realpathSync(this.opts.node);
      return true;
    } catch {
      return false;
    }
  }

  /** PM2 version read from its package.json; does not touch the daemon. */
  version(): string | null {
    try {
      let dir = dirname(realpathSync(this.opts.bin));
      for (let i = 0; i < 4; i++) {
        try {
          const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
          if (pkg.name === 'pm2' && pkg.version) return pkg.version;
        } catch {
          /* keep walking up */
        }
        dir = dirname(dir);
      }
    } catch {
      /* not installed */
    }
    return null;
  }

  async status(): Promise<Pm2Status> {
    if (!this.binaryExists()) return { available: false, reason: 'PM2 is not installed for this user.', version: null };
    if (!this.daemonAlive() && this.opts.ensureDaemon) {
      try {
        await this.opts.ensureDaemon();
      } catch {
        /* reported below */
      }
    }
    if (!this.daemonAlive()) return { available: false, reason: 'The PM2 daemon is not running.', version: this.version() };
    return { available: true, reason: null, version: this.version() };
  }

  private async ready(): Promise<void> {
    const s = await this.status();
    if (!s.available) throw new AgentError('pm2_unavailable', s.reason ?? 'PM2 is not available.');
  }

  private async checked(args: string[], what: string): Promise<RunResult> {
    if (args[0] !== 'jlist') this.invalidate();
    const r = await this.run(args);
    if (args[0] !== 'jlist') this.invalidate();
    if (r.code !== 0) {
      const detail = (r.stderr || r.stdout).replace(/\x1b\[[0-9;]*m/g, '').trim().split('\n').slice(-3).join(' ');
      throw new AgentError('pm2_error', `${what} failed${r.code === 124 ? ' (timed out)' : ''}: ${detail.slice(0, 400)}`);
    }
    return r;
  }

  /**
   * The raw process list. `maxAgeMs` lets callers that only need slow-changing facts (such as log
   * file paths) accept an older result than the target's default; `fresh` forces a new run.
   */
  async rawList(opts: { maxAgeMs?: number; fresh?: boolean } = {}): Promise<RawProc[]> {
    const ttl = opts.fresh ? 0 : Math.max(opts.maxAgeMs ?? 0, this.opts.listCacheMs ?? 0);
    const c = this.listCache;
    if (ttl > 0 && c && Date.now() - c.at < ttl) return c.raw;
    const epoch = this.listEpoch;
    if (ttl > 0 && this.listInflight && this.listInflight.epoch === epoch) return this.listInflight.p;
    const p = (async () => {
      await this.ready();
      const r = await this.checked(['jlist'], 'Listing processes');
      const raw = parseJlist(r.stdout);
      if (epoch === this.listEpoch && (this.opts.listCacheMs ?? 0) > 0) this.listCache = { at: Date.now(), raw };
      return raw;
    })();
    if (ttl > 0) {
      const mine = { epoch, p };
      this.listInflight = mine;
      const clear = () => {
        if (this.listInflight === mine) this.listInflight = null;
      };
      p.then(clear, clear);
    }
    return p;
  }

  async list(opts: { fresh?: boolean } = {}): Promise<ProcessInfo[]> {
    return normalize(await this.rawList(opts), this.owner);
  }

  async find(name: string, opts: { fresh?: boolean } = {}): Promise<ProcessInfo | null> {
    return (await this.list(opts)).find((p) => p.name === name) ?? null;
  }

  async control(name: string, op: ControlOp): Promise<ProcessInfo> {
    const existing = await this.find(name);
    if (!existing) throw new AgentError('not_found', `No PM2 process named "${name}".`);
    await this.checked([op, name], `pm2 ${op} ${name}`);
    return (await this.find(name)) ?? { ...existing, status: 'unknown' };
  }

  async logs(name: string, stream: 'out' | 'err', lines: number): Promise<{ path: string | null; lines: string[] }> {
    // Log paths only change when the process is (re)started, which drops the cache anyway.
    const raw = await this.rawList({ maxAgeMs: 30_000 });
    if (!raw.some((p) => p.name === name)) throw new AgentError('not_found', `No PM2 process named "${name}".`);
    const paths = logPaths(raw, name, stream);
    if (paths.length === 0) return { path: null, lines: [] };
    const chunks: string[] = [];
    for (const p of paths.slice(0, 16)) chunks.push(...(await tailFile(p, lines, this.opts.logOwnerUid)));
    return { path: paths[0]!, lines: chunks.slice(-lines) };
  }

  async startFile(ecosystemFile: string): Promise<void> {
    await this.ready();
    await this.checked(['start', ecosystemFile], 'Starting the application');
  }

  async delete(name: string): Promise<void> {
    await this.ready();
    await this.checked(['delete', name], `Removing ${name}`);
  }

  async save(): Promise<void> {
    await this.checked(['save', '--force'], 'Saving the PM2 process list');
  }
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}
