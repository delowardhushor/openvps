import { MongoClient, MongoServerError } from './client.ts';
import { toEjson, type BsonDoc } from './bson.ts';
import { parseQueryDoc, QueryError } from './query-lang.ts';

/**
 * Read-only operations for the MongoDB browser. This is the whole list of commands the panel
 * ever sends (besides the handshake and login): listDatabases, listCollections, aggregate with
 * $collStats, listIndexes, find and count. Nothing here can write, and filters that run
 * JavaScript on the server are refused (see query-lang.ts).
 */

export class BrowseError extends Error {
  readonly field: string | null;
  constructor(message: string, field: string | null = null) {
    super(message);
    this.field = field;
  }
}

export const LIMITS = {
  maxPageSize: 100,
  findMs: 15_000,
  countMs: 5_000,
  maxSkip: 10_000_000,
  maxCollections: 5000,
  /** Strings/binaries longer than this are cut in responses. */
  maxValue: 64 * 1024,
};

const BAD_DB = /[\0/\\. "$*<>:|?]/;

export function checkDbName(name: unknown): string {
  if (typeof name !== 'string' || !name || name.length > 63 || BAD_DB.test(name)) throw new BrowseError('Invalid database name.', 'db');
  return name;
}

export function checkCollectionName(name: unknown): string {
  if (typeof name !== 'string' || !name || name.length > 255 || name.includes('\0') || name.startsWith('$')) {
    throw new BrowseError('Invalid collection name.', 'collection');
  }
  return name;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const obj = (v: unknown): BsonDoc => (typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as BsonDoc) : (Object.create(null) as BsonDoc));
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export interface ServerSummary {
  version: string | null;
  topology: string;
  setName: string | null;
  role: string | null;
  host: string;
  port: number;
  tls: boolean;
  authenticated: boolean;
  /** Whether the user may list all databases. */
  canListDatabases: boolean;
}

export async function serverSummary(c: MongoClient): Promise<ServerSummary> {
  let version: string | null = null;
  try {
    version = str((await c.command('admin', { buildInfo: 1 }, { timeoutMs: 10_000 })).plain.version);
  } catch (e) {
    if (!(e instanceof MongoServerError)) throw e; // buildInfo may be denied
  }
  let canList = true;
  try {
    await c.command('admin', { listDatabases: 1, nameOnly: true, authorizedDatabases: true }, { timeoutMs: 10_000 });
  } catch (e) {
    if (!(e instanceof MongoServerError)) throw e;
    canList = false;
  }
  const i = c.info;
  return { version, topology: i.topology, setName: i.setName, role: i.role, host: i.host, port: i.port, tls: i.tls, authenticated: i.authenticated, canListDatabases: canList };
}

export interface DatabaseInfo {
  name: string;
  sizeOnDisk: number | null;
  empty: boolean;
}

export async function listDatabases(c: MongoClient): Promise<{ databases: DatabaseInfo[]; note: string | null }> {
  try {
    const r = (await c.command('admin', { listDatabases: 1, authorizedDatabases: true }, { timeoutMs: 20_000 })).plain;
    const databases = arr(r.databases)
      .map((d) => ({ name: str(obj(d).name) ?? '', sizeOnDisk: num(obj(d).sizeOnDisk), empty: obj(d).empty === true }))
      .filter((d) => d.name);
    return { databases: databases.sort((a, b) => a.name.localeCompare(b.name)), note: null };
  } catch (e) {
    // Users limited to one database cannot list all of them; fall back to the one in the connection string.
    if (e instanceof MongoServerError && (e.code === 13 || e.codeName === 'Unauthorized') && c.defaultDb) {
      return { databases: [{ name: c.defaultDb, sizeOnDisk: null, empty: false }], note: 'This user may not list all databases, so only the one in the connection string is shown.' };
    }
    throw e;
  }
}

export interface CollectionInfo {
  name: string;
  type: string;
  capped: boolean;
  viewOn: string | null;
  system: boolean;
}

export async function listCollections(c: MongoClient, db: string): Promise<CollectionInfo[]> {
  checkDbName(db);
  const out: CollectionInfo[] = [];
  const take = (batch: unknown[]) => {
    for (const x of batch) {
      const d = obj(x);
      const name = str(d.name);
      if (!name) continue;
      const opts = obj(d.options);
      out.push({ name, type: str(d.type) ?? 'collection', capped: opts.capped === true, viewOn: str(opts.viewOn), system: name.startsWith('system.') });
    }
  };
  let r;
  try {
    r = (await c.command(db, { listCollections: 1, cursor: {} }, { timeoutMs: 20_000 })).plain;
  } catch (e) {
    // A user with rights on some collections only (not on the database) may list the ones they can use by name.
    if (!(e instanceof MongoServerError) || e.code !== 13) throw e;
    r = (await c.command(db, { listCollections: 1, nameOnly: true, authorizedCollections: true, cursor: {} }, { timeoutMs: 20_000 })).plain;
  }
  const cur = obj(r.cursor);
  take(arr(cur.firstBatch));
  let id = cur.id as number | undefined;
  while (id && out.length < LIMITS.maxCollections) {
    const m = (await c.command(db, { getMore: id, collection: '$cmd.listCollections' }, { timeoutMs: 20_000 })).plain;
    const next = obj(m.cursor);
    take(arr(next.nextBatch));
    id = next.id as number | undefined;
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export interface CollectionStats {
  count: number | null;
  size: number | null;
  avgObjSize: number | null;
  storageSize: number | null;
  totalIndexSize: number | null;
  indexCount: number | null;
  capped: boolean;
}

export interface IndexInfo {
  name: string;
  key: unknown;
  unique: boolean;
  sparse: boolean;
  ttlSeconds: number | null;
  partial: unknown | null;
  sizeBytes: number | null;
}

export async function collectionStats(c: MongoClient, db: string, coll: string): Promise<{ stats: CollectionStats | null; indexes: IndexInfo[]; note: string | null }> {
  checkDbName(db);
  checkCollectionName(coll);
  let stats: CollectionStats | null = null;
  let indexSizes: Record<string, number> = {};
  let note: string | null = null;
  try {
    const r = (await c.command(db, { aggregate: coll, pipeline: [{ $collStats: { storageStats: {}, count: {} } }], cursor: {} }, { timeoutMs: 15_000 })).plain;
    const first = obj(arr(obj(r.cursor).firstBatch)[0]);
    const s = obj(first.storageStats);
    indexSizes = Object.fromEntries(Object.entries(obj(s.indexSizes)).filter(([, v]) => typeof v === 'number')) as Record<string, number>;
    stats = {
      count: num(s.count) ?? num(obj(first.count).count),
      size: num(s.size),
      avgObjSize: num(s.avgObjSize),
      storageSize: num(s.storageSize),
      totalIndexSize: num(s.totalIndexSize),
      indexCount: num(s.nindexes),
      capped: s.capped === true,
    };
  } catch (e) {
    if (!(e instanceof MongoServerError)) throw e;
    note = e.code === 166 ? 'Views have no storage statistics.' : `Statistics are not available: ${e.message}`;
  }
  let indexes: IndexInfo[] = [];
  try {
    const r = await c.command(db, { listIndexes: coll, cursor: {} }, { timeoutMs: 15_000 });
    const plainBatch = arr(obj(r.plain.cursor).firstBatch);
    const typedBatch = arr(obj(r.typed.cursor).firstBatch);
    indexes = plainBatch.map((x, i) => {
      const d = obj(x);
      const typed = obj(typedBatch[i]);
      const name = str(d.name) ?? '?';
      return {
        name,
        key: toEjson(typed.key),
        unique: d.unique === true,
        sparse: d.sparse === true,
        ttlSeconds: num(d.expireAfterSeconds),
        partial: d.partialFilterExpression ? toEjson(typed.partialFilterExpression) : null,
        sizeBytes: indexSizes[name] ?? null,
      };
    });
  } catch (e) {
    if (!(e instanceof MongoServerError)) throw e;
    // Views have no indexes to list.
  }
  return { stats, indexes, note };
}

export interface FindQuery {
  db: string;
  collection: string;
  filter: BsonDoc;
  sort: BsonDoc;
  projection: BsonDoc;
  skip: number;
  limit: number;
}

export interface FindResult {
  documents: unknown[];
  /** Matching documents, or null when counting took too long. */
  total: number | null;
  skip: number;
  limit: number;
  ms: number;
}

function intIn(v: unknown, min: number, max: number, field: string, label: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new BrowseError(`${label} must be a whole number from ${min} to ${max}.`, field);
  return v;
}

export function parseFindInput(b: Record<string, unknown>): FindQuery {
  const text = (k: string) => (typeof b[k] === 'string' ? (b[k] as string) : '');
  try {
    return {
      db: checkDbName(b.db),
      collection: checkCollectionName(b.collection),
      filter: parseQueryDoc(text('filter'), 'filter'),
      sort: parseQueryDoc(text('sort'), 'sort'),
      projection: parseQueryDoc(text('projection'), 'projection'),
      skip: b.skip === undefined ? 0 : intIn(b.skip, 0, LIMITS.maxSkip, 'skip', 'Skip'),
      limit: b.limit === undefined ? 20 : intIn(b.limit, 1, LIMITS.maxPageSize, 'limit', 'Limit'),
    };
  } catch (e) {
    if (e instanceof QueryError) {
      const m = /^(Filter|Sort|Projection):/.exec(e.message);
      throw new BrowseError(e.message, m ? m[1]!.toLowerCase() : null);
    }
    throw e;
  }
}

export async function find(c: MongoClient, q: FindQuery): Promise<FindResult> {
  const started = Date.now();
  const cmd: BsonDoc = {
    find: q.collection,
    filter: q.filter,
    skip: q.skip,
    limit: q.limit,
    batchSize: q.limit,
    singleBatch: true,
    maxTimeMS: LIMITS.findMs,
  };
  if (Object.keys(q.sort).length) cmd.sort = q.sort;
  if (Object.keys(q.projection).length) cmd.projection = q.projection;
  let r;
  try {
    r = await c.command(q.db, cmd, { timeoutMs: LIMITS.findMs + 5000 });
  } catch (e) {
    if (e instanceof MongoServerError && e.code === 50) throw new BrowseError('The query took too long and was stopped. Add a more selective filter or an indexed sort.');
    if (e instanceof MongoServerError && e.code !== 13) throw new BrowseError(e.message);
    throw e;
  }
  const batch = obj(r.typed.cursor).firstBatch;
  const documents = (Array.isArray(batch) ? batch : []).map((d) => toEjson(d, { maxString: LIMITS.maxValue, maxBinary: LIMITS.maxValue }));

  let total: number | null = null;
  try {
    const countCmd: BsonDoc = { count: q.collection, maxTimeMS: LIMITS.countMs };
    if (Object.keys(q.filter).length) countCmd.query = q.filter;
    total = num((await c.command(q.db, countCmd, { timeoutMs: LIMITS.countMs + 5000 })).plain.n);
  } catch (e) {
    if (!(e instanceof MongoServerError)) throw e;
    // Counting is a nicety (views, timeouts): the documents are still shown.
  }
  return { documents, total, skip: q.skip, limit: q.limit, ms: Date.now() - started };
}
