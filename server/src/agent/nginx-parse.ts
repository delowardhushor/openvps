/**
 * A small, tolerant reader for Nginx configuration files. It extracts what OpenVPS
 * needs from existing (hand-written) sites: server_name, listen, ssl_certificate,
 * proxy_pass and root of each `server { }` block. It never modifies anything.
 */
import type { ExistingServer } from './sites-spec.ts';

type Token = { t: 'word'; v: string } | { t: '{' } | { t: '}' } | { t: ';' };

export function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
    } else if (c === '{' || c === '}' || c === ';') {
      out.push({ t: c });
      i++;
    } else if (/\s/.test(c)) {
      i++;
    } else if (c === '"' || c === "'") {
      let v = '';
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === '\\' && i + 1 < src.length) i++;
        v += src[i];
        i++;
      }
      i++;
      out.push({ t: 'word', v });
    } else {
      let v = '';
      while (i < src.length && !/[\s{};#]/.test(src[i]!)) {
        // ${var} inside words should not be split at the brace.
        if (src[i] === '$' && src[i + 1] === '{') {
          const end = src.indexOf('}', i);
          if (end > 0) {
            v += src.slice(i, end + 1);
            i = end + 1;
            continue;
          }
        }
        v += src[i];
        i++;
      }
      out.push({ t: 'word', v });
    }
  }
  return out;
}

export interface Directive {
  name: string;
  args: string[];
  block: Directive[] | null;
}

/** Build a directive tree; unbalanced input is handled best-effort (never throws). */
export function parseConfig(src: string): Directive[] {
  const tokens = tokenize(src);
  let pos = 0;
  const parseBlock = (): Directive[] => {
    const list: Directive[] = [];
    while (pos < tokens.length) {
      const tok = tokens[pos]!;
      if (tok.t === '}') {
        pos++;
        return list;
      }
      if (tok.t !== 'word') {
        pos++;
        continue;
      }
      const name = tok.v;
      const args: string[] = [];
      pos++;
      while (pos < tokens.length && tokens[pos]!.t === 'word') {
        args.push((tokens[pos] as { v: string }).v);
        pos++;
      }
      const end = tokens[pos];
      if (end?.t === '{') {
        pos++;
        list.push({ name, args, block: parseBlock() });
      } else {
        if (end?.t === ';') pos++;
        list.push({ name, args, block: null });
      }
    }
    return list;
  };
  return parseBlock();
}

function findServers(dirs: Directive[]): Directive[] {
  const out: Directive[] = [];
  for (const d of dirs) {
    if (d.name === 'server' && d.block) out.push(d);
    else if (d.block && (d.name === 'http' || d.name === 'stream' || d.name === 'if')) out.push(...findServers(d.block));
  }
  return out;
}

function collect(block: Directive[], name: string, deep = false): Directive[] {
  const out: Directive[] = [];
  for (const d of block) {
    if (d.name === name) out.push(d);
    if (deep && d.block) out.push(...collect(d.block, name, true));
  }
  return out;
}

export function extractServers(src: string, file: string): ExistingServer[] {
  return findServers(parseConfig(src)).map((s) => {
    const b = s.block!;
    const listens = collect(b, 'listen').map((d) => d.args.join(' '));
    const cert = collect(b, 'ssl_certificate')[0]?.args[0] ?? null;
    const roots = collect(b, 'root', true);
    return {
      file,
      serverNames: collect(b, 'server_name').flatMap((d) => d.args.map((a) => a.toLowerCase())),
      listens,
      ssl: listens.some((l) => /\bssl\b/.test(l)) || collect(b, 'ssl').some((d) => d.args[0] === 'on'),
      certificate: cert,
      proxyPass: collect(b, 'proxy_pass', true).map((d) => d.args[0] ?? '').filter(Boolean),
      root: roots[0]?.args[0] ?? null,
    };
  });
}

/** Does an Nginx server_name entry match a concrete domain? Handles exact, *.x, x.* and .x forms. */
export function serverNameMatches(pattern: string, domain: string): boolean {
  const p = pattern.toLowerCase();
  if (p === '_' || p === '' || p.startsWith('~')) return false; // catch-all and regex names are ignored
  if (p === domain) return true;
  if (p.startsWith('.')) return domain === p.slice(1) || domain.endsWith(p);
  if (p.startsWith('*.')) return domain.endsWith(p.slice(1)) && domain.split('.').length >= p.split('.').length;
  if (p.endsWith('.*')) return domain.startsWith(p.slice(0, -1));
  return false;
}

/** Does the main nginx.conf include sites-enabled and/or conf.d? */
export function detectLayout(nginxConf: string): 'sites' | 'confd' | null {
  const includes = collect(parseConfig(nginxConf), 'include', true).map((d) => d.args[0] ?? '');
  if (includes.some((i) => i.includes('sites-enabled'))) return 'sites';
  if (includes.some((i) => i.includes('conf.d'))) return 'confd';
  return null;
}
