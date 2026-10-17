import { checkPasswordPolicy, dummyHash, hashPassword, needsRehash, verifyPassword } from '../auth/password.ts';
import { checkSetupToken, consumeSetupToken, hasSetupToken } from '../auth/setup.ts';
import { toPublic, USERNAME } from '../auth/users.ts';
import { transaction } from '../db/index.ts';
import { HttpError, obj, reqString, serializeCookie, type Ctx, type Router } from '../http/core.ts';
import type { AppContext } from '../context.ts';

export function sessionCookieName(secure: boolean): string {
  // The __Host- prefix makes browsers refuse the cookie unless it is Secure,
  // host-only and Path=/, which blocks subdomain cookie injection.
  return secure ? '__Host-ovps_sid' : 'ovps_sid';
}

function startSession(app: AppContext, ctx: Ctx, userId: number): void {
  const { token } = app.sessions.create(userId, ctx.ip, String(ctx.req.headers['user-agent'] ?? '') || null);
  ctx.res.setHeader(
    'Set-Cookie',
    serializeCookie(sessionCookieName(ctx.secure), token, {
      secure: ctx.secure,
      maxAgeSeconds: app.config.session.absoluteHours * 3600,
    }),
  );
}

function clearCookie(ctx: Ctx): void {
  ctx.res.setHeader('Set-Cookie', serializeCookie(sessionCookieName(ctx.secure), '', { secure: ctx.secure, maxAgeSeconds: 0 }));
}

function rateLimited(retryAfterMs: number): HttpError {
  return new HttpError(429, 'rate_limited', 'Too many attempts. Try again later.', {
    retryAfterSeconds: Math.ceil(retryAfterMs / 1000),
  });
}

function validateNewPassword(app: AppContext, password: string, username: string): void {
  const policy = checkPasswordPolicy(password, username, app.config.auth.minPasswordLength);
  if (!policy.ok) {
    throw new HttpError(400, 'weak_password', policy.problems.join(' '), { field: 'password', problems: policy.problems });
  }
}

export function registerAuthRoutes(r: Router, app: AppContext): void {
  r.get(
    '/api/setup/status',
    () => ({ needsSetup: app.users.count() === 0, tokenIssued: hasSetupToken(app.db) }),
    { auth: false },
  );

  r.post(
    '/api/setup',
    async (ctx) => {
      const limit = app.setupLimiter.hit(ctx.ip);
      if (!limit.allowed) throw rateLimited(limit.retryAfterMs);
      if (app.users.count() > 0) throw new HttpError(409, 'already_setup', 'Setup has already been completed.');

      const b = obj(ctx.body);
      const token = reqString(b, 'setupToken', 100);
      const username = reqString(b, 'username', 32).trim();
      const password = reqString(b, 'password', 256);

      if (!checkSetupToken(app.db, token)) {
        app.audit.record({ ip: ctx.ip, action: 'setup.admin_create', outcome: 'failure', details: { reason: 'invalid_setup_token' } });
        throw new HttpError(403, 'invalid_setup_token', 'The setup token is not valid. Run "sudo openvps setup-token" on the server to see it.', { field: 'setupToken' });
      }
      if (!USERNAME.test(username)) {
        throw new HttpError(400, 'invalid_field', 'Username must be 3–32 characters: letters, digits, dot, dash or underscore, starting with a letter.', { field: 'username' });
      }
      validateNewPassword(app, password, username);

      const hash = await hashPassword(password);
      // Re-check inside a transaction so two concurrent setup requests cannot both succeed.
      const user = transaction(app.db, () => {
        if (app.users.count() > 0) throw new HttpError(409, 'already_setup', 'Setup has already been completed.');
        return app.users.create(username, hash);
      });
      consumeSetupToken(app.db, app.config.dataDir);
      app.audit.record({ actor: user.username, ip: ctx.ip, action: 'setup.admin_create', target: user.username, outcome: 'success' });
      app.log.info('administrator account created', { username: user.username });
      startSession(app, ctx, user.id);
      return { user: toPublic(user) };
    },
    { auth: false },
  );

  r.post(
    '/api/auth/login',
    async (ctx) => {
      const limit = app.loginLimiter.hit(ctx.ip);
      if (!limit.allowed) {
        app.audit.record({ ip: ctx.ip, action: 'auth.login', outcome: 'failure', details: { reason: 'ip_rate_limited' } });
        throw rateLimited(limit.retryAfterMs);
      }
      const b = obj(ctx.body);
      const username = reqString(b, 'username', 64).trim();
      const password = reqString(b, 'password', 256);
      const generic = new HttpError(401, 'invalid_credentials', 'Incorrect username or password.');

      const user = app.users.byUsername(username);
      if (!user) {
        await verifyPassword(password, await dummyHash()); // equalise timing
        app.audit.record({ ip: ctx.ip, action: 'auth.login', target: username.slice(0, 64), outcome: 'failure', details: { reason: 'unknown_user' } });
        throw generic;
      }
      if (app.users.isLocked(user)) {
        await verifyPassword(password, await dummyHash());
        app.audit.record({ ip: ctx.ip, action: 'auth.login', target: user.username, outcome: 'failure', details: { reason: 'locked' } });
        throw new HttpError(423, 'account_locked', 'Too many failed attempts. This account is temporarily locked.', {
          retryAfterSeconds: Math.ceil(((user.locked_until ?? 0) - Date.now()) / 1000),
        });
      }
      const ok = await verifyPassword(password, user.password_hash);
      if (!ok) {
        const { locked } = app.users.recordFailure(user.id, app.config.auth.maxFailedAttempts, app.config.auth.lockoutMinutes * 60_000);
        app.audit.record({ ip: ctx.ip, action: 'auth.login', target: user.username, outcome: 'failure', details: { reason: 'bad_password', locked } });
        if (locked) app.log.warn('account locked after repeated failed logins', { username: user.username, ip: ctx.ip });
        throw generic;
      }
      app.users.recordSuccess(user.id);
      if (needsRehash(user.password_hash)) app.users.setPassword(user.id, await hashPassword(password));
      startSession(app, ctx, user.id);
      app.audit.record({ actor: user.username, ip: ctx.ip, action: 'auth.login', target: user.username, outcome: 'success' });
      return { user: toPublic(app.users.byId(user.id)!) };
    },
    { auth: false },
  );

  r.post(
    '/api/auth/logout',
    (ctx) => {
      if (ctx.sessionToken) app.sessions.revoke(ctx.sessionToken);
      clearCookie(ctx);
      if (ctx.user) app.audit.record({ actor: ctx.user.username, ip: ctx.ip, action: 'auth.logout', outcome: 'success' });
      return { ok: true };
    },
    { auth: false },
  );

  r.get('/api/auth/me', (ctx) => ({
    user: toPublic(ctx.user!),
    session: {
      createdAt: ctx.session!.created_at,
      expiresAt: ctx.session!.expires_at,
      idleTimeoutMinutes: app.config.session.idleMinutes,
    },
  }));

  r.post('/api/auth/password', async (ctx) => {
    const b = obj(ctx.body);
    const current = reqString(b, 'currentPassword', 256);
    const next = reqString(b, 'newPassword', 256);
    const user = ctx.user!;
    if (!(await verifyPassword(current, user.password_hash))) {
      app.audit.record({ actor: user.username, ip: ctx.ip, action: 'auth.password_change', outcome: 'failure', details: { reason: 'bad_current_password' } });
      throw new HttpError(400, 'invalid_field', 'Current password is incorrect.', { field: 'currentPassword' });
    }
    if (current === next) throw new HttpError(400, 'invalid_field', 'Choose a password different from the current one.', { field: 'newPassword' });
    validateNewPassword(app, next, user.username);
    app.users.setPassword(user.id, await hashPassword(next));
    const revoked = app.sessions.revokeAllForUser(user.id, ctx.session!.id);
    app.audit.record({ actor: user.username, ip: ctx.ip, action: 'auth.password_change', outcome: 'success', details: { otherSessionsRevoked: revoked } });
    return { ok: true, otherSessionsRevoked: revoked };
  });

  r.get('/api/auth/sessions', (ctx) => ({
    sessions: app.sessions.listForUser(ctx.user!.id).map((s) => ({
      id: s.id,
      current: s.id === ctx.session!.id,
      createdAt: s.created_at,
      lastSeenAt: s.last_seen_at,
      expiresAt: s.expires_at,
      ip: s.ip,
      userAgent: s.user_agent,
    })),
  }));

  r.delete('/api/auth/sessions/:id', (ctx) => {
    const id = ctx.params.id!;
    if (!/^[0-9a-f]{64}$/.test(id)) throw new HttpError(400, 'invalid_field', 'Invalid session id.');
    if (id === ctx.session!.id) throw new HttpError(400, 'invalid_field', 'Use sign out to end the current session.');
    const ok = app.sessions.revokeById(id, ctx.user!.id);
    if (!ok) throw new HttpError(404, 'not_found', 'Session not found.');
    app.audit.record({ actor: ctx.user!.username, ip: ctx.ip, action: 'auth.session_revoke', outcome: 'success' });
    return { ok: true };
  });

  r.post('/api/auth/sessions/revoke-others', (ctx) => {
    const n = app.sessions.revokeAllForUser(ctx.user!.id, ctx.session!.id);
    app.audit.record({ actor: ctx.user!.username, ip: ctx.ip, action: 'auth.session_revoke', outcome: 'success', details: { count: n } });
    return { ok: true, revoked: n };
  });
}
