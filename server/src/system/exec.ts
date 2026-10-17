import { execFile } from 'node:child_process';

/**
 * The only way OpenVPS runs external programs.
 *
 * Security model (NFR 7.1): there is no generic "run a command" API. Each
 * permitted program is listed here with an absolute path, it is started with
 * execFile (no shell, so no shell metacharacter injection), arguments are
 * validated by the caller-specific wrapper, and every call has a timeout and
 * output cap. Later phases add privileged actions through a separate,
 * narrowly-scoped helper rather than by widening this list.
 */
const ALLOWED: Record<string, string[]> = {
  systemctl: ['/usr/bin/systemctl', '/bin/systemctl'],
};

export type AllowedProgram = keyof typeof ALLOWED;

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export type Runner = (program: AllowedProgram, args: string[], timeoutMs?: number) => Promise<ExecResult>;

export const SAFE_ARG = /^[A-Za-z0-9@._:=,\/-]{1,128}$/;

export const runAllowed: Runner = (program, args, timeoutMs = 5000) => {
  const candidates = ALLOWED[program];
  if (!candidates) return Promise.reject(new Error(`Program not allowed: ${program}`));
  for (const a of args) if (!SAFE_ARG.test(a)) return Promise.reject(new Error(`Unsafe argument: ${a}`));
  return new Promise((resolve) => {
    const tryAt = (i: number) => {
      const bin = candidates[i];
      if (!bin) {
        resolve({ code: 127, stdout: '', stderr: `${program} not found`, timedOut: false });
        return;
      }
      execFile(
        bin,
        args,
        { timeout: timeoutMs, maxBuffer: 256 * 1024, env: { PATH: '/usr/bin:/bin', LANG: 'C' }, windowsHide: true },
        (err, stdout, stderr) => {
          const e = err as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
          if (e && e.code === 'ENOENT') return tryAt(i + 1);
          resolve({
            code: e ? (typeof e.code === 'number' ? e.code : 1) : 0,
            stdout: String(stdout),
            stderr: String(stderr),
            timedOut: !!e?.killed,
          });
        },
      );
    };
    tryAt(0);
  });
};
