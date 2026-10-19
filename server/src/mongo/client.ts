import { connect as netConnect, isIP, type Socket } from 'node:net';
import { connect as tlsConnect } from 'node:tls';
import { Binary, decode, encode, toPlain, type BsonDoc } from './bson.ts';
import { ScramClient, ScramError, type ScramMechanism } from './scram.ts';
import { UriError, parseConnectionString, resolveSrvUri, scrubSecrets, type ParsedUri } from './uri.ts';

/**
 * A minimal MongoDB wire-protocol client (OP_MSG, MongoDB 3.6+) with SCRAM authentication and
 * optional TLS. It exists so that the panel can browse databases without any npm dependency.
 * It only sends the few read-only commands the browser needs; see browse.ts.
 */

const OP_MSG = 2013;
const MAX_MESSAGE = 64 * 1024 * 1024;
const DEFAULT_CONNECT_MS = 10_000;
const DEFAULT_COMMAND_MS = 30_000;
const APP_NAME = 'OpenVPS';

/** An error reported by the MongoDB server itself (the connection is still usable). */
export class MongoServerError extends Error {
  readonly code: number | null;
  readonly codeName: string | null;
  constructor(message: string, code: number | null, codeName: string | null) {
    super(message);
    this.code = code;
    this.codeName = codeName;
  }
}

/** The server could not be reached, spoke nonsense, or dropped the connection. */
export class MongoConnectionError extends Error {}
/** The server rejected the user name, password or auth database. */
export class MongoAuthError extends Error {}

export interface Reply {
  /** Plain JS values: numbers, strings, Dates, Buffers. */
  plain: BsonDoc;
  /** Typed values, for Extended JSON output. */
  typed: BsonDoc;
}

export interface ServerInfo {
  host: string;
  port: number;
  version: string | null;
  topology: 'standalone' | 'replicaset' | 'sharded';
  setName: string | null;
  role: 'primary' | 'secondary' | 'other' | null;
  maxWireVersion: number;
  tls: boolean;
  authenticated: boolean;
}

class Wire {
  private readonly socket: Socket;
  private chunks: Buffer[] = [];
  private size = 0;
  private nextId = 1;
  private pending: { id: number; resolve: (b: Buffer) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  closed = false;
  private closeReason: Error | null = null;

  constructor(socket: Socket) {
    this.socket = socket;
    socket.on('data', (d: Buffer) => {
      this.chunks.push(d);
      this.size += d.length;
      this.drain();
    });
    socket.on('error', (e) => this.fail(new MongoConnectionError(`Connection error: ${e.message}`)));
    socket.on('close', () => this.fail(new MongoConnectionError('The server closed the connection.')));
  }

  private fail(e: Error): void {
    if (this.closed) return;
    this.closed = true;
    this.closeReason = e;
    const p = this.pending;
    this.pending = null;
    if (p) {
      clearTimeout(p.timer);
      p.reject(e);
    }
    this.socket.destroy();
  }

  private drain(): void {
    for (;;) {
      if (this.size < 4) return;
      const first = this.chunks[0]!;
      const len = (first.length >= 4 ? first : Buffer.concat(this.chunks)).readInt32LE(0);
      if (len < 21 || len > MAX_MESSAGE) {
        this.fail(new MongoConnectionError('The server sent a malformed message.'));
        return;
      }
      if (this.size < len) return;
      const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
      const frame = all.subarray(0, len);
      const rest = all.subarray(len);
      this.chunks = rest.length ? [rest] : [];
      this.size = rest.length;
      const p = this.pending;
      if (!p) continue;
      if (frame.readInt32LE(8) !== p.id) continue; // not ours: ignore
      this.pending = null;
      clearTimeout(p.timer);
      p.resolve(frame);
    }
  }

  request(body: Buffer, timeoutMs: number): Promise<Buffer> {
    if (this.closed) return Promise.reject(this.closeReason ?? new MongoConnectionError('The connection is closed.'));
    if (this.pending) return Promise.reject(new Error('One request at a time per connection.'));
    const id = this.nextId++;
    const header = Buffer.alloc(16 + 4 + 1);
    header.writeInt32LE(16 + 4 + 1 + body.length, 0);
    header.writeInt32LE(id, 4);
    header.writeInt32LE(0, 8);
    header.writeInt32LE(OP_MSG, 12);
    header.writeUInt32LE(0, 16); // flag bits
    header[20] = 0; // section kind 0
    return new Promise<Buffer>((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new MongoConnectionError(`The server did not answer within ${Math.round(timeoutMs / 1000)} seconds.`)), timeoutMs);
      this.pending = { id, resolve, reject, timer };
      this.socket.write(Buffer.concat([header, body]), (err) => {
        if (err) this.fail(new MongoConnectionError(`Connection error: ${err.message}`));
      });
    });
  }

  close(): void {
    this.fail(new MongoConnectionError('The connection was closed.'));
  }
}

function openSocket(host: string, port: number, o: { tls: boolean; allowInvalidCerts: boolean; timeoutMs: number }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const onError = (e: Error) => {
      socket.destroy();
      reject(new MongoConnectionError(`Cannot connect to ${host}:${port}: ${(e as NodeJS.ErrnoException).code ?? e.message}`));
    };
    const socket: Socket = o.tls
      ? tlsConnect({ host, port, servername: isIP(host) ? undefined : host, rejectUnauthorized: !o.allowInvalidCerts, minVersion: 'TLSv1.2' })
      : netConnect({ host, port });
    socket.setNoDelay(true);
    socket.setTimeout(o.timeoutMs, () => onError(new Error('timed out')));
    socket.once('error', onError);
    socket.once(o.tls ? 'secureConnect' : 'connect', () => {
      socket.setTimeout(0);
      socket.removeListener('error', onError);
      resolve(socket);
    });
  });
}

const truthy = (v: string | undefined) => v === 'true' || v === '1';

export class MongoClient {
  readonly info: ServerInfo;
  private readonly wire: Wire;
  private readonly secrets: string;
  private readonly readPref: boolean;
  private readonly authDb: string;

  private constructor(wire: Wire, info: ServerInfo, uri: string, readPref: boolean, authDb: string) {
    this.wire = wire;
    this.info = info;
    this.secrets = uri;
    this.readPref = readPref;
    this.authDb = authDb;
  }

  get closed(): boolean {
    return this.wire.closed;
  }

  /** Database named in the connection string, if any. */
  get defaultDb(): string | null {
    return this.defaultDatabase;
  }
  private defaultDatabase: string | null = null;

  static async connect(uri: string, opts: { connectTimeoutMs?: number } = {}): Promise<MongoClient> {
    let parsed: ParsedUri;
    try {
      parsed = await resolveSrvUri(parseConnectionString(uri));
    } catch (e) {
      if (e instanceof UriError) throw new MongoConnectionError(e.message);
      throw e;
    }
    const o = parsed.options;
    const mech = o.authmechanism?.toUpperCase();
    if (mech && mech !== 'SCRAM-SHA-256' && mech !== 'SCRAM-SHA-1' && mech !== 'DEFAULT') {
      throw new MongoConnectionError(`Authentication mechanism ${o.authmechanism} is not supported here; use a user name and password (SCRAM).`);
    }
    if (o.tlscafile || o.tlscertificatekeyfile || o.sslcafile || o.tlscertificatekeyfilepassword) {
      throw new MongoConnectionError('Certificate files (tlsCAFile, tlsCertificateKeyFile) are not supported here.');
    }
    const tls = o.tls !== undefined ? truthy(o.tls) : o.ssl !== undefined ? truthy(o.ssl) : false;
    const allowInvalid = truthy(o.tlsallowinvalidcertificates) || truthy(o.tlsinsecure);
    const timeoutMs = Math.min(Math.max(Number(o.connecttimeoutms) || opts.connectTimeoutMs || DEFAULT_CONNECT_MS, 1000), 30_000);

    const errors: string[] = [];
    for (const h of parsed.hosts) {
      let socket: Socket;
      try {
        socket = await openSocket(h.host, h.port, { tls, allowInvalidCerts: allowInvalid, timeoutMs });
      } catch (e) {
        errors.push(scrubSecrets((e as Error).message, uri));
        continue;
      }
      const wire = new Wire(socket);
      try {
        const c = await MongoClient.handshake(wire, parsed, h.host, h.port, tls, uri);
        return c;
      } catch (e) {
        wire.close();
        if (e instanceof MongoAuthError) throw e;
        errors.push(scrubSecrets((e as Error).message, uri));
        if (e instanceof MongoServerError) break; // a server that answers wrongly will do so for every host
      }
    }
    throw new MongoConnectionError(errors.length ? errors[0]! : 'No host to connect to.');
  }

  private static async handshake(wire: Wire, p: ParsedUri, host: string, port: number, tls: boolean, uri: string): Promise<MongoClient> {
    const authDb = p.options.authsource || p.database || 'admin';
    const hello: BsonDoc = {
      isMaster: 1,
      helloOk: true,
      client: { application: { name: APP_NAME }, driver: { name: 'openvps', version: '1' }, os: { type: process.platform } },
    };
    if (p.username) hello.saslSupportedMechs = `${authDb}.${p.username}`;
    const reply = await rawCommand(wire, 'admin', hello, false, DEFAULT_COMMAND_MS, uri);
    const h = reply.plain;
    const maxWire = Number(h.maxWireVersion ?? 0);
    if (maxWire < 6) throw new MongoServerError('This MongoDB server is too old (3.6 or newer is required).', null, null);

    let authenticated = false;
    if (p.username) {
      const offered = Array.isArray(h.saslSupportedMechs) ? (h.saslSupportedMechs as string[]) : null;
      const wanted = p.options.authmechanism?.toUpperCase();
      let mechanism: ScramMechanism;
      if (wanted === 'SCRAM-SHA-256' || wanted === 'SCRAM-SHA-1') mechanism = wanted;
      else if (offered) mechanism = offered.includes('SCRAM-SHA-256') ? 'SCRAM-SHA-256' : 'SCRAM-SHA-1';
      else mechanism = maxWire >= 7 ? 'SCRAM-SHA-256' : 'SCRAM-SHA-1';
      await authenticate(wire, new ScramClient(mechanism, p.username, p.password ?? ''), authDb, uri);
      authenticated = true;
    }

    const setName = typeof h.setName === 'string' ? h.setName : null;
    const topology = h.msg === 'isdbgrid' ? 'sharded' : setName ? 'replicaset' : 'standalone';
    const role = h.isWritablePrimary === true || h.ismaster === true ? 'primary' : h.secondary === true ? 'secondary' : setName ? 'other' : null;
    const info: ServerInfo = { host, port, version: null, topology, setName, role, maxWireVersion: maxWire, tls, authenticated };
    const client = new MongoClient(wire, info, uri, topology === 'replicaset', authDb);
    client.defaultDatabase = p.database;
    return client;
  }

  /** Run a command on `db`. Throws MongoServerError when the server says ok: 0. */
  async command(db: string, cmd: BsonDoc, opts: { timeoutMs?: number } = {}): Promise<Reply> {
    return rawCommand(this.wire, db, cmd, this.readPref, opts.timeoutMs ?? DEFAULT_COMMAND_MS, this.secrets);
  }

  close(): void {
    this.wire.close();
  }

  /** Authentication database, for messages. */
  get authSource(): string {
    return this.authDb;
  }
}

async function rawCommand(wire: Wire, db: string, cmd: BsonDoc, readPref: boolean, timeoutMs: number, uri: string): Promise<Reply> {
  const body: BsonDoc = { ...cmd, $db: db };
  if (readPref) body.$readPreference = { mode: 'primaryPreferred' };
  const frame = await wire.request(encode(body), timeoutMs);
  const opcode = frame.readInt32LE(12);
  if (opcode !== OP_MSG) throw new MongoConnectionError('The server sent an unexpected kind of message.');
  const flags = frame.readUInt32LE(16);
  const end = flags & 1 ? frame.length - 4 : frame.length;
  if (frame[20] !== 0) throw new MongoConnectionError('The server sent an unexpected message section.');
  let typed: BsonDoc;
  try {
    typed = decode(frame.subarray(21, end));
  } catch (e) {
    throw new MongoConnectionError(`The server sent a malformed reply: ${(e as Error).message}`);
  }
  const plain = toPlain(typed) as BsonDoc;
  if (plain.ok !== 1) {
    const msg = scrubSecrets(typeof plain.errmsg === 'string' ? plain.errmsg : 'The command failed.', uri);
    throw new MongoServerError(msg, typeof plain.code === 'number' ? plain.code : null, typeof plain.codeName === 'string' ? plain.codeName : null);
  }
  return { plain, typed };
}

async function authenticate(wire: Wire, scram: ScramClient, authDb: string, uri: string): Promise<void> {
  const payload = (b: string) => new Binary(0, Buffer.from(b, 'utf8'));
  const text = (v: unknown): string => (Buffer.isBuffer(v) ? v.toString('utf8') : '');
  try {
    let r = await rawCommand(
      wire,
      authDb,
      { saslStart: 1, mechanism: scram.mechanism, payload: payload(scram.first()), autoAuthorize: 1, options: { skipEmptyExchange: true } },
      false,
      DEFAULT_COMMAND_MS,
      uri,
    );
    const id = r.plain.conversationId;
    r = await rawCommand(wire, authDb, { saslContinue: 1, conversationId: id, payload: payload(scram.final(text(r.plain.payload))) }, false, DEFAULT_COMMAND_MS, uri);
    scram.verify(text(r.plain.payload));
    // Servers that ignore skipEmptyExchange want one more, empty, round.
    for (let guard = 0; r.plain.done !== true && guard < 3; guard++) {
      r = await rawCommand(wire, authDb, { saslContinue: 1, conversationId: id, payload: payload('') }, false, DEFAULT_COMMAND_MS, uri);
    }
    if (r.plain.done !== true) throw new MongoAuthError('The server did not finish authentication.');
  } catch (e) {
    if (e instanceof MongoAuthError) throw e;
    if (e instanceof ScramError) throw new MongoAuthError(e.message);
    if (e instanceof MongoServerError && (e.code === 18 || e.code === 11 || e.codeName === 'AuthenticationFailed' || e.codeName === 'UserNotFound')) {
      throw new MongoAuthError(`Authentication failed. Check the user name, the password and the authentication database ("${authDb}"; change it with ?authSource=...).`);
    }
    if (e instanceof MongoServerError) throw new MongoAuthError(`Authentication failed: ${e.message}`);
    throw e;
  }
}

