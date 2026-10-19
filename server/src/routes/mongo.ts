import { HttpError, obj, type Ctx, type Router } from '../http/core.ts';
import type { AppContext } from '../context.ts';
import { MongoAuthError, MongoConnectionError, MongoServerError } from '../mongo/client.ts';
import { MongoClient } from '../mongo/client.ts';
import { BrowseError, checkCollectionName, checkDbName, collectionStats, find, listCollections, listDatabases, parseFindInput, serverSummary } from '../mongo/browse.ts';
import { UriError, parseConnectionString, scrubSecrets } from '../mongo/uri.ts';
import { BsonError } from '../mongo/bson.ts';
import { redactMongoUri } from '../agent/backup-spec.ts';

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,39}$/;

export function registerMongoRoutes(r: Router, app: AppContext): void {
  const { mongo, mongoPool: pool } = app;
  const audit = (ctx: Ctx, action: string, target: string, outcome: 'success' | 'failure', details?: Record<string, unknown>) =>
    app.audit.record({ actor: ctx.user!.username, ip: ctx.ip, action, target, outcome, details });

  /** Validate a connection string typed into the form (syntax only; no network). */
  const readUri = (v: unknown): string => {
    if (typeof v !== 'string' || !v.trim() || v.length > 2048) {
      throw new HttpError(400, 'invalid_field', 'Enter a connection string starting with mongodb:// or mongodb+srv://.', { field: 'uri' });
    }
    const uri = v.trim();
    try {
      parseConnectionString(uri);
    } catch (e) {
      if (e instanceof UriError) throw new HttpError(400, 'invalid_field', e.message, { field: 'uri' });
      throw e;
    }
    return uri;
  };
  const readName = (v: unknown): string => {
    if (typeof v !== 'string' || !NAME.test(v.trim())) {
      throw new HttpError(400, 'invalid_field', 'Name: 1–40 characters (letters, digits, spaces, dots, dashes, underscores).', { field: 'name' });
    }
    return v.trim();
  };
  const recordOf = (raw: string | undefined) => {
    const id = Number(raw);
    const rec = Number.isInteger(id) ? mongo.get(id) : null;
    if (!rec) throw new HttpError(404, 'not_found', 'Connection not found.');
    return rec;
  };

  /** Map errors from the MongoDB client to HTTP errors with messages that are safe to show. */
  const fail = (e: unknown, uri: string | null): never => {
    if (e instanceof HttpError) throw e;
    const safe = (m: string) => scrubSecrets(m, uri);
    if (e instanceof BrowseError) throw new HttpError(400, 'invalid_field', e.message, e.field ? { field: e.field } : undefined);
    if (e instanceof MongoAuthError) throw new HttpError(502, 'mongo_auth', safe(e.message));
    if (e instanceof MongoConnectionError) throw new HttpError(502, 'mongo_unreachable', safe(e.message));
    if (e instanceof MongoServerError) {
      if (e.code === 13) throw new HttpError(403, 'mongo_forbidden', 'This MongoDB user is not allowed to do that.');
      throw new HttpError(502, 'mongo_error', safe(e.message));
    }
    if (e instanceof BsonError) throw new HttpError(400, 'invalid_field', safe(e.message));
    throw e;
  };

  /** Run something against a saved connection, noting whether it worked. */
  const withConnection = async <T>(ctx: Ctx, fn: (c: MongoClient, id: number) => Promise<T>): Promise<T> => {
    const rec = recordOf(ctx.params.id);
    const uri = mongo.uri(rec.id)!;
    try {
      const out = await pool.use(rec.id, uri, (c) => fn(c, rec.id));
      mongo.markOk(rec.id);
      return out;
    } catch (e) {
      if (e instanceof MongoConnectionError || e instanceof MongoAuthError) mongo.markFailed(rec.id, scrubSecrets(e.message, uri));
      return fail(e, uri);
    }
  };

  r.get('/api/mongo/connections', () => ({ connections: mongo.list() }));

  r.post('/api/mongo/connections', (ctx) => {
    const b = obj(ctx.body);
    const name = readName(b.name);
    const uri = readUri(b.uri);
    if (mongo.byName(name)) throw new HttpError(409, 'conflict', `A connection named "${name}" already exists.`, { field: 'name' });
    const rec = mongo.create(name, uri);
    audit(ctx, 'mongo.connection_create', name, 'success', { uri: redactMongoUri(uri) });
    return { connection: rec };
  });

  r.add('PUT', '/api/mongo/connections/:id', (ctx) => {
    const rec = recordOf(ctx.params.id);
    const b = obj(ctx.body);
    const name = b.name === undefined ? rec.name : readName(b.name);
    const clash = mongo.byName(name);
    if (clash && clash.id !== rec.id) throw new HttpError(409, 'conflict', `A connection named "${name}" already exists.`, { field: 'name' });
    // A blank connection string keeps the stored one (the password is never sent back to the browser).
    const uri = typeof b.uri === 'string' && b.uri.trim() ? readUri(b.uri) : mongo.uri(rec.id)!;
    const updated = mongo.update(rec.id, name, uri);
    pool.invalidate(rec.id);
    audit(ctx, 'mongo.connection_update', name, 'success', { uri: redactMongoUri(uri) });
    return { connection: updated };
  });

  r.delete('/api/mongo/connections/:id', (ctx) => {
    const rec = recordOf(ctx.params.id);
    mongo.delete(rec.id);
    pool.invalidate(rec.id);
    audit(ctx, 'mongo.connection_delete', rec.name, 'success');
    return { ok: true };
  });

  // Try a connection string (typed into the form, or a saved one) without saving anything.
  r.post('/api/mongo/test', async (ctx) => {
    const b = obj(ctx.body);
    let uri: string;
    if (typeof b.uri === 'string' && b.uri.trim()) uri = readUri(b.uri);
    else {
      const rec = typeof b.id === 'number' ? mongo.get(b.id) : null;
      if (!rec) throw new HttpError(400, 'invalid_field', 'Enter a connection string.', { field: 'uri' });
      uri = mongo.uri(rec.id)!;
    }
    const started = Date.now();
    let client: MongoClient | null = null;
    try {
      client = await MongoClient.connect(uri, { connectTimeoutMs: 8000 });
      const summary = await serverSummary(client);
      return { ok: true, ms: Date.now() - started, server: summary };
    } catch (e) {
      return fail(e, uri);
    } finally {
      client?.close();
    }
  });

  r.get('/api/mongo/connections/:id/databases', (ctx) =>
    withConnection(ctx, async (c) => {
      // One command at a time on a connection.
      const server = await serverSummary(c).catch(() => null);
      return { ...(await listDatabases(c)), server };
    }),
  );

  r.get('/api/mongo/connections/:id/databases/:db/collections', (ctx) =>
    withConnection(ctx, async (c) => ({ collections: await listCollections(c, checkDbName(ctx.params.db)) })),
  );

  r.get('/api/mongo/connections/:id/databases/:db/collections/:collection/stats', (ctx) =>
    withConnection(ctx, (c) => collectionStats(c, checkDbName(ctx.params.db), checkCollectionName(ctx.params.collection))),
  );

  r.post('/api/mongo/connections/:id/query', (ctx) => {
    let q: ReturnType<typeof parseFindInput>;
    try {
      q = parseFindInput(obj(ctx.body));
    } catch (e) {
      return fail(e, null);
    }
    return withConnection(ctx, (c) => find(c, q));
  });
}
