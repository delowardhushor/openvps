import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Encryption at rest for application secrets (environment variables).
 * AES-256-GCM with a random 96-bit IV per value; the 256-bit key lives in
 * <dataDir>/secret.key (mode 0600), separate from the database, so a copied
 * database alone does not reveal secrets. Back up both files together.
 */
const VERSION = 'v1';
export const KEY_FILE = 'secret.key';

export class SecretBox {
  private readonly key: Buffer;
  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('Secret key must be 32 bytes');
    this.key = key;
  }

  static fromDataDir(dataDir: string): SecretBox {
    const file = join(dataDir, KEY_FILE);
    if (!existsSync(file)) {
      writeFileSync(file, randomBytes(32).toString('base64') + '\n', { mode: 0o600, flag: 'wx' });
    }
    chmodSync(file, 0o600);
    const key = Buffer.from(readFileSync(file, 'utf8').trim(), 'base64');
    return new SecretBox(key);
  }

  seal(plaintext: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([c.update(plaintext, 'utf8'), c.final()]);
    return [VERSION, iv.toString('base64'), c.getAuthTag().toString('base64'), ct.toString('base64')].join(':');
  }

  open(sealed: string): string {
    const [v, iv, tag, ct] = sealed.split(':');
    if (v !== VERSION || !iv || !tag || ct === undefined) throw new Error('Unsupported secret format');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
  }

  sealJson(value: unknown): string {
    return this.seal(JSON.stringify(value));
  }

  openJson<T>(sealed: string): T {
    return JSON.parse(this.open(sealed)) as T;
  }
}
