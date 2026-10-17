import { chmodSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deleteSetting, getSetting, setSetting, type Db } from '../db/index.ts';
import { hashToken, newToken, safeEqualHex } from './tokens.ts';

/**
 * First-run setup protection (FR-01, FR-02, BR-02).
 *
 * Until an administrator exists, anyone who can reach the panel could try to
 * claim it. To prevent that, setup requires a one-time token that only someone
 * with shell access to the server can read: it is written to
 * <dataDir>/setup-token (mode 0600) and printed by the installer and by
 * `openvps setup-token`. Only the token's hash is kept in the database.
 */
const KEY = 'setup_token_hash';
export const SETUP_TOKEN_FILE = 'setup-token';

export function setupTokenPath(dataDir: string): string {
  return join(dataDir, SETUP_TOKEN_FILE);
}

/** Create (or replace) the setup token and write it to disk. Returns the plaintext token. */
export function issueSetupToken(db: Db, dataDir: string): string {
  const token = newToken(18);
  setSetting(db, KEY, hashToken(token));
  const file = setupTokenPath(dataDir);
  writeFileSync(file, token + '\n', { mode: 0o600 });
  chmodSync(file, 0o600);
  return token;
}

export function hasSetupToken(db: Db): boolean {
  return getSetting(db, KEY) !== undefined;
}

export function checkSetupToken(db: Db, token: unknown): boolean {
  const stored = getSetting(db, KEY);
  if (!stored || typeof token !== 'string' || token.length < 10 || token.length > 100) return false;
  return safeEqualHex(hashToken(token.trim()), stored);
}

export function consumeSetupToken(db: Db, dataDir: string): void {
  deleteSetting(db, KEY);
  const file = setupTokenPath(dataDir);
  if (existsSync(file)) rmSync(file, { force: true });
}
