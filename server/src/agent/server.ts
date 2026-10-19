import { createServer, type Server, type Socket } from 'node:net';
import { chmodSync, chownSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import type { Logger } from '../logger.ts';
import { AgentError, type Pm2Target } from './pm2.ts';
import type { AppsManager } from './apps.ts';
import type { RuntimeDetector } from './runtimes.ts';
import type { SitesManager } from './sites.ts';
import type { BackupManager } from './backup.ts';
import type { FilesManager } from './files.ts';
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
  sites: SitesManager;
  backups: BackupManager;
  files: FilesManager;
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

  const dispatch = async function (req: AgentRequest): Promise<unknown> {
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
      case 'nginx.status':
        return d.sites.status();
      case 'cert.list':
        return d.sites.certificates();
      case 'site.config':
        return { content: await d.sites.render(req.params.spec), current: d.sites.readSiteConfig(req.params.spec.name) };
      case 'site.apply': {
        const { spec } = req.params;
        d.log.info('site apply', { name: spec.name, type: spec.type, domains: spec.domains });
        return lock.run(() => d.sites.apply(spec));
      }
      case 'site.remove': {
        d.log.info('site remove', { name: req.params.name, deleteCertificate: req.params.deleteCertificate });
        return lock.run(() => d.sites.remove(req.params.name, req.params.deleteCertificate));
      }
      case 'site.states':
        return req.params.specs.map((s) => d.sites.siteState(s.name, s));
      case 'site.check':
        return d.sites.check(req.params.name, req.params.domains);
      case 'cert.issue': {
        const { spec, email } = req.params;
        d.log.info('certificate issue', { name: spec.name, domains: spec.domains });
        return lock.run(async () => {
          const certificate = await d.sites.issue(spec, email);
          // Re-render the site so it starts serving HTTPS with the new certificate.
          const applied = await d.sites.apply(spec);
          return { certificate, ...applied };
        });
      }
      // Backups run as background jobs of their own and never hold the PM2/Nginx lock.
      case 'backup.status':
        return d.backups.status();
      case 'backup.run':
        d.log.info('backup run', { plan: req.params.job.plan, sources: req.params.job.sources.map((s) => s.name), local: req.params.job.local, s3: !!req.params.job.s3 });
        return d.backups.startBackup(req.params.job);
      case 'backup.job':
        return d.backups.job(req.params.id);
      case 'backup.list':
        return d.backups.list(req.params.plan, req.params.s3);
      case 'backup.inspect':
        return d.backups.inspect(req.params.ref, req.params.s3);
      case 'backup.restore':
        d.log.info('backup restore', { plan: req.params.restore.ref.plan, artifact: req.params.restore.ref.name, items: req.params.restore.items.length });
        return d.backups.startRestore(req.params.restore);
      case 'backup.verify':
        return d.backups.startVerify(req.params.ref, req.params.s3, req.params.deep);
      case 'backup.delete':
        d.log.info('backup delete', { plan: req.params.ref.plan, artifact: req.params.ref.name, where: req.params.ref.where });
        return d.backups.delete(req.params.ref, req.params.s3);
      case 'backup.s3test':
        return d.backups.testS3(req.params.s3);
      case 'files.list':
      case 'files.mkdir':
      case 'files.move':
      case 'files.delete':
        return d.files.run(req);
      case 'files.upload':
      case 'files.download':
        throw new AgentError('invalid', 'File contents are sent over a stream connection.');
    }
  };

  /** Actions that carry file bytes: the request line is followed (upload) or answered (download) by raw data. */
  const stream = async (req: Extract<AgentRequest, { action: 'files.upload' | 'files.download' }>, sock: Socket, rest: Buffer): Promise<void> => {
    if (req.action === 'files.download') {
      d.log.info('file download', { root: req.params.root, path: req.params.path });
      return d.files.download(req, sock);
    }
    const { size } = req.params;
    d.log.info('file upload', { root: req.params.root, path: req.params.path, size });
    // Exactly `size` bytes follow the request line; the client keeps the connection open to read the answer.
    async function* body(): AsyncGenerator<Buffer> {
      let left = size;
      if (rest.length > 0 && left > 0) {
        const part = rest.subarray(0, left);
        left -= part.length;
        yield part;
      }
      if (left > 0) {
        for await (const chunk of sock.iterator({ destroyOnReturn: false })) {
          const c = chunk as Buffer;
          const part = c.length > left ? c.subarray(0, left) : c;
          left -= part.length;
          yield part;
          if (left <= 0) break;
        }
      }
      if (left > 0) throw new Error('upload interrupted');
    }
    try {
      const result = await d.files.upload(req, Readable.from(body()));
      respond(sock, { ok: true, result });
    } catch (e) {
      if (e instanceof AgentError) respond(sock, { ok: false, error: { code: e.code, message: e.message, ...(e.field ? { field: e.field } : {}) } });
      else {
        d.log.error('file upload failed', { error: e as Error });
        respond(sock, { ok: false, error: { code: 'internal', message: 'The agent hit an internal error. See: journalctl -u openvps-agent' } });
      }
    } finally {
      // The sender may still be pushing data we no longer want: read and drop it so the end of the
      // connection is noticed (a paused socket with unread data never closes), and give up soon.
      sock.setTimeout(10_000, () => sock.destroy());
      sock.resume();
    }
  };
  return Object.assign(dispatch, { stream });
}

function respond(sock: Socket, res: AgentResponse): void {
  sock.end(JSON.stringify(res) + '\n');
}

export function handleConnection(sock: Socket, dispatch: ReturnType<typeof createDispatcher>, log: Logger): void {
  let head: Buffer = Buffer.alloc(0);
  let done = false;
  sock.setTimeout(10_000, () => {
    if (!done) {
      done = true;
      respond(sock, { ok: false, error: { code: 'timeout', message: 'Request not received in time.' } });
    }
  });
  sock.on('error', () => undefined);
  const onData = (chunk: Buffer) => {
    if (done) return;
    head = head.length ? Buffer.concat([head, chunk]) : chunk;
    const nl = head.indexOf(10);
    if (nl < 0) {
      if (head.length > MAX_REQUEST_BYTES) {
        done = true;
        respond(sock, { ok: false, error: { code: 'too_large', message: 'Request too large.' } });
      }
      return;
    }
    if (nl > MAX_REQUEST_BYTES) {
      done = true;
      respond(sock, { ok: false, error: { code: 'too_large', message: 'Request too large.' } });
      return;
    }
    done = true;
    sock.setTimeout(0);
    const rest = head.subarray(nl + 1);
    let req: AgentRequest;
    try {
      req = parseRequest(JSON.parse(head.subarray(0, nl).toString('utf8')));
    } catch (e) {
      const field = e instanceof SpecError ? e.field : undefined;
      const message = e instanceof SpecError ? e.message : 'Malformed request.';
      respond(sock, { ok: false, error: { code: 'invalid', message, ...(field ? { field } : {}) } });
      return;
    }
    if (req.action === 'files.upload' || req.action === 'files.download') {
      // From here on the connection carries file bytes: hand it over untouched.
      sock.removeListener('data', onData);
      sock.pause();
      sock.setTimeout(120_000, () => sock.destroy());
      dispatch.stream(req, sock, rest).catch((e: unknown) => {
        log.error('file stream failed', { action: req.action, error: e as Error });
        sock.destroy();
      });
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
  };
  sock.on('data', onData);
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
