import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

/**
 * Password hashing with scrypt (memory-hard, built into Node.js, no native
 * addon to compile on the target server).
 *
 * Encoded format: scrypt$<log2N>$<r>$<p>$<salt b64>$<hash b64>
 * Parameters are stored per hash so they can be raised later without
 * invalidating existing passwords (see needsRehash).
 */
export interface ScryptParams {
  log2N: number;
  r: number;
  p: number;
  keyLen: number;
  saltLen: number;
}

export const PARAMS: Readonly<ScryptParams> = { log2N: 15, r: 8, p: 1, keyLen: 64, saltLen: 16 };

function scrypt(password: string, salt: Buffer, keyLen: number, opts: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFKC'), salt, keyLen, opts, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

function opts(log2N: number, r: number, p: number): ScryptOptions {
  const N = 2 ** log2N;
  return { N, r, p, maxmem: 256 * N * r + 1024 * 1024 };
}

export async function hashPassword(password: string, params: Readonly<ScryptParams> = PARAMS): Promise<string> {
  const salt = randomBytes(params.saltLen);
  const key = await scrypt(password, salt, params.keyLen, opts(params.log2N, params.r, params.p));
  return ['scrypt', params.log2N, params.r, params.p, salt.toString('base64'), key.toString('base64')].join('$');
}

interface Parsed {
  log2N: number;
  r: number;
  p: number;
  salt: Buffer;
  key: Buffer;
}

function parse(encoded: string): Parsed | null {
  const parts = encoded.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return null;
  const [log2N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![log2N, r, p].every((n) => Number.isInteger(n) && n > 0) || log2N > 22 || r > 32 || p > 16) return null;
  const salt = Buffer.from(parts[4]!, 'base64');
  const key = Buffer.from(parts[5]!, 'base64');
  if (salt.length < 8 || key.length < 32) return null;
  return { log2N, r, p, salt, key };
}

export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parse(encoded);
  if (!parsed) return false;
  const key = await scrypt(password, parsed.salt, parsed.key.length, opts(parsed.log2N, parsed.r, parsed.p));
  return key.length === parsed.key.length && timingSafeEqual(key, parsed.key);
}

export function needsRehash(encoded: string, params: Readonly<ScryptParams> = PARAMS): boolean {
  const p = parse(encoded);
  return !p || p.log2N < params.log2N || p.r < params.r || p.p < params.p;
}

/**
 * A real hash of a random password, verified against when a username does not
 * exist so that response time does not reveal which usernames are valid.
 */
let dummy: Promise<string> | null = null;
export function dummyHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString('hex'));
  return dummy;
}

export interface PasswordPolicyResult {
  ok: boolean;
  problems: string[];
}

const COMMON = new Set([
  'password1234', 'password12345', 'password123456', '123456789012', 'qwertyuiop12', 'administrator',
  'letmein12345', 'changeme1234', 'welcome12345', 'openvps12345', 'adminadmin12', 'iloveyou1234',
]);

export function checkPasswordPolicy(password: string, username: string, minLength: number): PasswordPolicyResult {
  const problems: string[] = [];
  if (typeof password !== 'string') return { ok: false, problems: ['Password is required.'] };
  if ([...password].length < minLength) problems.push(`Use at least ${minLength} characters.`);
  if (password.length > 256) problems.push('Use at most 256 characters.');
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    problems.push('Password must not contain the username.');
  }
  if (COMMON.has(password.toLowerCase())) problems.push('This password is too common.');
  if (/^(.)\1+$/.test(password)) problems.push('Password must not be a single repeated character.');
  return { ok: problems.length === 0, problems };
}
