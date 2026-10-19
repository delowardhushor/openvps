import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Client, GOOD_PASSWORD, startTestServer, type TestServer } from './helpers.ts';
import { startFakeMongo, type FakeMongo } from './fake-mongo.ts';
import { ObjectId } from '../src/mongo/bson.ts';

describe('MongoDB browser API', () => {
  let srv: TestServer;
  let fake: FakeMongo;
  let c: Client;
  let id: number;
  const PASSWORD = 'sup3r-s3cret!pw';

  before(async () => {
    fake = await startFakeMongo({
      user: { name: 'ada', password: PASSWORD },
      data: {
        shop: {
          users: Array.from({ length: 30 }, (_, i) => ({ _id: ObjectId.fromHex(String(i).padStart(24, '0')), n: i, name: `user${i}` })),
        },
      },
    });
    srv = await startTestServer();
    c = new Client(srv.url);
    assert.equal((await c.post('/api/setup', { setupToken: srv.setupToken, username: 'admin', password: GOOD_PASSWORD })).status, 200);
  });
  after(async () => {
    srv?.app.mongoPool.closeAll();
    await srv?.close();
    await fake?.close();
  });

  const uri = () => fake.uri('?authSource=admin');

  test('requires authentication', async () => {
    const anon = new Client(srv.url);
    assert.equal((await anon.get('/api/mongo/connections')).status, 401);
    assert.equal((await anon.post('/api/mongo/test', {})).status, 401);
    assert.equal((await anon.post('/api/mongo/connections/1/query', {})).status, 401);
    assert.equal((await anon.get('/api/mongo/connections/1/databases')).status, 401);
  });

  test('tests a connection without saving it', async () => {
    let r = await c.post('/api/mongo/test', { uri: uri() });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.server.version, '8.0.4');
    assert.equal(r.json.server.authenticated, true);
    r = await c.post('/api/mongo/test', { uri: uri().replace(encodeURIComponent(PASSWORD), 'wrong') });
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'mongo_auth');
    assert.ok(!r.text.includes('wrong'));
    r = await c.post('/api/mongo/test', { uri: 'mongodb://127.0.0.1:1/?connectTimeoutMS=1000' });
    assert.equal(r.status, 502);
    assert.equal(r.json.error.code, 'mongo_unreachable');
    assert.equal((await c.get('/api/mongo/connections')).json.connections.length, 0);
  });

  test('validates what is saved', async () => {
    let r = await c.post('/api/mongo/connections', { name: '', uri: uri() });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.field, 'name');
    r = await c.post('/api/mongo/connections', { name: 'x', uri: 'http://nope' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.field, 'uri');
  });

  test('saves a connection sealed, shows it without the password, and audits it', async () => {
    const r = await c.post('/api/mongo/connections', { name: 'Shop', uri: uri() });
    assert.equal(r.status, 200, r.text);
    id = r.json.connection.id;
    assert.ok(!r.text.includes(PASSWORD));
    assert.match(r.json.connection.uri, /ada:\*\*\*@/);
    const list = await c.get('/api/mongo/connections');
    assert.ok(!list.text.includes(PASSWORD));
    const raw = srv.app.db.prepare('SELECT uri_sealed FROM mongo_connections').get() as { uri_sealed: string };
    assert.ok(raw.uri_sealed.startsWith('v1:'));
    assert.ok(!raw.uri_sealed.includes('ada'));
    assert.equal((await c.post('/api/mongo/connections', { name: 'Shop', uri: uri() })).status, 409);
    const log = JSON.stringify(srv.app.db.prepare('SELECT action, details FROM audit_log').all());
    assert.ok(log.includes('mongo.connection_create'));
    assert.ok(!log.includes(PASSWORD));
  });

  test('lists databases, collections, stats', async () => {
    let r = await c.get(`/api/mongo/connections/${id}/databases`);
    assert.equal(r.status, 200, r.text);
    assert.ok(r.json.databases.some((d: any) => d.name === 'shop'));
    assert.equal(r.json.server.version, '8.0.4');
    r = await c.get(`/api/mongo/connections/${id}/databases/shop/collections`);
    assert.deepEqual(r.json.collections.map((x: any) => x.name), ['users']);
    r = await c.get(`/api/mongo/connections/${id}/databases/shop/collections/users/stats`);
    assert.equal(r.json.stats.count, 30);
    assert.equal(r.json.indexes.length, 2);
    assert.equal((await c.get(`/api/mongo/connections/${id}/databases/a.b/collections`)).status, 400);
    assert.equal((await c.get('/api/mongo/connections/999/databases')).status, 404);
    assert.ok(srv.app.mongo.get(id)!.lastOkAt);
  });

  test('queries with filter, sort, skip and limit', async () => {
    let r = await c.post(`/api/mongo/connections/${id}/query`, { db: 'shop', collection: 'users', filter: '{ n: { $gte: 20 } }', sort: '{ n: 1 }', limit: 4, skip: 2 });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.total, 10);
    assert.deepEqual(r.json.documents.map((d: any) => d.n.$numberInt), ['22', '23', '24', '25']);
    assert.deepEqual(r.json.documents[0]._id, { $oid: '000000000000000000000022' });
    r = await c.post(`/api/mongo/connections/${id}/query`, { db: 'shop', collection: 'users', filter: '{ _id: ObjectId("000000000000000000000003") }' });
    assert.equal(r.json.documents.length, 1);
    assert.equal(r.json.documents[0].name, 'user3');
  });

  test('bad queries are field errors, and server-side JavaScript never reaches the server', async () => {
    const before = fake.commands.length;
    let r = await c.post(`/api/mongo/connections/${id}/query`, { db: 'shop', collection: 'users', filter: '{ n: ' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.field, 'filter');
    r = await c.post(`/api/mongo/connections/${id}/query`, { db: 'shop', collection: 'users', filter: '{ $where: "sleep(5000)" }' });
    assert.equal(r.status, 400);
    assert.match(r.json.error.message, /JavaScript/);
    r = await c.post(`/api/mongo/connections/${id}/query`, { db: 'shop', collection: 'users', limit: 5000 });
    assert.equal(r.status, 400);
    assert.equal(r.json.error.field, 'limit');
    r = await c.post(`/api/mongo/connections/${id}/query`, { db: 'shop', collection: 'users', sort: '{ $where: 1 }' });
    assert.equal(r.status, 400);
    assert.equal(fake.commands.length, before);
  });

  test('editing keeps the stored password when the string is left blank; deleting forgets it', async () => {
    let r = await c.req('PUT', `/api/mongo/connections/${id}`, { name: 'Shop 2', uri: '' });
    assert.equal(r.status, 200, r.text);
    assert.equal(r.json.connection.name, 'Shop 2');
    assert.equal(srv.app.mongo.uri(id), uri());
    assert.equal((await c.get(`/api/mongo/connections/${id}/databases`)).status, 200);
    r = await c.req('DELETE', `/api/mongo/connections/${id}`);
    assert.equal(r.status, 200);
    assert.equal((await c.get(`/api/mongo/connections/${id}/databases`)).status, 404);
    const log = JSON.stringify(srv.app.db.prepare('SELECT action FROM audit_log').all());
    assert.ok(log.includes('mongo.connection_update') && log.includes('mongo.connection_delete'));
  });

  test('a connection error is reported and remembered', async () => {
    const r = await c.post('/api/mongo/connections', { name: 'Gone', uri: 'mongodb://127.0.0.1:1/?connectTimeoutMS=1000' });
    const gid = r.json.connection.id;
    const q = await c.get(`/api/mongo/connections/${gid}/databases`);
    assert.equal(q.status, 502);
    assert.ok(srv.app.mongo.get(gid)!.lastError);
  });

  test('state-changing calls need the CSRF header', async () => {
    const r = await c.req('POST', '/api/mongo/test', { uri: uri() }, { 'x-openvps-request': '0' });
    assert.equal(r.status, 403);
  });
});
