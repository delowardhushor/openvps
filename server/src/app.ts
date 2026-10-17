import type { IncomingMessage, ServerResponse } from 'node:http';
import { HttpError, Router, parseCookies, readJsonBody, sendJson, type Ctx } from './http/core.ts';
import { createStaticHandler, securityHeaders } from './http/static.ts';
import { registerAuthRoutes, sessionCookieName } from './routes/auth.ts';
import { registerSystemRoutes } from './routes/system.ts';
import type { AppContext } from './context.ts';

/** Header the SPA sends on every state-changing request. See checkCsrf. */
export const CSRF_HEADER = 'x-openvps-request';

function clientIp(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first.slice(0, 64);
  }
  return (req.socket.remoteAddress ?? 'unknown').replace(/^::ffff:/, '');
}

function isSecure(req: IncomingMessage, app: AppContext): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return app.config.trustProxy && String(req.headers['x-forwarded-proto'] ?? '').split(',')[0]?.trim() === 'https';
}

/**
 * Cross-site request forgery defence for state-changing requests, layered on
 * top of SameSite=Strict cookies:
 *  1. A custom header is required. Browsers will not send it cross-origin
 *     without a CORS preflight, and OpenVPS never answers preflights.
 *  2. If the browser reports Sec-Fetch-Site, it must be same-origin.
 *  3. If an Origin header is present, its host must match the Host header.
 */
function checkCsrf(ctx: Ctx & { trustProxy: boolean }): void {
  const h = ctx.req.headers;
  if (h[CSRF_HEADER] !== '1') throw new HttpError(403, 'csrf', 'Missing request verification header.');
  const site = h['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'csrf', 'Cross-site request blocked.');
  const origin = h.origin;
  if (origin && origin !== 'null') {
    let host: string;
    try {
      host = new URL(origin).host;
    } catch {
      throw new HttpError(403, 'csrf', 'Invalid Origin header.');
    }
    const allowed = [h.host];
    if (ctx.trustProxy && typeof h['x-forwarded-host'] === 'string') allowed.push(h['x-forwarded-host'].split(',')[0]!.trim());
    if (!allowed.includes(host)) throw new HttpError(403, 'csrf', 'Cross-origin request blocked.');
  } else if (origin === 'null') {
    throw new HttpError(403, 'csrf', 'Cross-origin request blocked.');
  }
}

export function createApp(app: AppContext) {
  const router = new Router();
  registerAuthRoutes(router, app);
  registerSystemRoutes(router, app);
  const serveStatic = createStaticHandler(app.config.webRoot);

  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const started = performance.now();
    const secure = isSecure(req, app);
    securityHeaders(res, secure);
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://localhost');
    } catch {
      sendJson(res, 400, { error: { code: 'bad_request', message: 'Invalid URL.' } });
      return;
    }
    const pathname = url.pathname;

    if (!pathname.startsWith('/api/') && pathname !== '/api') {
      serveStatic(req, res, pathname);
      return;
    }

    const method = (req.method ?? 'GET').toUpperCase();
    const ctx: Ctx = {
      req,
      res,
      method,
      url,
      params: {},
      ip: clientIp(req, app.config.trustProxy),
      secure,
      cookies: parseCookies(req.headers.cookie),
      body: undefined,
    };

    try {
      if (method === 'OPTIONS') throw new HttpError(405, 'method_not_allowed', 'CORS is not supported.');
      const m = router.match(method, pathname);
      if ('status' in m) {
        if (m.status === 405) {
          throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
        }
        throw new HttpError(404, 'not_found', 'Not found.');
      }
      ctx.params = m.params;

      const mutating = !['GET', 'HEAD'].includes(method);
      if (mutating) checkCsrf({ ...ctx, trustProxy: app.config.trustProxy });

      // Resolve the session on every API request so even public routes (logout) see it.
      const token = ctx.cookies[sessionCookieName(secure)];
      if (token) {
        const session = app.sessions.validate(token);
        if (session) {
          const user = app.users.byId(session.user_id);
          if (user) {
            ctx.session = session;
            ctx.user = user;
            ctx.sessionToken = token;
          }
        }
      }
      if (m.route.opts.auth && !ctx.user) throw new HttpError(401, 'unauthenticated', 'Sign in required.');

      if (m.route.opts.body) ctx.body = await readJsonBody(req);

      const result = await m.route.handler(ctx);
      if (!res.headersSent) sendJson(res, 200, result ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) {
        const headers: Record<string, string> = {};
        const retry = e.extra?.retryAfterSeconds;
        if (typeof retry === 'number') headers['Retry-After'] = String(Math.max(1, retry));
        if (!res.headersSent) sendJson(res, e.status, { error: { code: e.code, message: e.message, ...e.extra } }, headers);
      } else {
        app.log.error('unhandled request error', { method, path: pathname, error: e as Error, stack: (e as Error).stack });
        if (!res.headersSent) sendJson(res, 500, { error: { code: 'internal', message: 'Internal server error.' } });
      }
    } finally {
      app.log.debug('request', {
        method,
        path: pathname,
        status: res.statusCode,
        ms: Math.round(performance.now() - started),
        ip: ctx.ip,
      });
    }
  };
}
