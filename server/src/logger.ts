import { redact } from './redact.ts';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/**
 * Structured JSON-lines logger. Output goes to stdout/stderr so systemd's
 * journal captures it. All fields pass through redaction first.
 */
export function createLogger(level: LogLevel = 'info', sink?: (line: string, lvl: LogLevel) => void): Logger {
  const min = ORDER[level];
  const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < min) return;
    const entry = { time: new Date().toISOString(), level: lvl, msg, ...(fields ? (redact(fields) as object) : {}) };
    const line = JSON.stringify(entry);
    if (sink) sink(line, lvl);
    else if (lvl === 'error' || lvl === 'warn') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
  };
}

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };
