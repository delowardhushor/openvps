import { chmodSync, chownSync, existsSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import { AgentError, type Pm2Target } from './pm2.ts';
import type { RuntimeDetector } from './runtimes.ts';
import type { AppSpec, ProcessInfo } from './spec.ts';

export interface AppsManagerOptions {
  target: Pm2Target;
  runtimes: RuntimeDetector;
  /** Directories app code may live in (resolved with realpath). */
  allowedRoots: string[];
  /**
   * Root-owned directory holding the generated PM2 ecosystem files. It must not be
   * writable by the apps user, otherwise it could plant symlinks the agent writes through.
   */
  specDir: string;
  /** Group allowed to read spec files (the apps user's group). null = leave as is (tests). */
  specGid: number | null;
  /** Node.js that runs the apps PM2 daemon; cluster mode always uses it. */
  daemonNode: string | null;
}

function within(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

function realDir(p: string): string | null {
  try {
    const r = realpathSync(p);
    return statSync(r).isDirectory() ? r : null;
  } catch {
    return null;
  }
}

export interface Ecosystem {
  apps: Record<string, unknown>[];
}

export class AppsManager {
  private readonly o: AppsManagerOptions;
  constructor(o: AppsManagerOptions) {
    this.o = o;
  }

  allowedRoots(): string[] {
    return this.o.allowedRoots;
  }

  specPath(name: string): string {
    return join(this.o.specDir, `${name}.json`);
  }

  /** Filesystem and runtime checks, then the PM2 ecosystem definition. */
  async build(spec: AppSpec, env: Record<string, string>): Promise<Ecosystem> {
    const roots = this.o.allowedRoots.map(realDir).filter((r): r is string => r !== null);
    const cwd = realDir(spec.cwd);
    if (!cwd) throw new AgentError('invalid', `Directory ${spec.cwd} does not exist.`, 'cwd');
    if (!roots.some((r) => within(cwd, r) && cwd !== r)) {
      throw new AgentError(
        'invalid',
        `Application directories must be inside ${this.o.allowedRoots.join(' or ')} (for example ${this.o.allowedRoots[0]}/${spec.name}).`,
        'cwd',
      );
    }

    const runtimes = await this.o.runtimes.list();
    const rt = runtimes.find((r) => r.path === spec.runtime);
    if (!rt) throw new AgentError('invalid', 'That Node.js runtime is not available to the apps user.', 'runtime');
    if (spec.execMode === 'cluster' && this.o.daemonNode && spec.runtime !== this.o.daemonNode) {
      throw new AgentError(
        'invalid',
        `Cluster mode always runs on the Node.js that runs PM2 (${this.o.daemonNode}). Choose that runtime, or use fork mode.`,
        'execMode',
      );
    }

    let script: string;
    let args: string[];
    if (spec.startType === 'file') {
      let entry: string;
      try {
        entry = realpathSync(join(cwd, spec.script!));
      } catch {
        throw new AgentError('invalid', `Entry file ${spec.script} was not found in ${spec.cwd}.`, 'script');
      }
      if (!within(entry, cwd) || !statSync(entry).isFile()) {
        throw new AgentError('invalid', 'Entry file must be a file inside the application directory.', 'script');
      }
      script = entry;
      args = spec.args;
    } else {
      if (!rt.npmCli) throw new AgentError('invalid', `npm was not found next to ${rt.path}. Use a runtime that includes npm, or start an entry file.`, 'runtime');
      if (!existsSync(join(cwd, 'package.json'))) throw new AgentError('invalid', `No package.json in ${spec.cwd}.`, 'npmScript');
      script = rt.npmCli;
      args = ['run', spec.npmScript!, ...(spec.args.length ? ['--', ...spec.args] : [])];
    }

    const binDir = dirname(rt.path);
    const app: Record<string, unknown> = {
      name: spec.name,
      cwd,
      script,
      args,
      interpreter: rt.path,
      exec_mode: spec.execMode,
      instances: spec.instances,
      autorestart: true,
      merge_logs: true,
      time: true,
      env: {
        NODE_ENV: 'production',
        PATH: `${binDir}:/usr/local/bin:/usr/bin:/bin`,
        ...env,
      },
    };
    if (spec.maxMemoryMb) app.max_memory_restart = `${spec.maxMemoryMb}M`;
    return { apps: [app] };
  }

  private writeSpec(name: string, eco: Ecosystem): string {
    if (!existsSync(this.o.specDir)) mkdirSync(this.o.specDir, { recursive: true, mode: 0o750 });
    if (this.o.specGid !== null) {
      // root-owned (so the apps user cannot plant symlinks), group-readable by the apps user.
      chownSync(this.o.specDir, 0, this.o.specGid);
      chmodSync(this.o.specDir, 0o750);
    }
    const file = this.specPath(name);
    const tmp = `${file}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(eco, null, 2) + '\n', { mode: 0o640, flag: 'wx' });
    if (this.o.specGid !== null) chownSync(tmp, 0, this.o.specGid);
    chmodSync(tmp, 0o640);
    renameSync(tmp, file);
    return file;
  }

  /** Create or replace an app in the apps PM2 and (re)start it. */
  async apply(spec: AppSpec, env: Record<string, string>, start: boolean): Promise<ProcessInfo | null> {
    const eco = await this.build(spec, env);
    const file = this.writeSpec(spec.name, eco);
    if (!start) return this.o.target.find(spec.name);
    // Replace rather than reload so changes to script, cwd, mode or instances always take effect.
    if (await this.o.target.find(spec.name)) await this.o.target.delete(spec.name);
    await this.o.target.startFile(file);
    await this.o.target.save();
    const proc = await this.o.target.find(spec.name);
    if (!proc) throw new AgentError('pm2_error', 'PM2 did not start the application.');
    return proc;
  }

  async remove(name: string): Promise<void> {
    if (await this.o.target.find(name)) {
      await this.o.target.delete(name);
      await this.o.target.save();
    }
    rmSync(this.specPath(name), { force: true });
  }
}
