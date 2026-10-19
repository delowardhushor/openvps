/**
 * File manager, agent side. Every operation runs in a short-lived helper process (fileworker.ts)
 * under the user that owns the managed folder, so the agent itself never touches app files as
 * root. The agent validates the folder against its own allowlist, limits how many helpers run at
 * once, and relays bytes between the panel's socket and the helper.
 */
import { spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import type { Readable } from 'node:stream';
import type { Socket } from 'node:net';
import type { Logger } from '../logger.ts';
import { AgentError } from './pm2.ts';
import type { FileRequest } from './files-spec.ts';

export interface FilesOptions {
  /** Folders the file manager may open (from `files.roots`). */
  roots: string[];
  /** Absolute path of fileworker.js (or .ts in development). */
  workerPath: string;
  nodeBin: string;
  log: Logger;
  /** Helpers running at the same time; more wait their turn. */
  maxConcurrent?: number;
  /** Longest a quick operation (list, move, delete) may take. */
  timeoutMs?: number;
}

/** Small heap, no helper threads: these processes live for milliseconds. */
const NODE_FLAGS = ['--disable-warning=ExperimentalWarning', '--max-old-space-size=64', '--max-semi-space-size=1', '--v8-pool-size=0'];
const MAX_OUTPUT = 8 * 1024 * 1024;

class Slots {
  private free: number;
  private readonly waiting: Array<() => void> = [];
  constructor(n: number) {
    this.free = n;
  }
  async acquire(waitMs: number): Promise<() => void> {
    if (this.free > 0) {
      this.free--;
      return () => this.release();
    }
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => {
        const i = this.waiting.indexOf(go);
        if (i >= 0) this.waiting.splice(i, 1);
        reject(new AgentError('busy', 'The server is busy with other file operations. Try again in a moment.'));
      }, waitMs);
      const go = () => {
        clearTimeout(t);
        resolve();
      };
      this.waiting.push(go);
    });
    return () => this.release();
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.free++;
  }
}

interface Envelope {
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; field?: string };
}

export class FilesManager {
  private readonly o: FilesOptions;
  private readonly slots: Slots;

  constructor(o: FilesOptions) {
    this.o = o;
    this.slots = new Slots(o.maxConcurrent ?? 3);
  }

  /** Folders offered to the panel; informational. */
  get roots(): string[] {
    return this.o.roots;
  }

  /** The folder must be one the administrator configured; it is then resolved once, here. */
  private resolveRoot(root: string): { real: string; uid: number; gid: number } {
    if (!this.o.roots.includes(root)) throw new AgentError('forbidden', 'That folder is not managed by the file manager.', 'root');
    let real: string;
    let st;
    try {
      real = realpathSync(root);
      st = statSync(real);
    } catch {
      throw new AgentError('not_found', `The folder ${root} does not exist on this server.`, 'root');
    }
    if (!st.isDirectory()) throw new AgentError('not_found', `${root} is not a folder.`, 'root');
    return { real, uid: st.uid, gid: st.gid };
  }

  private spawnWorker(req: FileRequest, stdin: boolean): { child: ChildProcess; stderr: () => string } {
    const { real, uid, gid } = this.resolveRoot(req.params.root);
    const arg = JSON.stringify({ action: req.action, params: { ...req.params, root: real } });
    const opts: SpawnOptions = {
      cwd: '/',
      stdio: [stdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      env: { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8' },
    };
    // Work as the folder's owner. Only possible (and only needed) when the agent is root.
    if (process.getuid?.() === 0 && uid !== 0) {
      opts.uid = uid;
      opts.gid = gid;
    }
    const child = spawn(this.o.nodeBin, [...NODE_FLAGS, this.o.workerPath, arg], opts);
    let err = '';
    child.stderr?.on('data', (d: Buffer) => {
      if (err.length < 4096) err += d.toString('utf8');
    });
    return { child, stderr: () => err };
  }

  private fromEnvelope(out: string, code: number | null, stderr: string, action: string): unknown {
    const text = out.trim().split('\n').filter(Boolean).at(-1);
    let env: Envelope | null = null;
    try {
      env = text ? (JSON.parse(text) as Envelope) : null;
    } catch {
      env = null;
    }
    if (!env) {
      this.o.log.error('file helper failed', { action, exit: code, stderr: stderr.slice(0, 500) });
      throw new AgentError('internal', 'The file helper did not answer. See: journalctl -u openvps-agent');
    }
    if (!env.ok) throw new AgentError(env.error?.code ?? 'internal', env.error?.message ?? 'The file operation failed.', env.error?.field);
    return env.result;
  }

  private collect(child: ChildProcess, stderr: () => string, action: string, timeoutMs: number | null): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let out = '';
      let size = 0;
      const timer =
        timeoutMs === null
          ? null
          : setTimeout(() => {
              child.kill('SIGKILL');
              reject(new AgentError('timeout', 'The file operation took too long.'));
            }, timeoutMs);
      child.stdout?.on('data', (d: Buffer) => {
        size += d.length;
        if (size > MAX_OUTPUT) {
          child.kill('SIGKILL');
          return;
        }
        out += d.toString('utf8');
      });
      child.on('error', (e) => {
        if (timer) clearTimeout(timer);
        this.o.log.error('file helper could not start', { action, error: e });
        reject(new AgentError('internal', 'The file helper could not be started. See: journalctl -u openvps-agent'));
      });
      child.on('close', (code) => {
        if (timer) clearTimeout(timer);
        try {
          resolve(this.fromEnvelope(out, code, stderr(), action));
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** list, mkdir, move, delete */
  async run(req: Exclude<FileRequest, { action: 'files.upload' | 'files.download' }>): Promise<unknown> {
    this.resolveRoot(req.params.root);
    const release = await this.slots.acquire(15_000);
    try {
      const { child, stderr } = this.spawnWorker(req, false);
      return await this.collect(child, stderr, req.action, this.o.timeoutMs ?? 30_000);
    } finally {
      release();
    }
  }

  /** Write the bytes of `body` (exactly `size` of them) to a file. */
  async upload(req: Extract<FileRequest, { action: 'files.upload' }>, body: Readable): Promise<unknown> {
    this.resolveRoot(req.params.root);
    let release: () => void;
    try {
      release = await this.slots.acquire(15_000);
    } catch (e) {
      body.destroy();
      throw e;
    }
    try {
      const { child, stderr } = this.spawnWorker(req, true);
      const done = this.collect(child, stderr, req.action, null);
      done.catch(() => undefined);
      const stdin = child.stdin!;
      stdin.on('error', () => undefined); // the helper may answer and exit before reading everything
      body.on('error', () => {
        stdin.destroy(); // the sender went away: the helper sees a short upload and cleans up
      });
      body.pipe(stdin);
      return await done;
    } finally {
      release();
      body.destroy();
    }
  }

  /**
   * Stream a file to `sock`: the helper's answer line, then the bytes. The socket is ended
   * when the helper is done; if it fails before sending anything, an error line is sent.
   */
  async download(req: Extract<FileRequest, { action: 'files.download' }>, sock: Socket): Promise<void> {
    const fail = (e: AgentError) => {
      if (!sock.destroyed) sock.end(JSON.stringify({ ok: false, error: { code: e.code, message: e.message } }) + '\n');
    };
    let release: () => void;
    try {
      this.resolveRoot(req.params.root);
      release = await this.slots.acquire(15_000);
    } catch (e) {
      if (e instanceof AgentError) return fail(e);
      throw e;
    }
    let sent = false;
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      release();
    };
    try {
      const { child, stderr } = this.spawnWorker(req, false);
      sock.on('close', () => {
        child.kill('SIGKILL');
        finish();
      });
      child.stdout?.on('data', () => {
        sent = true;
      });
      child.stdout?.pipe(sock, { end: false });
      child.on('error', (e) => {
        this.o.log.error('file helper could not start', { action: req.action, error: e });
        finish();
        fail(new AgentError('internal', 'The file helper could not be started. See: journalctl -u openvps-agent'));
      });
      child.on('close', (code) => {
        finish();
        if (!sent) {
          this.o.log.error('file helper failed', { action: req.action, exit: code, stderr: stderr().slice(0, 500) });
          fail(new AgentError('internal', 'The file helper did not answer. See: journalctl -u openvps-agent'));
        } else if (!sock.destroyed) {
          // Let the pipe drain, then close: the panel counts the bytes it was promised.
          setImmediate(() => sock.end());
        }
      });
    } catch (e) {
      finish();
      if (e instanceof AgentError) return fail(e);
      throw e;
    }
  }
}
