import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';

export interface ToolResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

const SYSTEM_PATH = '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin:/snap/bin';

/** Run a program directly (no shell) with a minimal environment, timeout and output cap. */
export function runTool(file: string, args: string[], opts: { timeoutMs?: number; env?: Record<string, string> } = {}): Promise<ToolResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        timeout: opts.timeoutMs ?? 30_000,
        maxBuffer: 8 * 1024 * 1024,
        cwd: '/',
        env: { PATH: SYSTEM_PATH, LANG: 'C.UTF-8', ...(opts.env ?? {}) },
      },
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & { code?: number | string; killed?: boolean }) | null;
        if (e?.code === 'ENOENT') {
          resolve({ code: 127, stdout: '', stderr: `${file}: not found`, timedOut: false });
          return;
        }
        resolve({
          code: e ? (e.killed ? 124 : typeof e.code === 'number' ? e.code : 1) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: !!e?.killed,
        });
      },
    );
  });
}

export function firstExisting(paths: string[]): string | null {
  for (const p of paths) if (existsSync(p)) return p;
  return null;
}

/** Last few meaningful lines of tool output, for error messages. */
export function tail(text: string, lines = 6): string {
  return text
    .replace(/\x1b\[[0-9;]*m/g, '')
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() && !/^- - -/.test(l))
    .slice(-lines)
    .join('\n');
}
