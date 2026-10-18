import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Logger } from '../logger.ts';
import { AgentError, type Pm2Target } from './pm2.ts';
import type { AppsManager } from './apps.ts';
import type { RuntimeDetector } from './runtimes.ts';
import { parseRequest, SpecError, type AgentInfo, type AgentRequest, type AgentResponse, type Owner } from './spec.ts';

export const MAX_REQUEST_BYTES = 256 * 1024;

export interface AgentDeps {
  version: string;
  log: Logger;
  root: Pm2Target | null;
  manageRoot: boolean;
  apps: Pm2Target;
  appsUser: string | null;
  manager: AppsManager;
  runtimes: RuntimeDetector;
}

/** Serialises state-changing PM2 operations so two requests never interleave. */
class Mutex {
  private tail: Promise<unknown> = Promise.resolve();
  run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export function createDispatcher(d: AgentDeps) {
  const lock = new Mutex();

  const target = (owner: Owner): Pm2Target => {
    if (owner === 'apps') return d.apps;
    if (!d.root) throw new AgentError('pm2_unavailable', 'PM2 for root was not found on this server.');
    return d.root;
  };

  return async function dispatch(req: AgentRequest): Promise<unknown> {
    switch (req.action) {
      case 'agent.info': {
        const rootStatus = d.root
          ? await d.root.status()
          : { available: false, reason: 'PM2 for root was not found on this server.', version: null };
        const info: AgentInfo = {
          version: d.version,
          root: { ...rootStatus, manage: d.manageRoot },
          apps: { ...(await d.apps.status()), user: d.appsUser },
          runtimes: await d.runtimes.list(),
          allowedRoots: d.manager.allowedRoots(),
        };
        return info;
      }
      case 'pm2.list': {
        const t = target(req.params.owner);
        const s = await t.status();
        if (!s.available) return { status: s, processes: [] };
        return { status: s, processes: await t.list() };
      }
      case 'pm2.control': {
        const { owner, name, op } = req.params;
        if (owner === 'root' && !d.manageRoot) {
          throw new AgentError('forbidden', 'Managing root PM2 processes is disabled in the configuration.');
        }
        d.log.info('pm2 control', { owner, name, op });
        return lock.run(() => target(owner).control(name, op));
      }
      case 'pm2.logs': {
        const { owner, name, stream, lines } = req.params;
        return target(owner).logs(name, stream, lines);
      }
      case 'app.apply': {
        const { spec, env, start } = req.params;
        d.log.info('app apply', { name: spec.name, start, envKeys: Object.keys(env).length });
        return lock.run(() => d.manager.apply(spec, env, start));
      }
      case 'app.remove': {
        d.log.info('app remove', { name: req.params.name });
        await lock.run(() => d.manager.remove(req.params.name));
        return { removed: true };
      }
    }
  };
}

function respond(sock: Socket, res: AgentResponse): void {
  sock.end(JSON.stringify(res) + '\n');
}

export function handleConnection(sock: Socket, dispatch: ReturnType<typeof createDispatcher>, log: Logger): void {
  let buf = '';
  let done = false;
  sock.setTimeout(10_000, () => {
    if (!done) {
      done = true;
      respond(sock, { ok: false, error: { code: 'timeout', message: 'Request not received in time.' } });
    }
  });
  sock.setEncoding('utf8');
  sock.on('error', () => undefined);
  sock.on('data', (chunk: string) => {
    if (done) return;
    buf += chunk;
    if (buf.length > MAX_REQUEST_BYTES) {
      done = true;
      respond(sock, { ok: false, error: { code: 'too_large', message: 'Request too large.' } });
      return;
    }
    const nl = buf.indexOf('\n');
    if (nl < 0) return;
    done = true;
    sock.setTimeout(0);
    let req: AgentRequest;
    try {
      req = parseRequest(JSON.parse(buf.slice(0, nl)));
    } catch (e) {
      const field = e instanceof SpecError ? e.field : undefined;
      const message = e instanceof SpecError ? e.message : 'Malformed request.';
      respond(sock, { ok: false, error: { code: 'invalid', message, ...(field ? { field } : {}) } });
      return;
    }
    dispatch(req)
      .then((result) => respond(sock, { ok: true, result }))
      .catch((e: unknown) => {
        if (e instanceof AgentError) {
          respond(sock, { ok: false, error: { code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) } });
        } else if (e instanceof SpecError) {
          respond(sock, { ok: false, error: { code: 'invalid', message: e.message, field: e.field } });
        } else {
          log.error('agent action failed', { action: req.action, error: e as Error });
          respond(sock, { ok: false, error: { code: 'internal', message: 'The agent hit an internal error. See: journalctl -u openvps-agent' } });
        }
      });
  });
}

/**
 * Listen on a Unix socket. Only root and members of `group` (the panel's service
 * user) can connect; the socket's directory is not world-traversable.
 */
export function listenAgent(path: string, group: number | null, dispatch: ReturnType<typeof createDispatcher>, log: Logger): Promise<Server> {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o750 });
  if (group !== null) {
    chownSync(dir, 0, group);
    chmodSync(dir, 0o750);
  }
  rmSync(path, { force: true });
  const server = createServer((sock) => handleConnection(sock, dispatch, log));
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(path, () => {
      chmodSync(path, 0o660);
      if (group !== null) chownSync(path, 0, group);
      resolve(server);
    });
  });
}
