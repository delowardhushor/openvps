/**
 * Shared definitions for the panel <-> agent protocol and the validation of
 * application specs. Both sides validate: the panel to give good error
 * messages, the agent because it is the privilege boundary and trusts nothing.
 */

export type Owner = 'root' | 'apps';
export const OWNERS: readonly Owner[] = ['root', 'apps'];

export type ControlOp = 'start' | 'stop' | 'restart' | 'reload';
export const CONTROL_OPS: readonly ControlOp[] = ['start', 'stop', 'restart', 'reload'];

export type LogStream = 'out' | 'err';

/** The complete list of things the agent will do. Nothing else is accepted. */
export type AgentRequest =
  | { action: 'agent.info'; params?: Record<string, never> }
  | { action: 'pm2.list'; params: { owner: Owner } }
  | { action: 'pm2.control'; params: { owner: Owner; name: string; op: ControlOp } }
  | { action: 'pm2.logs'; params: { owner: Owner; name: string; stream: LogStream; lines: number } }
  | { action: 'app.apply'; params: { spec: AppSpec; env: Record<string, string>; start: boolean } }
  | { action: 'app.remove'; params: { name: string } };

export type AgentAction = AgentRequest['action'];
export const AGENT_ACTIONS: readonly AgentAction[] = [
  'agent.info',
  'pm2.list',
  'pm2.control',
  'pm2.logs',
  'app.apply',
  'app.remove',
];

export type AgentResponse<T = unknown> =
  | { ok: true; result: T }
  | { ok: false; error: { code: string; message: string; field?: string } };

export interface ProcessInfo {
  name: string;
  owner: Owner;
  status: 'online' | 'stopped' | 'errored' | 'launching' | 'stopping' | 'one-launch-status' | 'unknown';
  instances: number;
  pids: number[];
  cpu: number;
  memoryBytes: number;
  /** Epoch ms when the (oldest running) instance started, or null. */
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
  /** Why it is unavailable, for display. */
  reason: string | null;
  version: string | null;
}

export interface Runtime {
  path: string;
  version: string;
  /** Path to npm-cli.js if npm is installed alongside this Node.js. */
  npmCli: string | null;
}

export interface AgentInfo {
  version: string;
  root: Pm2Status & { manage: boolean };
  apps: Pm2Status & { user: string | null };
  runtimes: Runtime[];
  allowedRoots: string[];
}

export type StartType = 'file' | 'npm';

/** A managed application as the panel stores it (without env values). */
export interface AppSpec {
  name: string;
  cwd: string;
  startType: StartType;
  /** startType "file": path of the entry file relative to cwd. */
  script: string | null;
  /** startType "npm": the package.json script to run (npm run <npmScript>). */
  npmScript: string | null;
  args: string[];
  runtime: string;
  instances: number;
  execMode: 'fork' | 'cluster';
  maxMemoryMb: number | null;
}

export class SpecError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

export const APP_NAME = /^[a-z][a-z0-9-]{1,39}$/;
/** PM2 process names (root's existing apps can be named almost anything). */
export const PROCESS_NAME = /^[A-Za-z0-9@._:-][A-Za-z0-9@._: -]{0,99}$/;
export const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const NPM_SCRIPT = /^[A-Za-z0-9:_.-]{1,64}$/;
/** Env keys that would break PM2 or how OpenVPS runs the app. */
const RESERVED_ENV = /^(PM2_.*|pm_id|NODE_APP_INSTANCE|HOME|USER|LOGNAME|SHELL)$/;

export const LIMITS = { args: 20, argLength: 200, envKeys: 100, envValueLength: 8192, maxInstances: 16 };

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** Validate shape and simple rules. Filesystem checks happen in the agent. */
export function parseAppSpec(input: unknown): AppSpec {
  if (!isObj(input)) throw new SpecError('spec', 'Expected an object.');
  const s = input;
  const str = (k: string, max = 512): string => {
    const v = s[k];
    if (typeof v !== 'string' || v.length === 0) throw new SpecError(k, `"${k}" is required.`);
    if (v.length > max || v.includes('\0')) throw new SpecError(k, `"${k}" is invalid.`);
    return v;
  };

  const name = str('name', 40);
  if (!APP_NAME.test(name)) {
    throw new SpecError('name', 'Name must be 2–40 characters: lowercase letters, digits and dashes, starting with a letter.');
  }
  const cwd = str('cwd');
  if (!cwd.startsWith('/')) throw new SpecError('cwd', 'Directory must be an absolute path.');

  const startType = s.startType;
  if (startType !== 'file' && startType !== 'npm') throw new SpecError('startType', 'Start type must be "file" or "npm".');

  let script: string | null = null;
  let npmScript: string | null = null;
  if (startType === 'file') {
    script = str('script', 256);
    if (script.startsWith('/') || script.split('/').includes('..')) {
      throw new SpecError('script', 'Entry file must be a path inside the app directory, e.g. dist/server.js.');
    }
  } else {
    npmScript = str('npmScript', 64);
    if (!NPM_SCRIPT.test(npmScript)) throw new SpecError('npmScript', 'Invalid npm script name.');
  }

  const rawArgs = s.args ?? [];
  if (!Array.isArray(rawArgs) || rawArgs.length > LIMITS.args) {
    throw new SpecError('args', `Arguments must be a list of at most ${LIMITS.args} items.`);
  }
  const args = rawArgs.map((a) => {
    if (typeof a !== 'string' || a.length > LIMITS.argLength || a.includes('\0')) {
      throw new SpecError('args', `Each argument must be text of at most ${LIMITS.argLength} characters.`);
    }
    return a;
  });

  const runtime = str('runtime');
  if (!runtime.startsWith('/')) throw new SpecError('runtime', 'Runtime must be an absolute path to a Node.js binary.');

  const instances = s.instances ?? 1;
  if (typeof instances !== 'number' || !Number.isInteger(instances) || instances < 1 || instances > LIMITS.maxInstances) {
    throw new SpecError('instances', `Instances must be between 1 and ${LIMITS.maxInstances}.`);
  }
  const execMode = s.execMode ?? 'fork';
  if (execMode !== 'fork' && execMode !== 'cluster') throw new SpecError('execMode', 'Mode must be "fork" or "cluster".');
  if (execMode === 'cluster' && startType !== 'file') {
    throw new SpecError('execMode', 'Cluster mode needs a Node.js entry file (start type "file").');
  }
  if (execMode === 'fork' && instances > 1) {
    throw new SpecError('instances', 'Running several instances needs cluster mode.');
  }

  const mm = s.maxMemoryMb ?? null;
  if (mm !== null && (typeof mm !== 'number' || !Number.isInteger(mm) || mm < 32 || mm > 65536)) {
    throw new SpecError('maxMemoryMb', 'Memory limit must be between 32 and 65536 MB.');
  }

  return { name, cwd, startType, script, npmScript, args, runtime, instances, execMode, maxMemoryMb: mm as number | null };
}

export function parseEnv(input: unknown): Record<string, string> {
  if (input === undefined || input === null) return {};
  if (!isObj(input)) throw new SpecError('env', 'Environment must be an object of name/value pairs.');
  const keys = Object.keys(input);
  if (keys.length > LIMITS.envKeys) throw new SpecError('env', `At most ${LIMITS.envKeys} environment variables.`);
  const out: Record<string, string> = {};
  for (const k of keys) {
    if (!ENV_KEY.test(k)) throw new SpecError('env', `Invalid variable name "${k.slice(0, 64)}". Use letters, digits and underscores.`);
    if (RESERVED_ENV.test(k)) throw new SpecError('env', `"${k}" is managed by OpenVPS and cannot be set.`);
    const v = input[k];
    if (typeof v !== 'string' || v.length > LIMITS.envValueLength || v.includes('\0')) {
      throw new SpecError('env', `Value of "${k}" must be text of at most ${LIMITS.envValueLength} characters.`);
    }
    out[k] = v;
  }
  return out;
}

/** Request validation done by the agent on every message. */
export function parseRequest(input: unknown): AgentRequest {
  if (!isObj(input)) throw new SpecError('request', 'Malformed request.');
  const action = input.action;
  if (typeof action !== 'string' || !(AGENT_ACTIONS as readonly string[]).includes(action)) {
    throw new SpecError('action', 'Unknown action.');
  }
  const p = isObj(input.params) ? input.params : {};
  const owner = (): Owner => {
    if (p.owner !== 'root' && p.owner !== 'apps') throw new SpecError('owner', 'owner must be "root" or "apps".');
    return p.owner;
  };
  const pname = (): string => {
    if (typeof p.name !== 'string' || !PROCESS_NAME.test(p.name)) throw new SpecError('name', 'Invalid process name.');
    return p.name;
  };
  switch (action as AgentAction) {
    case 'agent.info':
      return { action: 'agent.info' };
    case 'pm2.list':
      return { action: 'pm2.list', params: { owner: owner() } };
    case 'pm2.control': {
      const op = p.op;
      if (typeof op !== 'string' || !(CONTROL_OPS as readonly string[]).includes(op)) throw new SpecError('op', 'Invalid operation.');
      return { action: 'pm2.control', params: { owner: owner(), name: pname(), op: op as ControlOp } };
    }
    case 'pm2.logs': {
      const stream = p.stream === 'err' ? 'err' : p.stream === 'out' ? 'out' : null;
      if (!stream) throw new SpecError('stream', 'stream must be "out" or "err".');
      const lines = typeof p.lines === 'number' && Number.isInteger(p.lines) ? Math.min(Math.max(p.lines, 1), 2000) : 200;
      return { action: 'pm2.logs', params: { owner: owner(), name: pname(), stream, lines } };
    }
    case 'app.apply':
      return {
        action: 'app.apply',
        params: { spec: parseAppSpec(p.spec), env: parseEnv(p.env), start: p.start !== false },
      };
    case 'app.remove': {
      const name = p.name;
      if (typeof name !== 'string' || !APP_NAME.test(name)) throw new SpecError('name', 'Invalid app name.');
      return { action: 'app.remove', params: { name } };
    }
  }
}
