import { execFile } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Runtime } from './spec.ts';

export const DEFAULT_RUNTIME_CANDIDATES = ['/usr/bin/node', '/usr/local/bin/node', '/opt/openvps/node/bin/node'];

function nodeVersion(bin: string, runAs: string | null): Promise<string | null> {
  const asRoot = process.getuid?.() === 0 && runAs;
  const file = asRoot ? '/usr/sbin/runuser' : bin;
  const args = asRoot ? ['-u', runAs, '--', bin, '-v'] : ['-v'];
  return new Promise((resolve) => {
    execFile(file, args, { timeout: 5000, env: { PATH: '/usr/bin:/bin' }, cwd: '/' }, (err, stdout) => {
      const v = String(stdout).trim();
      resolve(!err && /^v\d+\.\d+\.\d+/.test(v) ? v : null);
    });
  });
}

function findNpmCli(nodeBin: string): string | null {
  const real = (() => {
    try {
      return realpathSync(nodeBin);
    } catch {
      return nodeBin;
    }
  })();
  const candidates = [
    join(dirname(nodeBin), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(real), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    '/usr/share/nodejs/npm/bin/npm-cli.js', // Ubuntu's apt "npm" package
    '/usr/lib/node_modules/npm/bin/npm-cli.js',
  ];
  for (const c of candidates) {
    try {
      const p = realpathSync(c);
      if (statSync(p).isFile()) return p;
    } catch {
      /* next */
    }
  }
  return null;
}

/**
 * Node.js installations the apps user can run. Each candidate is executed once
 * as that user (`node -v`) to prove it is runnable, then cached briefly.
 */
export class RuntimeDetector {
  private cache: { at: number; list: Runtime[] } | null = null;
  private readonly candidates: string[];
  private readonly runAs: string | null;
  constructor(candidates: string[], runAs: string | null) {
    this.candidates = candidates;
    this.runAs = runAs;
  }

  async list(): Promise<Runtime[]> {
    if (this.cache && Date.now() - this.cache.at < 60_000) return this.cache.list;
    const seen = new Set<string>();
    const out: Runtime[] = [];
    for (const c of this.candidates) {
      if (!existsSync(c)) continue;
      let real: string;
      try {
        real = realpathSync(c);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      const version = await nodeVersion(c, this.runAs);
      if (version) out.push({ path: c, version, npmCli: findNpmCli(c) });
    }
    this.cache = { at: Date.now(), list: out };
    return out;
  }

  invalidate(): void {
    this.cache = null;
  }
}
