import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { HttpError, obj, type Ctx, type Router } from '../http/core.ts';
import { agentError } from './apps.ts';
import { FileSpecError, parseRelPath, type DownloadHeader, type FileListing, type FileRequest, type UploadResult } from '../agent/files-spec.ts';
import type { AppContext } from '../context.ts';

/** Content-Disposition for a download: an ASCII fallback plus the real name in RFC 5987 form. */
export function attachment(name: string): string {
  const fallback = name.replace(/[^\x20-\x7e]|["\\%;]/g, '_').slice(0, 150) || 'download';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase())}`;
}

/** Largest unread upload body that is read and dropped after an early refusal. */
const DRAIN_LIMIT = 32 * 1024 * 1024;

export function registerFileRoutes(r: Router, app: AppContext): void {
  const cfg = app.config.files;
  const maxUpload = cfg.maxUploadMb * 1024 * 1024;
  const maxEdit = cfg.maxEditKb * 1024;

  const audit = (ctx: Ctx, action: string, target: string, outcome: 'success' | 'failure', details?: Record<string, unknown>) =>
    app.audit.record({ actor: ctx.user!.username, ip: ctx.ip, action, target, outcome, details });

  const root = (v: unknown): string => {
    if (typeof v !== 'string' || !cfg.roots.includes(v)) throw new HttpError(404, 'not_found', 'That folder is not managed by the file manager.', { field: 'root' });
    return v;
  };
  const rel = (v: unknown, field = 'path', allowEmpty = false): string => {
    try {
      return parseRelPath(v ?? '', field, { allowEmpty });
    } catch (e) {
      if (e instanceof FileSpecError) throw new HttpError(400, 'invalid_field', e.message, { field: e.field });
      throw e;
    }
  };
  const call = async <T>(req: FileRequest): Promise<T> => {
    try {
      return await app.agent.call<T>(req);
    } catch (e) {
      agentError(e);
    }
  };
  const label = (rootPath: string, path: string) => (path ? `${rootPath}/${path}` : rootPath);

  /** Run a change, audit it either way. */
  const changed = async <T>(ctx: Ctx, action: string, rootPath: string, path: string, details: Record<string, unknown>, fn: () => Promise<T>): Promise<T> => {
    try {
      const out = await fn();
      audit(ctx, action, label(rootPath, path), 'success', details);
      return out;
    } catch (e) {
      audit(ctx, action, label(rootPath, path), 'failure', { ...details, error: ((e as Error).message ?? '').slice(0, 200) });
      throw e;
    }
  };

  r.get('/api/files/roots', () => ({
    roots: cfg.roots.map((path) => ({ path })),
    maxUploadBytes: maxUpload,
    maxEditBytes: maxEdit,
  }));

  r.get('/api/files/list', async (ctx) => {
    const rootPath = root(ctx.url.searchParams.get('root'));
    const path = rel(ctx.url.searchParams.get('path'), 'path', true);
    const listing = await call<FileListing>({ action: 'files.list', params: { root: rootPath, path } });
    return { root: rootPath, ...listing };
  });

  r.post('/api/files/mkdir', async (ctx) => {
    const b = obj(ctx.body);
    const rootPath = root(b.root);
    const path = rel(b.path);
    await changed(ctx, 'file.mkdir', rootPath, path, {}, () => call({ action: 'files.mkdir', params: { root: rootPath, path } }));
    return { ok: true };
  });

  r.post('/api/files/move', async (ctx) => {
    const b = obj(ctx.body);
    const rootPath = root(b.root);
    const from = rel(b.from, 'from');
    const to = rel(b.to, 'to');
    await changed(ctx, 'file.move', rootPath, from, { to }, () => call({ action: 'files.move', params: { root: rootPath, from, to } }));
    return { ok: true };
  });

  r.post('/api/files/delete', async (ctx) => {
    const b = obj(ctx.body);
    const rootPath = root(b.root);
    const path = rel(b.path);
    const res = await changed(ctx, 'file.delete', rootPath, path, {}, () => call<{ type: string }>({ action: 'files.delete', params: { root: rootPath, path } }));
    return { ok: true, type: res.type };
  });

  // ---- upload: the raw file is the request body -----------------------------------------

  r.post(
    '/api/files/upload',
    async (ctx) => {
      // On a refusal Node discards the rest of the body, which lets the browser read the answer.
      // Only a very large body is cut off instead, by closing the connection.
      const declared = Number(ctx.req.headers['content-length'] ?? 0);
      const refuse = (e: HttpError): HttpError => {
        if (declared > DRAIN_LIMIT) ctx.res.setHeader('Connection', 'close');
        return e;
      };
      const q = ctx.url.searchParams;
      let rootPath: string;
      let path: string;
      try {
        rootPath = root(q.get('root'));
        path = rel(q.get('path'));
      } catch (e) {
        throw e instanceof HttpError ? refuse(e) : e;
      }
      const len = ctx.req.headers['content-length'];
      if (typeof len !== 'string' || !/^\d{1,15}$/.test(len)) throw refuse(new HttpError(411, 'length_required', 'The size of the file must be sent.'));
      const size = Number(len);
      if (size > maxUpload) {
        throw refuse(new HttpError(413, 'too_large', `Files can be at most ${cfg.maxUploadMb >= 1024 ? `${(cfg.maxUploadMb / 1024).toFixed(cfg.maxUploadMb % 1024 ? 1 : 0)} GB` : `${cfg.maxUploadMb} MB`} here.`));
      }
      const overwrite = q.get('overwrite') === '1';
      const mtime = q.get('mtime');
      const ifMtimeMs = mtime !== null && /^\d{1,16}$/.test(mtime) ? Number(mtime) : null;
      try {
        const res = await changed(ctx, 'file.upload', rootPath, path, { size, overwrite }, () =>
          app.agent
            .upload<UploadResult>({ action: 'files.upload', params: { root: rootPath, path, size, overwrite, ifMtimeMs } }, ctx.req)
            .catch((e: unknown) => agentError(e)),
        );
        return res;
      } catch (e) {
        if (declared > DRAIN_LIMIT) ctx.res.setHeader('Connection', 'close');
        throw e;
      }
    },
    { body: false },
  );

  // ---- download ----------------------------------------------------------------------------

  r.get('/api/files/download', async (ctx) => {
    const rootPath = root(ctx.url.searchParams.get('root'));
    const path = rel(ctx.url.searchParams.get('path'));
    let dl;
    try {
      dl = await app.agent.download<DownloadHeader>({ action: 'files.download', params: { root: rootPath, path, maxBytes: null } });
    } catch (e) {
      agentError(e);
    }
    const { result: h, stream } = dl;
    audit(ctx, 'file.download', label(rootPath, path), 'success', { size: h.size });
    let n = 0;
    const count = new Transform({
      transform(chunk: Buffer, _enc, cb) {
        n += chunk.length;
        cb(null, chunk);
      },
      // A short stream must not look like a finished download: fail so the connection is cut.
      flush(cb) {
        cb(n === h.size ? null : new Error('The file ended early.'));
      },
    });
    ctx.res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(h.size),
      'Content-Disposition': attachment(h.name),
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': 'sandbox',
    });
    ctx.res.on('close', () => stream.destroy());
    await pipeline(stream, count, ctx.res).catch(() => ctx.res.destroy());
  });

  // ---- small text files --------------------------------------------------------------------

  r.get('/api/files/text', async (ctx) => {
    const rootPath = root(ctx.url.searchParams.get('root'));
    const path = rel(ctx.url.searchParams.get('path'));
    let dl;
    try {
      dl = await app.agent.download<DownloadHeader>({ action: 'files.download', params: { root: rootPath, path, maxBytes: maxEdit } });
    } catch (e) {
      if (e instanceof Error && 'code' in e && (e as { code: string }).code === 'too_large') {
        throw new HttpError(413, 'too_large', `This file is larger than ${cfg.maxEditKb} KB, which is the most the editor opens. Download it instead.`);
      }
      agentError(e);
    }
    const { result: h, stream } = dl;
    const chunks: Buffer[] = [];
    let n = 0;
    try {
      for await (const c of stream) {
        n += (c as Buffer).length;
        if (n > maxEdit) throw new HttpError(413, 'too_large', `This file is larger than ${cfg.maxEditKb} KB, which is the most the editor opens.`);
        chunks.push(c as Buffer);
      }
    } finally {
      stream.destroy();
    }
    const buf = Buffer.concat(chunks);
    if (buf.length !== h.size) throw new HttpError(502, 'io', 'The file could not be read completely.');
    let content: string;
    try {
      content = new TextDecoder('utf-8', { fatal: true }).decode(buf);
    } catch {
      throw new HttpError(415, 'not_text', 'This file is not UTF-8 text, so it cannot be edited here. Download it instead.');
    }
    if (content.includes('\0')) throw new HttpError(415, 'not_text', 'This is a binary file, so it cannot be edited here. Download it instead.');
    return { name: h.name, size: h.size, mtimeMs: h.mtimeMs, content };
  });

  r.put(
    '/api/files/text',
    async (ctx) => {
      const b = obj(ctx.body);
      const rootPath = root(b.root);
      const path = rel(b.path);
      if (typeof b.content !== 'string') throw new HttpError(400, 'invalid_field', '"content" must be text.', { field: 'content' });
      const data = Buffer.from(b.content, 'utf8');
      if (data.length > maxEdit) throw new HttpError(413, 'too_large', `The editor saves files up to ${cfg.maxEditKb} KB.`);
      const m = b.mtimeMs;
      if (m !== null && m !== undefined && (typeof m !== 'number' || !Number.isFinite(m))) throw new HttpError(400, 'invalid_field', 'Invalid modification time.', { field: 'mtimeMs' });
      const create = b.create === true;
      const res = await changed(ctx, 'file.save', rootPath, path, { size: data.length }, () =>
        app.agent
          .upload<UploadResult>(
            { action: 'files.upload', params: { root: rootPath, path, size: data.length, overwrite: !create, ifMtimeMs: typeof m === 'number' ? m : null } },
            Readable.from([data]),
          )
          .catch((e: unknown) => agentError(e)),
      );
      return res;
    },
    { bodyLimit: maxEdit * 3 + 4096 },
  );
}
