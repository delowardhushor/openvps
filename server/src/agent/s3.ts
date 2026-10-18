import { createHash, createHmac } from 'node:crypto';
import { createReadStream, createWriteStream, statSync } from 'node:fs';
import { request as httpRequest, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { pipeline } from 'node:stream/promises';
import type { Readable } from 'node:stream';
import type { S3Access } from './backup-spec.ts';

/**
 * Minimal S3 client (AWS Signature V4) over node:http(s), so OpenVPS needs no SDK.
 * Works with AWS S3 and S3-compatible services (Cloudflare R2, Backblaze B2, MinIO, Wasabi,
 * DigitalOcean Spaces, ...). Only the handful of calls backups need.
 */

export class S3Error extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const hmac = (key: Buffer | string, data: string): Buffer => createHmac('sha256', key).update(data).digest();
const sha256hex = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');

/** RFC 3986 encoding as S3 wants it; "/" is kept in object keys. */
export function uriEncode(s: string, keepSlash: boolean): string {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return keepSlash ? e.replace(/%2F/g, '/') : e;
}

export interface SignInput {
  method: string;
  host: string;
  /** Path as sent on the wire (already encoded). */
  path: string;
  query: Array<[string, string]>;
  /** Extra headers to sign (lower-case names). */
  headers: Record<string, string>;
  payloadHash: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
  date: Date;
}

export function signRequest(i: SignInput): { authorization: string; amzDate: string; signedHeaders: string } {
  const amzDate = i.date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = { ...i.headers, host: i.host, 'x-amz-content-sha256': i.payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]!.trim().replace(/\s+/g, ' ')}\n`).join('');
  const signedHeaders = names.join(';');
  const canonicalQuery = i.query
    .map(([k, v]) => [uriEncode(k, false), uriEncode(v, false)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('&');
  const canonicalRequest = [i.method, i.path, canonicalQuery, canonicalHeaders, signedHeaders, i.payloadHash].join('\n');
  const scope = `${dateStamp}/${i.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256hex(canonicalRequest)].join('\n');
  const key = hmac(hmac(hmac(hmac('AWS4' + i.secretAccessKey, dateStamp), i.region), 's3'), 'aws4_request');
  const signature = createHmac('sha256', key).update(stringToSign).digest('hex');
  return {
    authorization: `AWS4-HMAC-SHA256 Credential=${i.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    amzDate,
    signedHeaders,
  };
}

const EMPTY_SHA = sha256hex('');
const MIB = 1024 * 1024;

export interface S3Object {
  key: string;
  size: number;
  lastModified: number;
}

export interface S3Options {
  /** Objects larger than this are uploaded in parts of this size. */
  partSize?: number;
  /** Idle socket timeout. */
  timeoutMs?: number;
  retries?: number;
}

type Body = { kind: 'none' } | { kind: 'buffer'; data: Buffer } | { kind: 'file'; path: string; start: number; end: number };

function xmlText(xml: string, tag: string): string | null {
  const m = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? unescapeXml(m[1]!) : null;
}

function unescapeXml(s: string): string {
  return s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
}

async function readText(res: IncomingMessage, max = 4 * MIB): Promise<string> {
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of res) {
    n += (c as Buffer).length;
    if (n > max) {
      res.destroy();
      throw new S3Error(res.statusCode ?? 0, 'TooLarge', 'The storage service sent an unexpectedly large response.');
    }
    chunks.push(c as Buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function hashFileRange(path: string, start: number, end: number): Promise<string> {
  const h = createHash('sha256');
  if (end > start) for await (const c of createReadStream(path, { start, end: end - 1 })) h.update(c as Buffer);
  return h.digest('hex');
}

export class S3Client {
  private readonly cfg: S3Access;
  private readonly opts: Required<S3Options>;
  constructor(cfg: S3Access, opts: S3Options = {}) {
    this.cfg = cfg;
    this.opts = { partSize: opts.partSize ?? 64 * MIB, timeoutMs: opts.timeoutMs ?? 60_000, retries: opts.retries ?? 3 };
  }

  private location(key: string | null): { host: string; path: string; base: URL } {
    const base = new URL(this.cfg.target.endpoint);
    const { bucket, pathStyle } = this.cfg.target;
    const k = key === null ? '' : uriEncode(key, true);
    if (pathStyle) return { host: base.host, path: `/${bucket}${key === null ? '' : '/' + k}`, base };
    return { host: `${bucket}.${base.host}`, path: `/${k}`, base };
  }

  private async attempt(method: string, key: string | null, query: Array<[string, string]>, headers: Record<string, string>, body: Body, payloadHash: string): Promise<IncomingMessage> {
    const { host, path, base } = this.location(key);
    const { authorization, amzDate } = signRequest({
      method,
      host,
      path,
      query,
      headers,
      payloadHash,
      accessKeyId: this.cfg.secrets.accessKeyId,
      secretAccessKey: this.cfg.secrets.secretAccessKey,
      region: this.cfg.target.region,
      date: new Date(),
    });
    const qs = query.length ? '?' + query.map(([k, v]) => `${uriEncode(k, false)}=${uriEncode(v, false)}`).join('&') : '';
    const length = body.kind === 'buffer' ? body.data.length : body.kind === 'file' ? body.end - body.start : 0;
    const send = base.protocol === 'https:' ? httpsRequest : httpRequest;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const { hostname, port } = new URL(`${base.protocol}//${host}`);
      const req = send(
        {
          method,
          hostname,
          port: port || undefined,
          path: path + qs,
          headers: {
            ...headers,
            host,
            'x-amz-date': amzDate,
            'x-amz-content-sha256': payloadHash,
            authorization,
            ...(body.kind === 'none' && method !== 'PUT' && method !== 'POST' ? {} : { 'content-length': String(length) }),
          },
        },
        resolve,
      );
      req.setTimeout(this.opts.timeoutMs, () => req.destroy(new Error('The storage service did not answer in time.')));
      req.on('error', reject);
      if (body.kind === 'buffer') req.end(body.data);
      else if (body.kind === 'file') {
        const rs: Readable = createReadStream(body.path, { start: body.start, end: body.end - 1 });
        rs.on('error', (e) => req.destroy(e));
        rs.pipe(req);
      } else req.end();
    });
  }

  /** Perform a request, retrying transient failures. The callback consumes the response. */
  private async call<T>(
    method: string,
    key: string | null,
    query: Array<[string, string]>,
    headers: Record<string, string>,
    body: Body,
    payloadHash: string,
    handle: (res: IncomingMessage) => Promise<T>,
  ): Promise<T> {
    let last: unknown;
    for (let n = 0; n < this.opts.retries; n++) {
      if (n) await new Promise((r) => setTimeout(r, 400 * n));
      try {
        const res = await this.attempt(method, key, query, headers, body, payloadHash);
        const status = res.statusCode ?? 0;
        if (status >= 400) {
          const text = method === 'HEAD' ? '' : await readText(res).catch(() => '');
          const err = new S3Error(status, xmlText(text, 'Code') ?? `HTTP${status}`, xmlText(text, 'Message') ?? `The storage service answered ${status}.`);
          if (status >= 500) {
            last = err;
            continue;
          }
          throw err;
        }
        return await handle(res);
      } catch (e) {
        if (e instanceof S3Error && e.status < 500) throw e;
        last = e;
        if (!(e instanceof S3Error) && !isTransient(e)) throw e;
      }
    }
    throw last instanceof S3Error ? last : new S3Error(0, 'Network', `Cannot reach the storage service: ${(last as Error).message}`);
  }

  async head(key: string): Promise<{ size: number; sha256: string | null } | null> {
    try {
      return await this.call('HEAD', key, [], {}, { kind: 'none' }, EMPTY_SHA, async (res) => {
        res.resume();
        return { size: Number(res.headers['content-length'] ?? 0), sha256: headerValue(res.headers, 'x-amz-meta-sha256') };
      });
    } catch (e) {
      if (e instanceof S3Error && e.status === 404) return null;
      throw e;
    }
  }

  async putText(key: string, text: string, contentType = 'application/json'): Promise<void> {
    const data = Buffer.from(text, 'utf8');
    await this.call('PUT', key, [], { 'content-type': contentType }, { kind: 'buffer', data }, sha256hex(data), async (res) => {
      res.resume();
    });
  }

  async getText(key: string): Promise<string> {
    return this.call('GET', key, [], {}, { kind: 'none' }, EMPTY_SHA, (res) => readText(res, 2 * MIB));
  }

  async downloadTo(key: string, path: string): Promise<void> {
    await this.call('GET', key, [], {}, { kind: 'none' }, EMPTY_SHA, async (res) => {
      await pipeline(res, createWriteStream(path, { mode: 0o600 }));
    });
  }

  async delete(key: string): Promise<void> {
    await this.call('DELETE', key, [], {}, { kind: 'none' }, EMPTY_SHA, async (res) => {
      res.resume();
    });
  }

  async list(prefix: string): Promise<S3Object[]> {
    const out: S3Object[] = [];
    let token: string | null = null;
    do {
      const query: Array<[string, string]> = [['list-type', '2'], ['prefix', prefix]];
      if (token) query.push(['continuation-token', token]);
      const xml = await this.call('GET', null, query, {}, { kind: 'none' }, EMPTY_SHA, (res) => readText(res));
      for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
        const key = xmlText(m[1]!, 'Key');
        if (key === null) continue;
        out.push({ key, size: Number(xmlText(m[1]!, 'Size') ?? 0), lastModified: Date.parse(xmlText(m[1]!, 'LastModified') ?? '') || 0 });
      }
      token = xmlText(xml, 'IsTruncated') === 'true' ? xmlText(xml, 'NextContinuationToken') : null;
    } while (token);
    return out;
  }

  /** Upload a file; large files go up in parts. `sha256` is stored as object metadata. */
  async putFile(key: string, path: string, sha256: string): Promise<void> {
    const size = statSync(path).size;
    const meta = { 'x-amz-meta-sha256': sha256, 'content-type': 'application/x-tar' };
    if (size <= this.opts.partSize) {
      await this.call('PUT', key, [], meta, { kind: 'file', path, start: 0, end: size }, sha256, async (res) => {
        res.resume();
      });
      return;
    }
    const uploadId = await this.call('POST', key, [['uploads', '']], meta, { kind: 'none' }, EMPTY_SHA, async (res) => {
      const id = xmlText(await readText(res), 'UploadId');
      if (!id) throw new S3Error(0, 'BadResponse', 'The storage service did not start the multipart upload.');
      return id;
    });
    try {
      const partSize = Math.max(this.opts.partSize, Math.ceil(size / 9000));
      const parts: Array<{ n: number; etag: string }> = [];
      for (let start = 0, n = 1; start < size; start += partSize, n++) {
        const end = Math.min(start + partSize, size);
        const hash = await hashFileRange(path, start, end);
        const etag = await this.call('PUT', key, [['partNumber', String(n)], ['uploadId', uploadId]], {}, { kind: 'file', path, start, end }, hash, async (res) => {
          res.resume();
          const e = headerValue(res.headers, 'etag');
          if (!e) throw new S3Error(0, 'BadResponse', 'The storage service did not confirm a part.');
          return e;
        });
        parts.push({ n, etag });
      }
      const xml =
        '<CompleteMultipartUpload>' + parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('') + '</CompleteMultipartUpload>';
      const data = Buffer.from(xml, 'utf8');
      await this.call('POST', key, [['uploadId', uploadId]], { 'content-type': 'application/xml' }, { kind: 'buffer', data }, sha256hex(data), async (res) => {
        // S3 can answer 200 and still report a failure in the body.
        const text = await readText(res);
        if (/<Error>/.test(text)) throw new S3Error(0, xmlText(text, 'Code') ?? 'Failed', xmlText(text, 'Message') ?? 'The upload could not be completed.');
      });
    } catch (e) {
      await this.call('DELETE', key, [['uploadId', uploadId]], {}, { kind: 'none' }, EMPTY_SHA, async (res) => {
        res.resume();
      }).catch(() => undefined);
      throw e;
    }
  }
}

function headerValue(h: IncomingHttpHeaders, name: string): string | null {
  const v = h[name];
  return typeof v === 'string' ? v : Array.isArray(v) ? (v[0] ?? null) : null;
}

function isTransient(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException).code ?? '';
  return ['ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNABORTED'].includes(code) || /did not answer in time/.test((e as Error).message);
}
