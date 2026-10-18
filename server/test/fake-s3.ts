import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { S3Access } from '../src/agent/backup-spec.ts';

interface StoredObject {
  body: Buffer;
  sha256: string | null;
  modified: number;
}

/** An in-memory S3 server (path-style) for tests. Checks that payload hashes are honest. */
export class FakeS3 {
  readonly objects = new Map<string, StoredObject>();
  readonly uploads = new Map<string, Map<number, Buffer>>();
  readonly requests: string[] = [];
  failNext = 0;
  pageSize = 1000;
  denyAll = false;
  private server!: Server;
  endpoint = '';
  readonly bucket = 'backups';

  async start(): Promise<this> {
    this.server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => this.handle(req, res, Buffer.concat(chunks)));
    });
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    this.endpoint = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    return this;
  }

  access(prefix = 'vps1/'): S3Access {
    return {
      target: { endpoint: this.endpoint, region: 'us-east-1', bucket: this.bucket, prefix, pathStyle: true },
      secrets: { accessKeyId: 'AKIATESTKEY', secretAccessKey: 'test-secret-access-key-123' },
    };
  }

  keys(): string[] {
    return [...this.objects.keys()].sort();
  }

  async close(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((r) => this.server.close(() => r()));
  }

  private handle(req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse, body: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://x');
    const method = req.method ?? 'GET';
    this.requests.push(`${method} ${url.pathname}${url.search}`);
    const send = (status: number, text = '', headers: Record<string, string> = {}) => {
      res.writeHead(status, headers);
      res.end(method === 'HEAD' ? undefined : text);
    };
    const err = (status: number, code: string, message: string) =>
      send(status, `<?xml version="1.0"?><Error><Code>${code}</Code><Message>${message}</Message></Error>`);

    if (this.failNext > 0) {
      this.failNext--;
      return err(500, 'InternalError', 'try again');
    }
    const auth = String(req.headers.authorization ?? '');
    if (this.denyAll || !auth.startsWith('AWS4-HMAC-SHA256 Credential=AKIATESTKEY/')) return err(403, 'AccessDenied', 'Access Denied');
    const claimed = String(req.headers['x-amz-content-sha256']);
    if (claimed !== createHash('sha256').update(body).digest('hex')) return err(400, 'XAmzContentSHA256Mismatch', 'payload hash mismatch');

    const prefix = `/${this.bucket}`;
    if (!url.pathname.startsWith(prefix)) return err(404, 'NoSuchBucket', 'no such bucket');
    const key = decodeURIComponent(url.pathname.slice(prefix.length + 1));

    if (method === 'GET' && !key) {
      const want = url.searchParams.get('prefix') ?? '';
      const all = this.keys().filter((k) => k.startsWith(want));
      const start = Number(url.searchParams.get('continuation-token') ?? 0);
      const page = all.slice(start, start + this.pageSize);
      const more = start + this.pageSize < all.length;
      const items = page
        .map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><LastModified>${new Date(this.objects.get(k)!.modified).toISOString()}</LastModified><Size>${this.objects.get(k)!.body.length}</Size></Contents>`)
        .join('');
      return send(200, `<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${start + this.pageSize}</NextContinuationToken>` : ''}${items}</ListBucketResult>`);
    }
    if (method === 'POST' && url.searchParams.has('uploads')) {
      const id = `u${this.uploads.size + 1}`;
      this.uploads.set(id, new Map());
      this.objects.set(`${key}#pending-meta`, { body: Buffer.alloc(0), sha256: String(req.headers['x-amz-meta-sha256'] ?? '') || null, modified: Date.now() });
      return send(200, `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`);
    }
    if (method === 'POST' && url.searchParams.has('uploadId')) {
      const parts = this.uploads.get(url.searchParams.get('uploadId')!);
      if (!parts) return err(404, 'NoSuchUpload', 'no such upload');
      const meta = this.objects.get(`${key}#pending-meta`);
      this.objects.delete(`${key}#pending-meta`);
      this.objects.set(key, { body: Buffer.concat([...parts.keys()].sort((a, b) => a - b).map((n) => parts.get(n)!)), sha256: meta?.sha256 ?? null, modified: Date.now() });
      this.uploads.delete(url.searchParams.get('uploadId')!);
      return send(200, '<CompleteMultipartUploadResult><ETag>"done"</ETag></CompleteMultipartUploadResult>');
    }
    if (method === 'PUT' && url.searchParams.has('partNumber')) {
      const parts = this.uploads.get(url.searchParams.get('uploadId')!);
      if (!parts) return err(404, 'NoSuchUpload', 'no such upload');
      const n = Number(url.searchParams.get('partNumber'));
      parts.set(n, body);
      return send(200, '', { etag: `"part${n}"` });
    }
    if (method === 'DELETE' && url.searchParams.has('uploadId')) {
      this.uploads.delete(url.searchParams.get('uploadId')!);
      this.objects.delete(`${key}#pending-meta`);
      return send(204);
    }
    if (method === 'PUT') {
      this.objects.set(key, { body, sha256: String(req.headers['x-amz-meta-sha256'] ?? '') || null, modified: Date.now() });
      return send(200, '', { etag: '"x"' });
    }
    if (method === 'GET' || method === 'HEAD') {
      const o = this.objects.get(key);
      if (!o) return err(404, 'NoSuchKey', 'The specified key does not exist.');
      res.writeHead(200, { 'content-length': String(o.body.length), ...(o.sha256 ? { 'x-amz-meta-sha256': o.sha256 } : {}) });
      return void res.end(method === 'HEAD' ? undefined : o.body);
    }
    if (method === 'DELETE') {
      this.objects.delete(key);
      return send(204);
    }
    return err(405, 'MethodNotAllowed', 'nope');
  }
}
