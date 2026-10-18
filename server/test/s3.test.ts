import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { S3Client, S3Error, signRequest, uriEncode } from '../src/agent/s3.ts';
import { FakeS3 } from './fake-s3.ts';

describe('S3 signing', () => {
  test('matches the AWS Signature V4 documentation example (GET object with Range)', () => {
    const r = signRequest({
      method: 'GET',
      host: 'examplebucket.s3.amazonaws.com',
      path: '/test.txt',
      query: [],
      headers: { range: 'bytes=0-9' },
      payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
      secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
      region: 'us-east-1',
      date: new Date('2013-05-24T00:00:00Z'),
    });
    assert.equal(r.amzDate, '20130524T000000Z');
    assert.equal(r.signedHeaders, 'host;range;x-amz-content-sha256;x-amz-date');
    assert.match(r.authorization, /Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41$/);
  });

  test('encodes keys the way S3 expects', () => {
    assert.equal(uriEncode('a b/c(1)!.tar', true), 'a%20b/c%281%29%21.tar');
    assert.equal(uriEncode('a/b', false), 'a%2Fb');
  });
});

describe('S3 client', () => {
  let s3: FakeS3;
  let dir: string;
  before(async () => {
    s3 = await new FakeS3().start();
    dir = mkdtempSync(join(tmpdir(), 'openvps-s3-'));
  });
  after(() => s3.close());

  test('put, head, get, list, delete', async () => {
    const c = new S3Client(s3.access());
    const file = join(dir, 'a.bin');
    writeFileSync(file, 'hello backups');
    const sha = createHash('sha256').update('hello backups').digest('hex');
    await c.putFile('vps1/plan/a with space.bin', file, sha);
    assert.deepEqual(await c.head('vps1/plan/a with space.bin'), { size: 13, sha256: sha });
    assert.equal(await c.head('vps1/plan/missing'), null);
    await c.putText('vps1/plan/a.json', '{"x":1}');
    assert.equal(await c.getText('vps1/plan/a.json'), '{"x":1}');
    const out = join(dir, 'out.bin');
    await c.downloadTo('vps1/plan/a with space.bin', out);
    assert.equal(readFileSync(out, 'utf8'), 'hello backups');
    assert.deepEqual((await c.list('vps1/plan/')).map((o) => o.key), ['vps1/plan/a with space.bin', 'vps1/plan/a.json']);
    await c.delete('vps1/plan/a.json');
    assert.equal(await c.head('vps1/plan/a.json'), null);
  });

  test('follows list pagination', async () => {
    const c = new S3Client(s3.access());
    for (let i = 0; i < 5; i++) await c.putText(`vps1/page/${i}.json`, '{}');
    s3.pageSize = 2;
    try {
      assert.equal((await c.list('vps1/page/')).length, 5);
    } finally {
      s3.pageSize = 1000;
    }
  });

  test('uploads large files in parts and the object matches', async () => {
    const c = new S3Client(s3.access(), { partSize: 1000 });
    const file = join(dir, 'big.bin');
    const data = Buffer.alloc(3500, 'abcdefghij');
    writeFileSync(file, data);
    const sha = createHash('sha256').update(data).digest('hex');
    await c.putFile('vps1/big/big.bin', file, sha);
    assert.equal(s3.objects.get('vps1/big/big.bin')!.body.equals(data), true);
    assert.equal(s3.objects.get('vps1/big/big.bin')!.sha256, sha);
    assert.equal(s3.requests.filter((r) => r.includes('partNumber')).length, 4);
  });

  test('retries server errors and reports access problems clearly', async () => {
    const c = new S3Client(s3.access(), { retries: 3 });
    s3.failNext = 2;
    await c.putText('vps1/retry.json', '{}');
    assert.ok(s3.objects.has('vps1/retry.json'));

    s3.denyAll = true;
    try {
      await assert.rejects(c.getText('vps1/retry.json'), (e: unknown) => e instanceof S3Error && e.status === 403 && e.code === 'AccessDenied');
    } finally {
      s3.denyAll = false;
    }
  });
});
