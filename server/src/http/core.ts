import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SessionRow } from '../auth/sessions.ts';
import type { User } from '../auth/users.ts';

export class HttpError extends Error {
  readonly status: number;
  readonly code: string;
  readonly extra: Record<string, unknown> | undefined;
  constructor(status: number, code: string, message: string, extra?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  method: string;
  url: URL;
  params: Record<string, string>;
  ip: string;
  /** True when the client reached us over HTTPS (directly or via a trusted proxy). */
  secure: boolean;
  cookies: Record<string, string>;
  sessionToken?: string;
  session?: SessionRow;
  user?: User;
  /** Parsed JSON body (only for routes that accept one). */
  body: unknown;
}

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;

export interface RouteOptions {
  /** Require a valid session. Default true. */
  auth?: boolean;
  /** Parse a JSON request body. Default true for POST/PUT/PATCH/DELETE. */
  body?: boolean;
  /** Largest JSON body in bytes (default MAX_BODY_BYTES). */
  bodyLimit?: number;
}

interface Route {
  method: string;
  parts: string[];
  handler: Handler;
  opts: Required<Omit<RouteOptions, 'bodyLimit'>> & { bodyLimit: number };
}

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler, opts: RouteOptions = {}): void {
    const m = method.toUpperCase();
    this.routes.push({
      method: m,
      parts: pattern.split('/').filter(Boolean),
      handler,
      opts: { auth: opts.auth ?? true, body: opts.body ?? !['GET', 'HEAD'].includes(m), bodyLimit: opts.bodyLimit ?? MAX_BODY_BYTES },
    });
  }

  get(p: string, h: Handler, o?: RouteOptions) { this.add('GET', p, h, o); }
  post(p: string, h: Handler, o?: RouteOptions) { this.add('POST', p, h, o); }
  put(p: string, h: Handler, o?: RouteOptions) { this.add('PUT', p, h, o); }
  delete(p: string, h: Handler, o?: RouteOptions) { this.add('DELETE', p, h, o); }

  /** Returns the matching route, or a 404/405 indication. */
  match(method: string, pathname: string):
    | { route: Route; params: Record<string, string> }
    | { status: 404 | 405; allow?: string[] } {
    const segs = pathname.split('/').filter(Boolean);
    const allow: string[] = [];
    for (const r of this.routes) {
      if (r.parts.length !== segs.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < segs.length; i++) {
        const p = r.parts[i]!;
        const s = segs[i]!;
        if (p.startsWith(':')) {
          try {
            params[p.slice(1)] = decodeURIComponent(s);
          } catch {
            ok = false;
            break;
          }
        } else if (p !== s) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
      if (r.method === method || (method === 'HEAD' && r.method === 'GET')) return { route: r, params };
      allow.push(r.method);
    }
    return allow.length ? { status: 405, allow } : { status: 404 };
  }
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (!k || k in out) continue;
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export interface CookieOpts {
  maxAgeSeconds?: number;
  secure: boolean;
}

export function serializeCookie(name: string, value: string, o: CookieOpts): string {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
  if (o.secure) parts.push('Secure');
  if (o.maxAgeSeconds !== undefined) parts.push(`Max-Age=${Math.floor(o.maxAgeSeconds)}`);
  return parts.join('; ');
}

export const MAX_BODY_BYTES = 32 * 1024;

export async function readJsonBody(req: IncomingMessage, limit = MAX_BODY_BYTES): Promise<unknown> {
  const len = Number(req.headers['content-length'] ?? 0);
  if (len > limit) throw new HttpError(413, 'payload_too_large', 'Request body is too large.');
  const chunks: Buffer[] = [];
  let size = 0;
  // The server has no overall request timeout (uploads can take long), so a slow JSON body is cut here.
  const timer = setTimeout(() => req.destroy(), 30_000);
  try {
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > limit) throw new HttpError(413, 'payload_too_large', 'Request body is too large.');
      chunks.push(chunk as Buffer);
    }
  } finally {
    clearTimeout(timer);
  }
  if (size === 0) return {};
  const ct = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
  if (ct !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Use Content-Type: application/json.');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON.');
  }
}

export function sendJson(res: ServerResponse, status: number, data: unknown, headers: Record<string, string> = {}): void {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(res.req?.method === 'HEAD' ? undefined : body);
}

/** Small typed-field helpers for validating request bodies. */
export function obj(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'invalid_body', 'Expected a JSON object.');
  }
  return body as Record<string, unknown>;
}

export function reqString(o: Record<string, unknown>, key: string, max = 512): string {
  const v = o[key];
  if (typeof v !== 'string' || v.length === 0) throw new HttpError(400, 'invalid_field', `"${key}" is required.`, { field: key });
  if (v.length > max) throw new HttpError(400, 'invalid_field', `"${key}" is too long.`, { field: key });
  return v;
}
