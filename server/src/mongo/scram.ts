import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';

/**
 * SCRAM-SHA-256 / SCRAM-SHA-1 as MongoDB uses them (RFC 5802 / RFC 7677). Pure functions plus a
 * small state machine, so they can be tested against published vectors.
 */

export type ScramMechanism = 'SCRAM-SHA-256' | 'SCRAM-SHA-1';

export class ScramError extends Error {}

const hashName = (m: ScramMechanism) => (m === 'SCRAM-SHA-256' ? 'sha256' : 'sha1');
const hmac = (alg: string, key: Buffer, data: string) => createHmac(alg, key).update(data).digest();
const hash = (alg: string, data: Buffer) => createHash(alg).update(data).digest();
const escapeUser = (u: string) => u.replace(/=/g, '=3D').replace(/,/g, '=2C');

function xor(a: Buffer, b: Buffer): Buffer {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i]! ^ b[i]!;
  return out;
}

/** The password as SCRAM sees it: MD5 digest for SHA-1 (MongoDB's legacy scheme), otherwise as typed. */
export function scramPassword(mechanism: ScramMechanism, username: string, password: string): string {
  if (mechanism === 'SCRAM-SHA-1') return createHash('md5').update(`${username}:mongo:${password}`).digest('hex');
  return password;
}

export class ScramClient {
  private readonly alg: string;
  private readonly keyLen: number;
  private readonly user: string;
  private readonly password: string;
  private readonly nonce: string;
  private readonly firstBare: string;
  private authMessage = '';
  private serverKeySig = '';
  readonly mechanism: ScramMechanism;

  constructor(mechanism: ScramMechanism, username: string, password: string, nonce: string = randomBytes(24).toString('base64')) {
    this.mechanism = mechanism;
    this.alg = hashName(mechanism);
    this.keyLen = mechanism === 'SCRAM-SHA-256' ? 32 : 20;
    this.user = username;
    this.password = scramPassword(mechanism, username, password);
    this.nonce = nonce;
    this.firstBare = `n=${escapeUser(username)},r=${nonce}`;
  }

  first(): string {
    return `n,,${this.firstBare}`;
  }

  /** Answer the server's first message with the client proof. */
  final(serverFirst: string): string {
    const attrs = parseAttrs(serverFirst);
    const r = attrs.r;
    const s = attrs.s;
    const i = Number(attrs.i);
    if (!r || !s || !Number.isInteger(i) || i < 1) throw new ScramError('The server sent an invalid authentication message.');
    if (!r.startsWith(this.nonce)) throw new ScramError('The server did not echo the client nonce; refusing to continue.');
    if (i < 4096 && this.mechanism === 'SCRAM-SHA-256') throw new ScramError('The server asked for too few password iterations.');
    const salt = Buffer.from(s, 'base64');
    const salted = pbkdf2Sync(this.password, salt, i, this.keyLen, this.alg);
    const clientKey = hmac(this.alg, salted, 'Client Key');
    const storedKey = hash(this.alg, clientKey);
    const withoutProof = `c=biws,r=${r}`;
    this.authMessage = `${this.firstBare},${serverFirst},${withoutProof}`;
    const signature = createHmac(this.alg, storedKey).update(this.authMessage).digest();
    const proof = xor(clientKey, signature);
    this.serverKeySig = createHmac(this.alg, hmac(this.alg, salted, 'Server Key')).update(this.authMessage).digest('base64');
    return `${withoutProof},p=${proof.toString('base64')}`;
  }

  /** Check the server's proof that it knows the password too. */
  verify(serverFinal: string): void {
    const attrs = parseAttrs(serverFinal);
    if (attrs.e) throw new ScramError(`Authentication failed: ${attrs.e}`);
    if (attrs.v !== this.serverKeySig) throw new ScramError('The server could not prove it knows the password; refusing to continue.');
  }

  get username(): string {
    return this.user;
  }
}

function parseAttrs(msg: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of msg.split(',')) {
    const eq = part.indexOf('=');
    if (eq === 1) out[part[0]!] = part.slice(2);
  }
  return out;
}
