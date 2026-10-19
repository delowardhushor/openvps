import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { Client, GOOD_PASSWORD, startTestServer, type TestServer } from './helpers.ts';
import { startAgentFixture, type AgentFixture } from './agent-fixture.ts';
import { attachment } from '../src/routes/files.ts';

const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('file manager API', () => {
  let fx: AgentFixture;
  let srv: TestServer;
  let c: Client;
  let root: string;

  before(async () => {
    fx = await startAgentFixture();
    root = fx.appsRoot;
    srv = await startTestServer({ agent: { socket: fx.socket }, files: { roots: [root], maxUploadMb: 20, maxEditKb: 64 } });
    c = new Client(srv.url);
    assert.equal((await c.post('/api/setup', { setupToken: srv.setupToken, username: 'admin', password: GOOD_PASSWORD })).status, 200);
  });
  after(async () => {
    await srv.close();
    await fx.close();
  });

  const q = (path: string, extra = '') => `root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}${extra}`;
  const upload = (path: string, body: Buffer | string, extra = '') =>
    fetch(`${srv.url}/api/files/upload?${q(path, extra)}`, {
      method: 'POST',
      headers: { cookie: c.cookie, 'x-openvps-request': '1', 'content-type': 'application/octet-stream' },
      body: typeof body === 'string' ? Buffer.from(body) : body,
    });

  test('requires a session and the CSRF header', async () => {
    const anon = new Client(srv.url);
    for (const p of ['/api/files/roots', `/api/files/list?${q('')}`, `/api/files/download?${q('x')}`, `/api/files/text?${q('x')}`]) {
      assert.equal((await anon.get(p)).status, 401, p);
    }
    const noHeader = await fetch(`${srv.url}/api/files/upload?${q('x')}`, { method: 'POST', headers: { cookie: c.cookie }, body: 'x' });
    assert.equal(noHeader.status, 403);
    assert.equal((await anon.post('/api/files/delete', { root, path: 'x' })).status, 401);
  });

  test('lists the configured roots and limits', async () => {
    const r = await c.get('/api/files/roots');
    assert.deepEqual(r.json.roots, [{ path: root }]);
    assert.equal(r.json.maxUploadBytes, 20 * 1024 * 1024);
    assert.equal(r.json.maxEditBytes, 64 * 1024);
  });

  test('rejects unknown roots and unsafe paths', async () => {
    assert.equal((await c.get(`/api/files/list?root=${encodeURIComponent('/etc')}&path=`)).status, 404);
    for (const bad of ['../x', 'a/../../b', 'a//b', 'a\u0000b']) {
      const r = await c.get(`/api/files/list?${q(bad)}`);
      assert.equal(r.status, 400, bad);
      assert.equal(r.json.error.code, 'invalid_field');
    }
    assert.equal((await c.post('/api/files/delete', { root: '/etc', path: 'passwd' })).status, 404);
    assert.equal((await c.post('/api/files/delete', { root, path: '' })).status, 400, 'the root itself cannot be deleted');
  });

  test('the agent has its own allowlist of roots', async () => {
    await assert.rejects(fx.client.call({ action: 'files.list', params: { root: '/etc', path: '' } }), /not managed/);
  });

  test('lists a folder', async () => {
    const r = await c.get(`/api/files/list?${q('')}`);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.entries.some((e: any) => e.name === 'hello' && e.type === 'dir'));
    assert.ok(r.json.disk.availableBytes > 0);
    assert.equal((await c.get(`/api/files/list?${q('nope')}`)).status, 404);
  });

  test('creates folders, moves and deletes, with an audit trail', async () => {
    assert.equal((await c.post('/api/files/mkdir', { root, path: 'tools/bin' })).status, 404, 'parents must exist for mkdir');
    assert.equal((await c.post('/api/files/mkdir', { root, path: 'tools' })).status, 200);
    assert.equal((await c.post('/api/files/mkdir', { root, path: 'tools' })).status, 409);
    writeFileSync(join(root, 'tools', 'a.txt'), 'A');
    assert.equal((await c.post('/api/files/move', { root, from: 'tools/a.txt', to: 'tools/b.txt' })).status, 200);
    assert.equal(readFileSync(join(root, 'tools', 'b.txt'), 'utf8'), 'A');
    assert.equal((await c.post('/api/files/move', { root, from: 'tools/b.txt', to: 'hello' })).status, 409);
    assert.equal((await c.post('/api/files/delete', { root, path: 'tools' })).status, 200);
    assert.equal(existsSync(join(root, 'tools')), false);
    const audit = await c.get('/api/audit?action=file.');
    const actions = audit.json.entries.map((e: any) => `${e.action}:${e.outcome}`);
    for (const a of ['file.mkdir:success', 'file.mkdir:failure', 'file.move:success', 'file.delete:success']) assert.ok(actions.includes(a), a);
  });

  test('uploads a file, creating missing folders', async () => {
    const r = await upload('site/css/app.css', 'body{}');
    assert.equal(r.status, 200, await r.clone().text());
    const j = (await r.json()) as { size: number; replaced: boolean };
    assert.deepEqual([j.size, j.replaced], [6, false]);
    assert.equal(readFileSync(join(root, 'site', 'css', 'app.css'), 'utf8'), 'body{}');
  });

  test('does not replace a file unless told to', async () => {
    assert.equal((await upload('keep.txt', 'one')).status, 200);
    const again = await upload('keep.txt', 'two');
    assert.equal(again.status, 409);
    assert.equal(((await again.json()) as any).error.code, 'exists');
    assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'one');
    assert.equal((await upload('keep.txt', 'two', '&overwrite=1')).status, 200);
    assert.equal(readFileSync(join(root, 'keep.txt'), 'utf8'), 'two');
  });

  test('streams a large binary file intact in both directions', async () => {
    const big = randomBytes(12 * 1024 * 1024 + 123);
    const up = await upload('big/blob.bin', big);
    assert.equal(up.status, 200, await up.clone().text());
    assert.equal(sha(readFileSync(join(root, 'big', 'blob.bin'))), sha(big));
    const dl = await fetch(`${srv.url}/api/files/download?${q('big/blob.bin')}`, { headers: { cookie: c.cookie } });
    assert.equal(dl.status, 200);
    assert.equal(dl.headers.get('content-type'), 'application/octet-stream');
    assert.equal(dl.headers.get('content-length'), String(big.length));
    assert.match(dl.headers.get('content-disposition') ?? '', /^attachment; filename="blob\.bin"/);
    assert.equal(sha(Buffer.from(await dl.arrayBuffer())), sha(big));
  });

  test('refuses an upload above the limit before reading it', async () => {
    const r = await upload('too-big.bin', Buffer.alloc(21 * 1024 * 1024));
    assert.equal(r.status, 413);
    assert.equal(existsSync(join(root, 'too-big.bin')), false);
  });

  test('requires the size of an upload', async () => {
    const r = await new Promise<number>((resolve, reject) => {
      const req = request(`${srv.url}/api/files/upload?${q('chunked.txt')}`, { method: 'POST', headers: { cookie: c.cookie, 'x-openvps-request': '1', 'transfer-encoding': 'chunked' } }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on('error', reject);
      req.write('abc');
      req.end();
    });
    assert.equal(r, 411);
  });

  test('a cancelled upload leaves no partial file behind', async () => {
    await new Promise<void>((resolve) => {
      const req = request(`${srv.url}/api/files/upload?${q('cancelled.bin')}`, {
        method: 'POST',
        headers: { cookie: c.cookie, 'x-openvps-request': '1', 'content-length': String(5 * 1024 * 1024) },
      });
      req.on('error', () => undefined);
      req.write(Buffer.alloc(256 * 1024));
      setTimeout(() => {
        req.destroy();
        resolve();
      }, 150);
    });
    await sleep(500);
    assert.equal(existsSync(join(root, 'cancelled.bin')), false);
    assert.deepEqual(readdirSync(root).filter((n) => n.startsWith('.openvps-upload-')), []);
  });

  test('a cancelled download frees the agent', async () => {
    writeFileSync(join(root, 'long.bin'), randomBytes(16 * 1024 * 1024));
    await new Promise<void>((resolve, reject) => {
      const req = request(`${srv.url}/api/files/download?${q('long.bin')}`, { headers: { cookie: c.cookie } }, (res) => {
        res.once('data', () => {
          req.destroy();
          resolve();
        });
      });
      req.on('error', () => undefined);
      req.end();
      setTimeout(() => reject(new Error('no data')), 5000).unref();
    });
    await sleep(300);
    // the agent still serves requests and no helper is left holding a slot
    for (let i = 0; i < 4; i++) assert.equal((await c.get(`/api/files/list?${q('')}`)).status, 200);
  });

  test('downloads: missing files and folders are errors, not partial answers', async () => {
    assert.equal((await fetch(`${srv.url}/api/files/download?${q('gone.txt')}`, { headers: { cookie: c.cookie } })).status, 404);
    const dir = await fetch(`${srv.url}/api/files/download?${q('hello')}`, { headers: { cookie: c.cookie } });
    assert.equal(dir.status, 400);
  });

  test('a link that leaves the root is not followed', async () => {
    writeFileSync(join(fx.dir, 'outside-secret.txt'), 'top secret');
    mkdirSync(join(fx.dir, 'outside-dir'));
    symlinkSync(join(fx.dir, 'outside-dir'), join(root, 'out'));
    symlinkSync(join(fx.dir, 'outside-secret.txt'), join(root, 'peek'));
    assert.equal((await c.get(`/api/files/list?${q('out')}`)).status, 403);
    assert.equal((await fetch(`${srv.url}/api/files/download?${q('peek')}`, { headers: { cookie: c.cookie } })).status, 403);
    assert.equal((await upload('out/new.txt', 'x')).status, 403);
    assert.equal((await c.get(`/api/files/text?${q('peek')}`)).status, 403);
    assert.deepEqual(readdirSync(join(fx.dir, 'outside-dir')), []);
  });

  test('edits text files, with a conflict check', async () => {
    writeFileSync(join(root, 'notes.txt'), 'héllo\nline 2\n');
    const r = await c.get(`/api/files/text?${q('notes.txt')}`);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.content, 'héllo\nline 2\n');
    const saved = await c.req('PUT', '/api/files/text', { root, path: 'notes.txt', content: 'new text ✓\n', mtimeMs: r.json.mtimeMs });
    assert.equal(saved.status, 200, saved.text);
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'new text ✓\n');
    // saving again with the old modification time is a conflict
    const stale = await c.req('PUT', '/api/files/text', { root, path: 'notes.txt', content: 'lost?', mtimeMs: r.json.mtimeMs - 5000 });
    assert.equal(stale.status, 409);
    assert.equal(stale.json.error.code, 'changed');
    assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'new text ✓\n');
  });

  test('creates a new text file only if it does not exist yet', async () => {
    assert.equal((await c.req('PUT', '/api/files/text', { root, path: 'fresh.env', content: 'A=1\n', create: true })).status, 200);
    assert.equal((await c.req('PUT', '/api/files/text', { root, path: 'fresh.env', content: 'A=2\n', create: true })).status, 409);
    assert.equal(readFileSync(join(root, 'fresh.env'), 'utf8'), 'A=1\n');
  });

  test('does not open binary or oversized files in the editor', async () => {
    writeFileSync(join(root, 'bin.dat'), Buffer.from([1, 2, 0, 3]));
    writeFileSync(join(root, 'latin1.txt'), Buffer.from([0x68, 0xe9, 0x6c]));
    writeFileSync(join(root, 'huge.txt'), 'x'.repeat(70 * 1024));
    assert.equal((await c.get(`/api/files/text?${q('bin.dat')}`)).json.error.code, 'not_text');
    assert.equal((await c.get(`/api/files/text?${q('latin1.txt')}`)).json.error.code, 'not_text');
    const big = await c.get(`/api/files/text?${q('huge.txt')}`);
    assert.equal(big.status, 413);
    const save = await c.req('PUT', '/api/files/text', { root, path: 'huge.txt', content: 'x'.repeat(70 * 1024) });
    assert.equal(save.status, 413);
  });

  test('download headers are safe for odd names', () => {
    assert.equal(attachment('plain.txt'), `attachment; filename="plain.txt"; filename*=UTF-8''plain.txt`);
    const odd = attachment('a"b;é\\c.txt');
    assert.ok(!/[^\x20-\x7e]/.test(odd), 'header is ASCII only');
    assert.match(odd, /filename="a_b__[_]*c\.txt"/);
    assert.match(odd, /filename\*=UTF-8''a%22b%3B%C3%A9%5Cc\.txt$/);
  });
});
