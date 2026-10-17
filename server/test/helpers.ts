import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig, type Config } from '../src/config.ts';
import { bootstrap } from '../src/bootstrap.ts';
import { createApp } from '../src/app.ts';
import { issueSetupToken } from '../src/auth/setup.ts';
import { silentLogger } from '../src/logger.ts';
import type { AppContext } from '../src/context.ts';
import type { Runner } from '../src/system/exec.ts';

export const fakeRunner: Runner = async (_p, args) => {
  const units = args.slice(args.indexOf('--') + 1);
  const blocks = units.map((u) =>
    u === 'nginx.service'
      ? 'Id=nginx.service\nLoadState=loaded\nActiveState=active\nUnitFileState=enabled'
      : u === 'ufw.service'
        ? 'Id=ufw.service\nLoadState=not-found\nActiveState=inactive\nUnitFileState='
        : `Id=${u}\nLoadState=loaded\nActiveState=failed\nUnitFileState=disabled`,
  );
  return { code: 0, stdout: blocks.join('\n\n') + '\n', stderr: '', timedOut: false };
};

export interface TestServer {
  url: string;
  app: AppContext;
  config: Config;
  setupToken: string;
  close(): Promise<void>;
}

export async function startTestServer(overrides: Record<string, unknown> = {}): Promise<TestServer> {
  const dataDir = mkdtempSync(join(tmpdir(), 'openvps-test-'));
  const webRoot = join(dataDir, 'web');
  mkdirSync(join(webRoot, 'assets'), { recursive: true });
  writeFileSync(join(webRoot, 'index.html'), '<!doctype html><title>OpenVPS</title>');
  writeFileSync(join(webRoot, 'assets', 'app-abc123.js'), 'console.log(1)');
  writeFileSync(join(dataDir, 'secret.txt'), 'top secret');

  const config = loadConfig(
    { OPENVPS_DEV: '1' },
    {
      dataDir,
      webRoot,
      tls: { enabled: false },
      metrics: { intervalSeconds: 1, historyMinutes: 1 },
      ...overrides,
    },
  );
  const app = await bootstrap(config, { log: silentLogger, run: fakeRunner });
  const setupToken = issueSetupToken(app.db, dataDir);
  await app.metrics.sample();
  const handler = createApp(app);
  const server: Server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    app,
    config,
    setupToken,
    close: () =>
      new Promise((r) => {
        server.closeAllConnections();
        server.close(() => {
          app.db.close();
          r();
        });
      }),
  };
}

/** Minimal cookie-jar client that behaves like the SPA. */
export class Client {
  cookie = '';
  readonly base: string;
  constructor(base: string) {
    this.base = base;
  }

  async req(method: string, path: string, body?: unknown, extraHeaders: Record<string, string> = {}) {
    const headers: Record<string, string> = { ...extraHeaders };
    if (this.cookie) headers.cookie = this.cookie;
    if (method !== 'GET' && !('x-openvps-request' in extraHeaders)) headers['x-openvps-request'] = '1';
    if (body !== undefined) headers['content-type'] ??= 'application/json';
    const res = await fetch(this.base + path, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie();
    for (const c of set) {
      const [pair] = c.split(';');
      if (/Max-Age=0/.test(c)) this.cookie = '';
      else this.cookie = pair!;
    }
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json */
    }
    return { status: res.status, json, text, headers: res.headers, setCookie: set };
  }

  get(path: string) {
    return this.req('GET', path);
  }
  post(path: string, body?: unknown, h?: Record<string, string>) {
    return this.req('POST', path, body ?? {}, h);
  }
}

export const GOOD_PASSWORD = 'correct horse battery staple';
