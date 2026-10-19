import { resolveSrv, resolveTxt } from 'node:dns/promises';

/** A parsed MongoDB connection string (https://www.mongodb.com/docs/manual/reference/connection-string/). */
export interface ParsedUri {
  srv: boolean;
  hosts: { host: string; port: number }[];
  username: string | null;
  password: string | null;
  database: string | null;
  /** Option names are lower-cased. */
  options: Record<string, string>;
}

export class UriError extends Error {}

function dec(s: string, what: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    throw new UriError(`The ${what} in the connection string has a bad %-escape. Percent-encode special characters (@ becomes %40, : becomes %3A).`);
  }
}

function parseHost(h: string, srv: boolean): { host: string; port: number } {
  let host = h;
  let port = 27017;
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    if (end < 0) throw new UriError('Invalid IPv6 address in the connection string.');
    host = h.slice(1, end);
    const rest = h.slice(end + 1);
    if (rest) {
      if (!/^:\d+$/.test(rest)) throw new UriError('Invalid port in the connection string.');
      port = Number(rest.slice(1));
    }
  } else if (h.includes(':')) {
    const [a, b, ...more] = h.split(':');
    if (more.length || !/^\d+$/.test(b ?? '')) throw new UriError('Invalid host or port in the connection string.');
    host = a!;
    port = Number(b);
  }
  if (!host || !/^[A-Za-z0-9._:-]+$/.test(host)) throw new UriError('Invalid host name in the connection string.');
  if (srv && h.includes(':')) throw new UriError('A mongodb+srv:// connection string cannot have a port.');
  if (port < 1 || port > 65535) throw new UriError('Invalid port in the connection string.');
  return { host: host.toLowerCase(), port };
}

export function parseConnectionString(uri: string): ParsedUri {
  const m = /^mongodb(\+srv)?:\/\/(.*)$/s.exec(uri.trim());
  if (!m) throw new UriError('The connection string must start with mongodb:// or mongodb+srv://.');
  const srv = m[1] === '+srv';
  let rest = m[2]!;
  const q = rest.indexOf('?');
  const queryText = q >= 0 ? rest.slice(q + 1) : '';
  if (q >= 0) rest = rest.slice(0, q);
  const slash = rest.indexOf('/');
  const authority = slash >= 0 ? rest.slice(0, slash) : rest;
  const dbText = slash >= 0 ? rest.slice(slash + 1) : '';

  let username: string | null = null;
  let password: string | null = null;
  let hostText = authority;
  const at = authority.lastIndexOf('@');
  if (at >= 0) {
    const info = authority.slice(0, at);
    hostText = authority.slice(at + 1);
    const colon = info.indexOf(':');
    username = dec(colon >= 0 ? info.slice(0, colon) : info, 'user name');
    password = colon >= 0 ? dec(info.slice(colon + 1), 'password') : null;
  }
  const hosts = hostText.split(',').filter(Boolean).map((h) => parseHost(h, srv));
  if (!hosts.length) throw new UriError('The connection string has no host.');
  if (srv && hosts.length !== 1) throw new UriError('A mongodb+srv:// connection string takes exactly one host name.');

  const options: Record<string, string> = {};
  for (const pair of queryText.split('&').filter(Boolean)) {
    const eq = pair.indexOf('=');
    const k = dec(eq >= 0 ? pair.slice(0, eq) : pair, 'option name').toLowerCase();
    options[k] = eq >= 0 ? dec(pair.slice(eq + 1), 'option value') : '';
  }
  return { srv, hosts, username, password, database: dbText ? dec(dbText, 'database name') : null, options };
}

const SRV_LOOKUP_MS = 8000;

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  let t: NodeJS.Timeout;
  return Promise.race([
    p.finally(() => clearTimeout(t)),
    new Promise<T>((_, rej) => {
      t = setTimeout(() => rej(new UriError(`Looking up ${what} timed out.`)), SRV_LOOKUP_MS);
    }),
  ]);
}

/** For mongodb+srv:// strings: look up the member hosts (SRV) and default options (TXT). */
export async function resolveSrvUri(p: ParsedUri): Promise<ParsedUri> {
  if (!p.srv) return p;
  const name = p.hosts[0]!.host;
  let records;
  try {
    records = await withTimeout(resolveSrv(`_mongodb._tcp.${name}`), `${name}`);
  } catch (e) {
    if (e instanceof UriError) throw e;
    throw new UriError(`Could not look up the servers for ${name} (${(e as NodeJS.ErrnoException).code ?? 'DNS error'}). Check the address and this server's DNS.`);
  }
  if (!records.length) throw new UriError(`${name} has no MongoDB servers in DNS.`);
  const hosts = records.sort((a, b) => a.priority - b.priority || b.weight - a.weight).map((r) => ({ host: r.name.replace(/\.$/, '').toLowerCase(), port: r.port }));
  const options: Record<string, string> = {};
  try {
    const txt = await withTimeout(resolveTxt(name), name);
    for (const rec of txt) {
      for (const pair of rec.join('').split('&')) {
        const eq = pair.indexOf('=');
        const k = (eq >= 0 ? pair.slice(0, eq) : pair).toLowerCase();
        if (k === 'authsource' || k === 'replicaset' || k === 'loadbalanced') options[k] = eq >= 0 ? pair.slice(eq + 1) : '';
      }
    }
  } catch {
    /* TXT records are optional */
  }
  return { ...p, hosts, options: { tls: 'true', ...options, ...p.options } };
}

/** mongodb://user:pass@host -> mongodb://user:***@host, for messages that might be shown or logged. */
export function scrubSecrets(text: string, uri: string | null): string {
  let out = text.replace(/(mongodb(?:\+srv)?:\/\/[^:@/\s]*):[^@/\s]*@/g, '$1:***@');
  if (uri) {
    try {
      const p = parseConnectionString(uri);
      if (p.password && p.password.length >= 3) out = out.split(p.password).join('***');
    } catch {
      /* not parseable: nothing to scrub */
    }
  }
  return out;
}
