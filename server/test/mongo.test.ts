import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Binary, BsonDate, BsonRegExp, Decimal128, Double, Int32, Int64, ObjectId, Timestamp, decode, encode, toEjson, toPlain } from '../src/mongo/bson.ts';
import { parseQueryDoc, QueryError } from '../src/mongo/query-lang.ts';
import { ScramClient } from '../src/mongo/scram.ts';
import { parseConnectionString, scrubSecrets } from '../src/mongo/uri.ts';
import { MongoAuthError, MongoClient, MongoConnectionError } from '../src/mongo/client.ts';
import { collectionStats, find, listCollections, listDatabases, parseFindInput, serverSummary } from '../src/mongo/browse.ts';
import { MongoPool } from '../src/mongo/pool.ts';
import { startFakeMongo, type FakeMongo } from './fake-mongo.ts';

describe('bson', () => {
  test('matches the specification example', () => {
    const buf = encode({ hello: 'world' });
    assert.equal(buf.toString('hex'), '160000000268656c6c6f0006000000776f726c640000');
    assert.deepEqual({ ...(toPlain(decode(buf)) as object) }, { hello: 'world' });
  });

  test('round-trips every type and keeps their identity', () => {
    const oid = ObjectId.fromHex('507f1f77bcf86cd799439011');
    const doc = {
      i: new Int32(7),
      d: new Double(7),
      l: new Int64(2n ** 40n),
      s: 'héllo ✓',
      b: true,
      n: null,
      oid,
      date: new BsonDate(1700000000000n),
      bin: new Binary(0, Buffer.from('abc')),
      uuid: new Binary(4, Buffer.from('0123456789abcdef0123456789abcdef', 'hex')),
      re: new BsonRegExp('^a', 'im'),
      ts: new Timestamp(10, 3),
      arr: [1, 'x', { y: 2 }],
      nested: { a: { b: { c: 1 } } },
    };
    const e = JSON.parse(JSON.stringify(toEjson(decode(encode(doc))))) as Record<string, unknown>;
    assert.deepEqual(e.i, { $numberInt: '7' });
    assert.deepEqual(e.d, { $numberDouble: '7.0' });
    assert.deepEqual(e.l, { $numberLong: String(2n ** 40n) });
    assert.equal(e.s, 'héllo ✓');
    assert.deepEqual(e.oid, { $oid: '507f1f77bcf86cd799439011' });
    assert.deepEqual(e.date, { $date: '2023-11-14T22:13:20.000Z' });
    assert.deepEqual(e.bin, { $binary: { base64: 'YWJj', subType: '00' } });
    assert.deepEqual(e.uuid, { $uuid: '01234567-89ab-cdef-0123-456789abcdef' });
    assert.deepEqual(e.re, { $regularExpression: { pattern: '^a', options: 'im' } });
    assert.deepEqual(e.ts, { $timestamp: { t: 10, i: 3 } });
    assert.deepEqual(e.arr, [{ $numberInt: '1' }, 'x', { y: { $numberInt: '2' } }]);
  });

  test('plain JS numbers pick int32, int64 or double by value', () => {
    const e = JSON.parse(JSON.stringify(toEjson(decode(encode({ a: 5, b: 2 ** 33, c: 1.5, d: -1 }))))) as Record<string, unknown>;
    assert.deepEqual(e, { a: { $numberInt: '5' }, b: { $numberLong: String(2 ** 33) }, c: { $numberDouble: '1.5' }, d: { $numberInt: '-1' } });
  });

  test('decimal128 prints per the specification', () => {
    const make = (coeff: bigint, exp: number, neg = false) => {
      const b = Buffer.alloc(16);
      b.writeBigUInt64LE(coeff & ((1n << 64n) - 1n), 0);
      let hi = (coeff >> 64n) | (BigInt(exp + 6176) << 49n);
      if (neg) hi |= 1n << 63n;
      b.writeBigUInt64LE(hi, 8);
      return new Decimal128(b).toString();
    };
    assert.equal(make(15n, -1), '1.5');
    assert.equal(make(1n, -3), '0.001');
    assert.equal(make(12345n, -2, true), '-123.45');
    assert.equal(make(1n, 3), '1E+3');
    assert.equal(make(5n, 0), '5');
    assert.equal(make(1n, -10), '1E-10');
  });

  test('strings and binaries over the limit are cut with a marker', () => {
    const e = toEjson(decode(encode({ s: 'x'.repeat(50), b: new Binary(0, Buffer.alloc(50)) })), { maxString: 10, maxBinary: 10 }) as Record<string, any>;
    assert.equal(e.s.$truncated.length, 50);
    assert.equal(e.b.$truncated.type, 'binary');
  });

  test('malformed input is rejected, not crashed on', () => {
    assert.throws(() => decode(Buffer.from('0500000001', 'hex')), /Malformed/);
    assert.throws(() => decode(Buffer.from('0a0000000200ffffffff00', 'hex')));
    assert.throws(() => encode({ 'a\0b': 1 }), /null character/);
  });
});

describe('filter language', () => {
  const ej = (t: string) => JSON.parse(JSON.stringify(toEjson(parseQueryDoc(t, 'filter')))) as unknown;
  test('shell syntax: unquoted keys, single quotes, trailing commas, comments', () => {
    assert.deepEqual(ej(`{ name: 'Ann', age: {$gt: 30,}, tags: ["a", 'b'], }`), {
      name: 'Ann',
      age: { $gt: { $numberInt: '30' } },
      tags: ['a', 'b'],
    });
    assert.deepEqual(ej('{ "a.b": 1 } // note'), { 'a.b': { $numberInt: '1' } });
  });
  test('helpers and regular expressions', () => {
    assert.deepEqual(ej('{ _id: ObjectId("507f1f77bcf86cd799439011") }'), { _id: { $oid: '507f1f77bcf86cd799439011' } });
    assert.deepEqual(ej('{ at: { $gte: ISODate("2024-01-02") } }'), { at: { $gte: { $date: '2024-01-02T00:00:00.000Z' } } });
    assert.deepEqual(ej('{ n: NumberLong("9007199254740993") }'), { n: { $numberLong: '9007199254740993' } });
    assert.deepEqual(ej('{ u: UUID("01234567-89ab-cdef-0123-456789abcdef") }'), { u: { $uuid: '01234567-89ab-cdef-0123-456789abcdef' } });
    assert.deepEqual(ej('{ name: /^an+/i }'), { name: { $regularExpression: { pattern: '^an+', options: 'i' } } });
    assert.deepEqual(ej('{ name: { $regex: "^a", $options: "i" } }'), { name: { $regex: '^a', $options: 'i' } });
  });
  test('Extended JSON works too', () => {
    assert.deepEqual(ej('{"_id": {"$oid": "507f1f77bcf86cd799439011"}, "d": {"$date": "2020-01-01T00:00:00Z"}, "n": {"$numberLong": "5"}}'), {
      _id: { $oid: '507f1f77bcf86cd799439011' },
      d: { $date: '2020-01-01T00:00:00.000Z' },
      n: { $numberLong: '5' },
    });
  });
  test('empty text is an empty document', () => {
    assert.deepEqual({ ...parseQueryDoc('  ', 'filter') }, {});
  });
  test('errors say where and what', () => {
    assert.throws(() => parseQueryDoc('{ a: }', 'filter'), (e: Error) => e instanceof QueryError && /^Filter: Unexpected "}"/.test(e.message));
    assert.throws(() => parseQueryDoc('{ a: 1', 'filter'), /Expected/);
    assert.throws(() => parseQueryDoc('[1]', 'filter'), /must be a document/);
    assert.throws(() => parseQueryDoc('{ a: foo }', 'filter'), /Unknown name "foo"/);
    assert.throws(() => parseQueryDoc('{ a: ObjectId("zz") }', 'filter'), /24 hex/);
    assert.throws(() => parseQueryDoc('{ a: process.exit() }', 'filter'));
    assert.throws(() => parseQueryDoc('{ a: 1 } x', 'filter'), /after the end/);
  });
  test('server-side JavaScript is refused anywhere in the tree', () => {
    assert.throws(() => parseQueryDoc('{ $where: "sleep(1000)" }', 'filter'), /\$where runs JavaScript/);
    assert.throws(() => parseQueryDoc('{ $or: [ { $where: "1" } ] }', 'filter'), /\$where/);
    assert.throws(() => parseQueryDoc('{ x: { $function: { body: "f", args: [], lang: "js" } } }', 'projection'), /\$function/);
  });
  test('absurd nesting is rejected', () => {
    assert.throws(() => parseQueryDoc('['.repeat(5000), 'filter'));
    assert.throws(() => parseQueryDoc('{a:'.repeat(200) + '1' + '}'.repeat(200), 'filter'), /deeply/);
  });
});

describe('scram', () => {
  test('RFC 7677 SCRAM-SHA-256 example', () => {
    const c = new ScramClient('SCRAM-SHA-256', 'user', 'pencil', 'rOprNGfwEbeRWgbNEkqO');
    assert.equal(c.first(), 'n,,n=user,r=rOprNGfwEbeRWgbNEkqO');
    const final = c.final('r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096');
    assert.equal(final, 'c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,p=dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=');
    c.verify('v=6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=');
    assert.throws(() => c.verify('v=AAAA'), /could not prove/);
  });
  test('refuses a server that does not echo our nonce', () => {
    const c = new ScramClient('SCRAM-SHA-256', 'user', 'pencil', 'abc');
    assert.throws(() => c.final('r=zzz,s=c2FsdA==,i=4096'), /nonce/);
  });
});

describe('connection strings', () => {
  test('parses users, hosts, database and options', () => {
    const p = parseConnectionString('mongodb://a%40b:p%3Aw@h1:1,h2/db?authSource=admin&tls=true');
    assert.equal(p.username, 'a@b');
    assert.equal(p.password, 'p:w');
    assert.deepEqual(p.hosts, [{ host: 'h1', port: 1 }, { host: 'h2', port: 27017 }]);
    assert.equal(p.database, 'db');
    assert.equal(p.options.authsource, 'admin');
    assert.equal(parseConnectionString('mongodb://[::1]:27018').hosts[0]!.host, '::1');
  });
  test('rejects nonsense', () => {
    assert.throws(() => parseConnectionString('http://x'));
    assert.throws(() => parseConnectionString('mongodb+srv://a.example.com:27017'), /port/);
    assert.throws(() => parseConnectionString('mongodb://u:%zz@h'), /escape/);
  });
  test('scrubs the password from messages', () => {
    assert.equal(scrubSecrets('failed for mongodb://bob:hunter22@h/db', null), 'failed for mongodb://bob:***@h/db');
    assert.equal(scrubSecrets('bad password hunter22 here', 'mongodb://bob:hunter22@h/db'), 'bad password *** here');
  });
});

describe('client and browser against a fake server', () => {
  let fake: FakeMongo;
  const data = {
    shop: {
      users: Array.from({ length: 45 }, (_, i) => ({ _id: ObjectId.fromHex(String(i).padStart(24, '0')), n: i, name: `user${i}`, email: `u${i}@x.io` })),
      orders: [{ _id: 1, total: new Double(9.5) }],
      view_users: [{ _id: 1, name: 'v1' }, { _id: 2, name: 'v2' }],
    },
    admin: {},
  };

  before(async () => {
    fake = await startFakeMongo({ data, user: { name: 'root', password: 'p@ss:word' } });
  });
  after(async () => {
    await fake.close();
  });

  test('logs in with SCRAM-SHA-256 and reads the server summary', async () => {
    const c = await MongoClient.connect(fake.uri('?authSource=admin'));
    try {
      const s = await serverSummary(c);
      assert.equal(s.version, '8.0.4');
      assert.equal(s.authenticated, true);
      assert.equal(s.topology, 'standalone');
      assert.equal(s.canListDatabases, true);
    } finally {
      c.close();
    }
  });

  test('falls back to SCRAM-SHA-1 when that is all the server offers', async () => {
    const f = await startFakeMongo({ data, user: { name: 'old', password: 'pw', mechanisms: ['SCRAM-SHA-1'] } });
    try {
      const c = await MongoClient.connect(f.uri());
      assert.equal((await listDatabases(c)).databases.length, 2);
      c.close();
    } finally {
      await f.close();
    }
  });

  test('a wrong password fails clearly and does not leak it', async () => {
    const bad = fake.uri().replace('p%40ss%3Aword', 'nope');
    await assert.rejects(MongoClient.connect(bad), (e: Error) => e instanceof MongoAuthError && /Authentication failed/.test(e.message) && !e.message.includes('nope'));
  });

  test('an unreachable server is a connection error', async () => {
    await assert.rejects(MongoClient.connect('mongodb://127.0.0.1:1/?connectTimeoutMS=1000'), MongoConnectionError);
  });

  test('lists databases, collections, stats and indexes', async () => {
    const c = await MongoClient.connect(fake.uri());
    try {
      assert.deepEqual((await listDatabases(c)).databases.map((d) => d.name), ['admin', 'shop']);
      assert.deepEqual((await listCollections(c, 'shop')).map((x) => x.name), ['orders', 'users', 'view_users']);
      const st = await collectionStats(c, 'shop', 'users');
      assert.equal(st.stats?.count, 45);
      assert.equal(st.indexes.length, 2);
      assert.equal(st.indexes[1]!.unique, true);
      assert.equal(st.indexes[1]!.sizeBytes, null);
      assert.equal(st.indexes[0]!.sizeBytes, 4096);
      assert.deepEqual(JSON.parse(JSON.stringify(st.indexes[1]!.key)), { email: { $numberInt: '1' } });
    } finally {
      c.close();
    }
  });

  test('find pages, sorts, filters and counts', async () => {
    const c = await MongoClient.connect(fake.uri());
    try {
      const page = await find(c, parseFindInput({ db: 'shop', collection: 'users', filter: '', sort: '{ n: -1 }', skip: 10, limit: 5 }));
      assert.equal(page.documents.length, 5);
      assert.equal(page.total, 45);
      assert.deepEqual((page.documents[0] as any).n, { $numberInt: '34' });
      assert.deepEqual(JSON.parse(JSON.stringify((page.documents[0] as any)._id)), { $oid: '000000000000000000000034' });
      const some = await find(c, parseFindInput({ db: 'shop', collection: 'users', filter: '{ n: { $gte: 40 } }', limit: 100 }));
      assert.equal(some.documents.length, 5);
      assert.equal(some.total, 5);
      const byId = await find(c, parseFindInput({ db: 'shop', collection: 'users', filter: '{ _id: ObjectId("000000000000000000000007") }' }));
      assert.equal(byId.documents.length, 1);
      assert.deepEqual((byId.documents[0] as any).name, 'user7');
    } finally {
      c.close();
    }
  });

  test('a view works: no singleBatch, and the cursor it leaves open is closed', async () => {
    const c = await MongoClient.connect(fake.uri());
    try {
      const r = await find(c, parseFindInput({ db: 'shop', collection: 'view_users', limit: 5 }));
      assert.equal(r.documents.length, 2);
      const kill = fake.commands.filter((x) => x.name === 'killCursors').at(-1);
      assert.ok(kill);
      assert.equal(kill.body.killCursors, 'view_users');
    } finally {
      c.close();
    }
  });

  test('the only commands ever sent are the read-only ones', () => {
    const allowed = new Set(['killCursors', 'isMaster', 'saslStart', 'saslContinue', 'buildInfo', 'listDatabases', 'listCollections', 'aggregate', 'listIndexes', 'find', 'count']);
    assert.ok(fake.commands.length > 10);
    for (const c of fake.commands) assert.ok(allowed.has(c.name), `unexpected command ${c.name}`);
    const agg = fake.commands.filter((c) => c.name === 'aggregate');
    for (const a of agg) assert.deepEqual(Object.keys((a.body.pipeline as Record<string, unknown>[])[0]!), ['$collStats']);
  });

  test('input is validated before anything is sent', () => {
    assert.throws(() => parseFindInput({ db: 'a.b', collection: 'c' }), /Invalid database/);
    assert.throws(() => parseFindInput({ db: 'a', collection: '$cmd' }), /Invalid collection/);
    assert.throws(() => parseFindInput({ db: 'a', collection: 'c', limit: 1000 }), /Limit/);
    assert.throws(() => parseFindInput({ db: 'a', collection: 'c', skip: -1 }), /Skip/);
    assert.throws(() => parseFindInput({ db: 'a', collection: 'c', filter: '{ $where: "1" }' }), /\$where/);
  });

  test('a user who cannot list databases still sees the one in the connection string', async () => {
    const f = await startFakeMongo({ data, denyListDatabases: true });
    try {
      const c = await MongoClient.connect(f.uri('shop'));
      const r = await listDatabases(c);
      assert.deepEqual(r.databases.map((d) => d.name), ['shop']);
      assert.match(r.note ?? '', /may not list/);
      c.close();
    } finally {
      await f.close();
    }
  });

  test('a user with collection-level rights still gets the collection names', async () => {
    const f = await startFakeMongo({ data, collectionLevelUser: true });
    try {
      const c = await MongoClient.connect(f.uri());
      assert.deepEqual((await listCollections(c, 'shop')).map((x) => x.name), ['orders', 'users', 'view_users']);
      c.close();
    } finally {
      await f.close();
    }
  });

  test('the pool reuses a connection and replaces a dead one', async () => {
    const f = await startFakeMongo({ data });
    const pool = new MongoPool({ idleMs: 5000 });
    try {
      await pool.use(1, f.uri(), (c) => listDatabases(c));
      await pool.use(1, f.uri(), (c) => listDatabases(c));
      assert.equal(f.connections, 1);
      await pool.use(1, f.uri(), async (c) => c.close());
      const again = await pool.use(1, f.uri(), (c) => listDatabases(c));
      assert.equal(again.databases.length, 2);
      assert.equal(f.connections, 2);
    } finally {
      pool.closeAll();
      await f.close();
    }
  });
});
