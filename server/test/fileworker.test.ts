import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { runRequest, FileError } from '../src/agent/fileworker.ts';
import { parseFileRequest, parseRelPath, FileSpecError, type FileRequest } from '../src/agent/files-spec.ts';

interface Answer {
  ok: boolean;
  result?: any;
  error?: { code: string; message: string };
  bytes: Buffer;
}

describe('file worker', () => {
  let dir: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'openvps-files-')));
    root = join(dir, 'root');
    outside = join(dir, 'outside');
    mkdirSync(root);
    mkdirSync(outside);
    writeFileSync(join(outside, 'secret.txt'), 'top secret');
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  async function run(action: FileRequest['action'], params: Record<string, unknown>, body: Buffer | string = ''): Promise<Answer> {
    const req = parseFileRequest(action, { root, ...params });
    const out = new PassThrough();
    const chunks: Buffer[] = [];
    out.on('data', (c: Buffer) => chunks.push(c));
    let thrown: FileError | null = null;
    try {
      await runRequest(req, Readable.from([Buffer.from(body)]), out);
    } catch (e) {
      thrown = e as FileError;
    }
    out.end();
    const all = Buffer.concat(chunks);
    if (thrown) return { ok: false, error: { code: thrown.code, message: thrown.message }, bytes: Buffer.alloc(0) };
    const nl = all.indexOf(10);
    const env = JSON.parse(all.subarray(0, nl).toString('utf8')) as { ok: boolean; result?: unknown; error?: { code: string; message: string } };
    return { ...env, bytes: all.subarray(nl + 1) };
  }
  const fail = async (action: FileRequest['action'], params: Record<string, unknown>, body?: Buffer | string) => {
    const a = await run(action, params, body);
    assert.equal(a.ok, false, `expected a failure, got ${JSON.stringify(a.result)}`);
    return a.error!.code;
  };

  describe('paths', () => {
    test('accepts plain relative paths', () => {
      assert.equal(parseRelPath('a/b/c.txt'), 'a/b/c.txt');
      assert.equal(parseRelPath('/a/b/'), 'a/b');
      assert.equal(parseRelPath('', 'path', { allowEmpty: true }), '');
    });
    test('refuses traversal and odd input', () => {
      for (const bad of ['..', 'a/../b', './a', 'a//b', 'a/./b', 'a\0b', 'a\nb', '', '/', 'x'.repeat(300), Array(70).fill('d').join('/')]) {
        assert.throws(() => parseRelPath(bad), FileSpecError, JSON.stringify(bad.slice(0, 20)));
      }
      assert.throws(() => parseRelPath(5 as unknown as string), FileSpecError);
    });
    test('refuses a bad root', () => {
      assert.throws(() => parseFileRequest('files.list', { root: 'relative', path: '' }), FileSpecError);
      assert.throws(() => parseFileRequest('files.list', { root: '/srv/../etc', path: '' }), FileSpecError);
    });
  });

  describe('list', () => {
    test('lists files, folders and links', async () => {
      writeFileSync(join(root, 'a.txt'), 'hello');
      mkdirSync(join(root, 'sub'));
      symlinkSync(join(root, 'sub'), join(root, 'to-sub'));
      symlinkSync(outside, join(root, 'to-outside'));
      symlinkSync(join(root, 'nope'), join(root, 'broken'));
      const a = await run('files.list', { path: '' });
      assert.equal(a.ok, true);
      const by: Record<string, any> = Object.fromEntries((a.result.entries as Array<{ name: string }>).map((e) => [e.name, e]));
      assert.equal(by['a.txt'].type, 'file');
      assert.equal(by['a.txt'].size, 5);
      assert.equal(by['sub'].type, 'dir');
      assert.deepEqual([by['to-sub'].type, by['to-sub'].link], ['link', 'dir']);
      assert.equal(by['to-outside'].link, 'outside');
      assert.equal(by['broken'].link, 'broken');
      assert.ok(a.result.disk.availableBytes > 0);
    });
    test('refuses to enter a link that leaves the root, and files', async () => {
      symlinkSync(outside, join(root, 'out'));
      writeFileSync(join(root, 'f'), 'x');
      assert.equal(await fail('files.list', { path: 'out' }), 'forbidden');
      assert.equal(await fail('files.list', { path: 'f' }), 'not_dir');
      assert.equal(await fail('files.list', { path: 'missing' }), 'not_found');
    });
    test('follows an inside link to a folder', async () => {
      mkdirSync(join(root, 'releases'));
      writeFileSync(join(root, 'releases', 'x'), '1');
      symlinkSync(join(root, 'releases'), join(root, 'current'));
      const a = await run('files.list', { path: 'current' });
      assert.deepEqual((a.result.entries as Array<{ name: string }>).map((e) => e.name), ['x']);
    });
  });

  describe('mkdir, move, delete', () => {
    test('makes a folder once', async () => {
      assert.equal((await run('files.mkdir', { path: 'new' })).ok, true);
      assert.equal(statSync(join(root, 'new')).isDirectory(), true);
      assert.equal(statSync(join(root, 'new')).mode & 0o777, 0o755 & ~process.umask());
      assert.equal(await fail('files.mkdir', { path: 'new' }), 'exists');
      assert.equal(await fail('files.mkdir', { path: 'missing/deeper' }), 'not_found');
    });
    test('moves and renames without replacing', async () => {
      writeFileSync(join(root, 'a'), 'A');
      writeFileSync(join(root, 'b'), 'B');
      mkdirSync(join(root, 'd'));
      assert.equal((await run('files.move', { from: 'a', to: 'd/a2' })).ok, true);
      assert.equal(readFileSync(join(root, 'd', 'a2'), 'utf8'), 'A');
      assert.equal(await fail('files.move', { from: 'b', to: 'd/a2' }), 'exists');
      assert.equal(await fail('files.move', { from: 'nope', to: 'z' }), 'not_found');
      assert.equal(await fail('files.move', { from: 'd', to: 'd/inner' }), 'invalid');
    });
    test('deletes files and whole folders, and never follows links', async () => {
      mkdirSync(join(root, 'tree', 'deep'), { recursive: true });
      writeFileSync(join(root, 'tree', 'deep', 'f'), '1');
      symlinkSync(outside, join(root, 'tree', 'link-out'));
      writeFileSync(join(root, 'single'), '1');
      assert.equal((await run('files.delete', { path: 'single' })).ok, true);
      assert.equal((await run('files.delete', { path: 'tree' })).ok, true);
      assert.equal(existsSync(join(root, 'tree')), false);
      assert.equal(existsSync(join(outside, 'secret.txt')), true, 'the link target must survive');
    });
    test('deleting a link removes the link only', async () => {
      symlinkSync(outside, join(root, 'l'));
      assert.equal((await run('files.delete', { path: 'l' })).ok, true);
      assert.equal(existsSync(outside), true);
      assert.equal(existsSync(join(root, 'l')), false);
    });
    test('cannot reach outside through a folder link', async () => {
      symlinkSync(outside, join(root, 'out'));
      assert.equal(await fail('files.delete', { path: 'out/secret.txt' }), 'forbidden');
      assert.equal(await fail('files.move', { from: 'out/secret.txt', to: 'stolen' }), 'forbidden');
      assert.equal(await fail('files.mkdir', { path: 'out/x' }), 'forbidden');
      assert.equal(existsSync(join(outside, 'secret.txt')), true);
    });
  });

  describe('upload', () => {
    test('writes a new file, creating folders, with normal permissions', async () => {
      const a = await run('files.upload', { path: 'site/css/app.css', size: 5, overwrite: false, ifMtimeMs: null }, 'hello');
      assert.equal(a.ok, true);
      assert.equal(a.result.replaced, false);
      assert.equal(readFileSync(join(root, 'site', 'css', 'app.css'), 'utf8'), 'hello');
      assert.equal(statSync(join(root, 'site', 'css', 'app.css')).mode & 0o777, 0o644);
      assert.deepEqual(readdirSync(join(root, 'site', 'css')), ['app.css'], 'no temporary file left behind');
    });
    test('does not replace unless asked, then keeps the mode', async () => {
      writeFileSync(join(root, 'run.sh'), 'old');
      chmodSync(join(root, 'run.sh'), 0o755);
      assert.equal(await fail('files.upload', { path: 'run.sh', size: 3, overwrite: false, ifMtimeMs: null }, 'new'), 'exists');
      assert.equal(readFileSync(join(root, 'run.sh'), 'utf8'), 'old');
      const a = await run('files.upload', { path: 'run.sh', size: 3, overwrite: true, ifMtimeMs: null }, 'new');
      assert.equal(a.result.replaced, true);
      assert.equal(readFileSync(join(root, 'run.sh'), 'utf8'), 'new');
      assert.equal(statSync(join(root, 'run.sh')).mode & 0o777, 0o755);
    });
    test('detects a file that changed since it was opened', async () => {
      writeFileSync(join(root, 'c.txt'), 'v1');
      const m = Math.round(statSync(join(root, 'c.txt')).mtimeMs);
      assert.equal((await run('files.upload', { path: 'c.txt', size: 2, overwrite: true, ifMtimeMs: m }, 'v2')).ok, true);
      utimesSync(join(root, 'c.txt'), new Date(), new Date(Date.now() + 60_000));
      assert.equal(await fail('files.upload', { path: 'c.txt', size: 2, overwrite: true, ifMtimeMs: m }, 'v3'), 'changed');
      assert.equal(readFileSync(join(root, 'c.txt'), 'utf8'), 'v2');
    });
    test('an interrupted or oversized upload leaves nothing behind', async () => {
      assert.equal(await fail('files.upload', { path: 'short', size: 10, overwrite: false, ifMtimeMs: null }, 'abc'), 'incomplete');
      assert.equal(await fail('files.upload', { path: 'long', size: 2, overwrite: false, ifMtimeMs: null }, 'abcdef'), 'too_large');
      assert.deepEqual(readdirSync(root), []);
    });
    test('refuses folders, links and paths that leave the root', async () => {
      mkdirSync(join(root, 'dir'));
      symlinkSync(outside, join(root, 'out'));
      symlinkSync(join(outside, 'secret.txt'), join(root, 'lnk'));
      assert.equal(await fail('files.upload', { path: 'dir', size: 1, overwrite: true, ifMtimeMs: null }, 'x'), 'is_dir');
      assert.equal(await fail('files.upload', { path: 'out/new.txt', size: 1, overwrite: false, ifMtimeMs: null }, 'x'), 'forbidden');
      assert.equal(await fail('files.upload', { path: 'lnk', size: 1, overwrite: true, ifMtimeMs: null }, 'x'), 'exists');
      assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'top secret');
      assert.deepEqual(readdirSync(outside), ['secret.txt']);
    });
    test('a file in the way of a folder is reported', async () => {
      writeFileSync(join(root, 'f'), '1');
      assert.equal(await fail('files.upload', { path: 'f/inner.txt', size: 1, overwrite: false, ifMtimeMs: null }, 'x'), 'not_dir');
    });
    test('handles empty files and binary data', async () => {
      assert.equal((await run('files.upload', { path: 'empty', size: 0, overwrite: false, ifMtimeMs: null })).ok, true);
      assert.equal(statSync(join(root, 'empty')).size, 0);
      const bin = Buffer.from([0, 255, 1, 254, 10, 13, 0]);
      assert.equal((await run('files.upload', { path: 'b.bin', size: bin.length, overwrite: false, ifMtimeMs: null }, bin)).ok, true);
      assert.deepEqual(readFileSync(join(root, 'b.bin')), bin);
    });
  });

  describe('download', () => {
    test('sends the header line then the exact bytes', async () => {
      const bin = Buffer.from([0, 10, 255, 10, 7]);
      writeFileSync(join(root, 'x.bin'), bin);
      const a = await run('files.download', { path: 'x.bin', maxBytes: null });
      assert.equal(a.ok, true);
      assert.equal(a.result.name, 'x.bin');
      assert.equal(a.result.size, 5);
      assert.deepEqual(a.bytes, bin);
    });
    test('an empty file has a header and no bytes', async () => {
      writeFileSync(join(root, 'e'), '');
      const a = await run('files.download', { path: 'e', maxBytes: null });
      assert.equal(a.result.size, 0);
      assert.equal(a.bytes.length, 0);
    });
    test('respects the size limit and refuses folders and outside links', async () => {
      writeFileSync(join(root, 'big'), 'x'.repeat(100));
      mkdirSync(join(root, 'd'));
      symlinkSync(join(outside, 'secret.txt'), join(root, 'peek'));
      assert.equal(await fail('files.download', { path: 'big', maxBytes: 10 }), 'too_large');
      assert.equal(await fail('files.download', { path: 'd', maxBytes: null }), 'invalid');
      assert.equal(await fail('files.download', { path: 'peek', maxBytes: null }), 'forbidden');
      assert.equal(await fail('files.download', { path: 'gone', maxBytes: null }), 'not_found');
    });
  });
});
