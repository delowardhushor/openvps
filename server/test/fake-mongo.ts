import { createServer, type Server, type Socket } from 'node:net';
import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Binary, Double, Int32, ObjectId, decode, encode, toPlain, type BsonDoc } from '../src/mongo/bson.ts';

/**
 * A tiny in-process MongoDB server speaking just enough OP_MSG for the browser: the handshake,
 * SCRAM-SHA-256/SHA-1 login, listDatabases, listCollections, $collStats, listIndexes, find and
 * count. Documents are plain JS values (encoded on the way out); filters support equality and
 * a few comparison operators. Every command received is recorded in `commands`.
 */

export interface FakeMongoOptions {
  user?: { name: string; password: string; db?: string; mechanisms?: ('SCRAM-SHA-256' | 'SCRAM-SHA-1')[] };
  data: Record<string, Record<string, Record<string, unknown>[]>>;
  /** Reject listDatabases with Unauthorized (a user limited to one database). */
  denyListDatabases?: boolean;
  /** listCollections is only allowed with nameOnly + authorizedCollections (a user with collection-level rights). */
  collectionLevelUser?: boolean;
  version?: string;
}

export interface FakeMongo {
  port: number;
  uri(extra?: string): string;
  commands: { db: string; name: string; body: BsonDoc }[];
  connections: number;
  close(): Promise<void>;
}

const sha = (alg: string, d: Buffer | string) => createHash(alg).update(d).digest();
const mac = (alg: string, k: Buffer, d: string) => createHmac(alg, k).update(d).digest();

function creds(mech: 'SCRAM-SHA-256' | 'SCRAM-SHA-1', user: string, password: string) {
  const alg = mech === 'SCRAM-SHA-256' ? 'sha256' : 'sha1';
  const pw = mech === 'SCRAM-SHA-1' ? createHash('md5').update(`${user}:mongo:${password}`).digest('hex') : password;
  const salt = randomBytes(16);
  const iter = mech === 'SCRAM-SHA-256' ? 15000 : 10000;
  const salted = pbkdf2Sync(pw, salt, iter, mech === 'SCRAM-SHA-256' ? 32 : 20, alg);
  return { alg, salt, iter, storedKey: sha(alg, mac(alg, salted, 'Client Key')), serverKey: mac(alg, salted, 'Server Key') };
}

function matches(doc: Record<string, unknown>, filter: BsonDoc): boolean {
  return Object.entries(filter).every(([k, cond]) => {
    const v = doc[k];
    if (cond !== null && typeof cond === 'object' && !Array.isArray(cond)) {
      return Object.entries(cond as BsonDoc).every(([op, arg]) => {
        const a = arg as number;
        if (op === '$gt') return (v as number) > a;
        if (op === '$gte') return (v as number) >= a;
        if (op === '$lt') return (v as number) < a;
        if (op === '$in') return (arg as unknown[]).some((x) => x === v);
        return false;
      });
    }
    return v === cond;
  });
}

/** Documents as the server would compare them: numbers and ObjectId hex strings. */
const plainDoc = (d: unknown): Record<string, unknown> => toPlain(decode(encode(d as BsonDoc))) as Record<string, unknown>;

export async function startFakeMongo(o: FakeMongoOptions): Promise<FakeMongo> {
  const commands: FakeMongo['commands'] = [];
  const state = { connections: 0 };
  const mechs = o.user ? (o.user.mechanisms ?? ['SCRAM-SHA-256', 'SCRAM-SHA-1']) : [];
  const stored = new Map(mechs.map((m) => [m, creds(m, o.user!.name, o.user!.password)]));

  const server: Server = createServer((sock: Socket) => {
    state.connections++;
    let buf = Buffer.alloc(0);
    let authed = !o.user;
    let convo: { mech: 'SCRAM-SHA-256' | 'SCRAM-SHA-1'; authMessage: string; serverSig: string; stage: number } | null = null;

    const reply = (to: number, doc: BsonDoc) => {
      const body = encode(doc);
      const h = Buffer.alloc(21);
      h.writeInt32LE(21 + body.length, 0);
      h.writeInt32LE(1, 4);
      h.writeInt32LE(to, 8);
      h.writeInt32LE(2013, 12);
      sock.write(Buffer.concat([h, body]));
    };
    const fail = (to: number, code: number, codeName: string, errmsg: string) => reply(to, { ok: new Double(0), errmsg, code: new Int32(code), codeName });
    const ok = (extra: BsonDoc) => ({ ok: new Double(1), ...extra });
    const batch = (ns: string, docs: unknown[]) => ({ cursor: { firstBatch: docs, id: 0n, ns } });

    const handle = (id: number, cmd: BsonDoc) => {
      const plain = toPlain(cmd) as BsonDoc;
      const name = Object.keys(cmd)[0]!;
      const db = String(plain.$db);
      commands.push({ db, name, body: plain });
      const needAuth = !['isMaster', 'hello', 'saslStart', 'saslContinue'].includes(name);
      if (needAuth && !authed) return fail(id, 13, 'Unauthorized', `command ${name} requires authentication`);

      switch (name) {
        case 'isMaster':
          return reply(id, ok({
            ismaster: true,
            isWritablePrimary: true,
            maxWireVersion: new Int32(21),
            minWireVersion: new Int32(0),
            maxBsonObjectSize: new Int32(16777216),
            ...(o.user && typeof plain.saslSupportedMechs === 'string' ? { saslSupportedMechs: mechs } : {}),
          }));
        case 'saslStart': {
          const mech = plain.mechanism as 'SCRAM-SHA-256' | 'SCRAM-SHA-1';
          const c = stored.get(mech);
          const first = (plain.payload as Buffer).toString('utf8');
          const m = /^n,,n=([^,]*),r=(.+)$/.exec(first);
          if (!c || !m || m[1] !== o.user!.name) return fail(id, 18, 'AuthenticationFailed', 'Authentication failed.');
          const nonce = m[2]! + randomBytes(12).toString('base64');
          const serverFirst = `r=${nonce},s=${c.salt.toString('base64')},i=${c.iter}`;
          convo = { mech, authMessage: `n=${m[1]},r=${m[2]},${serverFirst}`, serverSig: '', stage: 1 };
          return reply(id, ok({ conversationId: new Int32(1), done: false, payload: new Binary(0, Buffer.from(serverFirst)) }));
        }
        case 'saslContinue': {
          if (!convo) return fail(id, 18, 'AuthenticationFailed', 'No conversation.');
          const c = stored.get(convo.mech)!;
          const text = (plain.payload as Buffer).toString('utf8');
          if (convo.stage === 1) {
            const m = /^(c=biws,r=[^,]+),p=(.+)$/.exec(text);
            if (!m) return fail(id, 18, 'AuthenticationFailed', 'Bad client-final.');
            const authMessage = `${convo.authMessage},${m[1]}`;
            const sig = createHmac(c.alg, c.storedKey).update(authMessage).digest();
            const proof = Buffer.from(m[2]!, 'base64');
            const clientKey = Buffer.alloc(proof.length);
            for (let i = 0; i < proof.length; i++) clientKey[i] = proof[i]! ^ sig[i]!;
            if (!sha(c.alg, clientKey).equals(c.storedKey)) return fail(id, 18, 'AuthenticationFailed', 'Authentication failed.');
            authed = true;
            convo.stage = 2;
            const v = createHmac(c.alg, c.serverKey).update(authMessage).digest('base64');
            return reply(id, ok({ conversationId: new Int32(1), done: true, payload: new Binary(0, Buffer.from(`v=${v}`)) }));
          }
          return reply(id, ok({ conversationId: new Int32(1), done: true, payload: new Binary(0, Buffer.alloc(0)) }));
        }
        case 'buildInfo':
          return reply(id, ok({ version: o.version ?? '8.0.4' }));
        case 'listDatabases':
          if (o.denyListDatabases) return fail(id, 13, 'Unauthorized', 'not authorized on admin to execute command { listDatabases: 1 }');
          return reply(id, ok({
            databases: Object.keys(o.data).map((n) => ({ name: n, sizeOnDisk: new Double(8192), empty: false })),
            totalSize: new Double(8192),
          }));
        case 'listCollections': {
          if (o.collectionLevelUser && !(plain.nameOnly === true && plain.authorizedCollections === true)) return fail(id, 13, 'Unauthorized', `not authorized on ${db} to execute command { listCollections: 1 }`);
          const colls = o.data[db];
          if (!colls) return reply(id, ok(batch(`${db}.$cmd.listCollections`, [])));
          return reply(id, ok(batch(`${db}.$cmd.listCollections`, Object.keys(colls).map((n) => ({ name: n, type: 'collection', options: {}, info: { readOnly: false } })))));
        }
        case 'aggregate': {
          const docs = o.data[db]?.[String(plain.aggregate)];
          if (!docs) return fail(id, 26, 'NamespaceNotFound', `Unable to retrieve storageStats in $collStats stage :: caused by :: Collection [${db}.${String(plain.aggregate)}] not found.`);
          return reply(id, ok(batch(`${db}.${String(plain.aggregate)}`, [{
            ns: `${db}.${String(plain.aggregate)}`,
            storageStats: { size: new Int32(1000), count: new Int32(docs.length), avgObjSize: new Int32(100), storageSize: new Int32(4096), nindexes: new Int32(1), totalIndexSize: new Int32(4096), indexSizes: { _id_: new Int32(4096) }, capped: false },
            count: { count: new Int32(docs.length) },
          }])));
        }
        case 'listIndexes':
          return reply(id, ok(batch(`${db}.${String(plain.listIndexes)}`, [{ v: new Int32(2), key: { _id: new Int32(1) }, name: '_id_' }, { v: new Int32(2), key: { email: new Int32(1) }, name: 'email_1', unique: true }])));
        case 'killCursors':
          return reply(id, ok({ cursorsKilled: [plain.cursors], cursorsNotFound: [], cursorsAlive: [], cursorsUnknown: [] }));
        case 'find': {
          const docs = o.data[db]?.[String(plain.find)];
          // Like a real view: it runs as an aggregation, which rejects singleBatch and leaves the cursor open.
          if (String(plain.find).startsWith('view_')) {
            if ('singleBatch' in plain) return fail(id, 9, 'FailedToParse', 'Option singleBatch not supported in aggregation.');
            return reply(id, ok({ cursor: { firstBatch: (docs ?? []).slice(0, Number(plain.limit ?? 101)), id: 1234567890123456789n, ns: `${db}.${String(plain.find)}` } }));
          }
          if (!docs) return reply(id, ok(batch(`${db}.${String(plain.find)}`, [])));
          let out = docs.filter((d) => matches(plainDoc(d), plain.filter as BsonDoc));
          const sort = Object.entries((plain.sort as BsonDoc | undefined) ?? {}) as [string, number][];
          if (sort.length) {
            const [k, dir] = sort[0]!;
            out = [...out].sort((a, b) => ((plainDoc(a)[k] as number) > (plainDoc(b)[k] as number) ? 1 : -1) * dir);
          }
          out = out.slice(Number(plain.skip ?? 0), Number(plain.skip ?? 0) + Number(plain.limit ?? 101));
          return reply(id, ok(batch(`${db}.${String(plain.find)}`, out)));
        }
        case 'count': {
          const docs = o.data[db]?.[String(plain.count)] ?? [];
          return reply(id, ok({ n: new Int32(docs.filter((d) => matches(plainDoc(d), (plain.query as BsonDoc) ?? {})).length) }));
        }
        default:
          return fail(id, 59, 'CommandNotFound', `no such command: '${name}'`);
      }
    };

    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 4 && buf.length >= buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const msg = buf.subarray(0, len);
        buf = buf.subarray(len);
        handle(msg.readInt32LE(4), decode(msg.subarray(21)));
      }
    });
    sock.on('error', () => undefined);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const user = o.user;
  return {
    port,
    uri: (extra = '') => `mongodb://${user ? `${encodeURIComponent(user.name)}:${encodeURIComponent(user.password)}@` : ''}127.0.0.1:${port}/${extra}`,
    commands,
    get connections() {
      return state.connections;
    },
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}
