#!/usr/bin/env node
// Stand-in for certbot in unit tests (the real certbot runs in scripts/ci/sites-e2e.sh).
// Supports: --version, certonly (writes a self-signed lineage), delete --cert-name X.
// Domains containing "fail" are rejected like a failed HTTP-01 validation.
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const le = process.env.FAKE_LE_DIR;
const val = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
};
appendFileSync(join(le, 'calls.log'), args.join(' ') + '\n');
if (args[0] === '--version') {
  console.log('certbot 9.9.9-fake');
  process.exit(0);
}
if (args[0] === 'delete') {
  const name = val('--cert-name');
  rmSync(join(le, 'live', name), { recursive: true, force: true });
  rmSync(join(le, 'renewal', `${name}.conf`), { force: true });
  process.exit(0);
}
if (args[0] === 'certonly') {
  const name = val('--cert-name');
  const domains = args.flatMap((a, i) => (a === '-d' ? [args[i + 1]] : []));
  if (domains.some((d) => d.includes('fail'))) {
    console.error(`Certbot failed to authenticate some domains.\n  Domain: ${domains[0]}\n  Type:   connection\n  Detail: 203.0.113.9: Fetching http://${domains[0]}/.well-known/acme-challenge/x: Timeout during connect (likely firewall problem)`);
    process.exit(1);
  }
  const dir = join(le, 'live', name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(le, 'renewal'), { recursive: true });
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '90',
    '-subj', `/CN=${domains[0]}`, '-addext', `subjectAltName=${domains.map((d) => `DNS:${d}`).join(',')}`,
    '-keyout', join(dir, 'privkey.pem'), '-out', join(dir, 'fullchain.pem'),
  ], { stdio: 'ignore' });
  writeFileSync(join(le, 'renewal', `${name}.conf`), `# renewal for ${name}\n`);
  console.log(`Successfully received certificate for ${domains.join(', ')}`);
  process.exit(0);
}
console.error('unsupported');
process.exit(2);
