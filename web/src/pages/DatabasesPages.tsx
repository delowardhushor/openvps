import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  type MongoCollection,
  type MongoConnection,
  type MongoDatabase,
  type MongoFindResult,
  type MongoIndex,
  type MongoServer,
  type MongoStats,
} from '../api';
import { DocTree, brief, relaxedJson } from '../components/BsonView';
import { ago, bytes } from '../format';

const LOCAL_URI = 'mongodb://127.0.0.1:27017';

function Back({ to, label, navigate }: { to: string; label: string; navigate: (p: string) => void }) {
  return (
    <a
      href={to}
      className="back"
      onClick={(e) => {
        e.preventDefault();
        navigate(to);
      }}
    >
      ← {label}
    </a>
  );
}

const enc = encodeURIComponent;

// ---- connections list -------------------------------------------------------------------

export function DatabasesPage({ navigate }: { navigate: (p: string) => void }) {
  const [list, setList] = useState<MongoConnection[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList((await api.mongoConnections()).connections);
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const addLocal = async () => {
    setBusy(true);
    try {
      const r = await api.createMongoConnection('Local MongoDB', LOCAL_URI);
      navigate(`/databases/${r.connection.id}`);
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Databases</h1>
          <p className="muted">Browse your MongoDB databases, collections and documents. Read-only: nothing here changes your data.</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/databases/connections/new')}>
          Add connection
        </button>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      {!list && !error && <div className="loading">Loading…</div>}
      {list && list.length === 0 && (
        <section className="card empty">
          <h2>No connections yet</h2>
          <p className="muted">Connect to MongoDB on this server, or to any MongoDB you can reach (Atlas, another VPS).</p>
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy} onClick={addLocal}>
              {busy ? 'Adding…' : 'Use MongoDB on this server'}
            </button>
            <button className="btn" onClick={() => navigate('/databases/connections/new')}>
              Enter a connection string
            </button>
          </div>
          <p className="muted small section-gap-sm">
            The first one uses <code>{LOCAL_URI}</code>. If MongoDB is not installed yet, run <code>sudo openvps provision</code> on the server.
          </p>
        </section>
      )}
      {list && list.length > 0 && (
        <section className="card table-card">
          <div className="table-scroll">
            <table className="table table-hover">
              <thead>
                <tr>
                  <th>Name</th>
                  <th>Connection</th>
                  <th>Last result</th>
                  <th aria-label="Actions" />
                </tr>
              </thead>
              <tbody>
                {list.map((c) => (
                  <tr key={c.id} className="clickable" onClick={() => navigate(`/databases/${c.id}`)}>
                    <td>
                      <strong>{c.name}</strong>
                    </td>
                    <td className="mono">{c.uri}</td>
                    <td className="small">
                      {c.lastError ? <span className="text-fail">{c.lastError}</span> : c.lastOkAt ? <span className="muted">Worked {ago(c.lastOkAt)}</span> : <span className="muted">Not opened yet</span>}
                    </td>
                    <td className="actions" onClick={(e) => e.stopPropagation()}>
                      <button className="btn btn-small" onClick={() => navigate(`/databases/connections/${c.id}/edit`)}>
                        Edit
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

// ---- add / edit a connection --------------------------------------------------------------

function serverLine(s: MongoServer): string {
  const kind = s.topology === 'replicaset' ? `replica set ${s.setName ?? ''}`.trim() : s.topology === 'sharded' ? 'sharded cluster' : 'standalone';
  return `MongoDB ${s.version ?? '(version hidden)'}, ${kind}${s.authenticated ? ', signed in' : ', no login'}${s.tls ? ', encrypted' : ''}`;
}

export function ConnectionFormPage({ id, navigate }: { id?: number; navigate: (p: string) => void }) {
  const [existing, setExisting] = useState<MongoConnection | null>(null);
  const [name, setName] = useState('');
  const [uri, setUri] = useState('');
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (id === undefined) return;
    api
      .mongoConnections()
      .then((r) => {
        const c = r.connections.find((x) => x.id === id);
        if (!c) setMissing(true);
        else {
          setExisting(c);
          setName(c.name);
        }
      })
      .catch((e: ApiError) => setErr(e));
  }, [id]);

  if (missing) {
    return (
      <>
        <Back to="/databases" label="Databases" navigate={navigate} />
        <div className="card empty">
          <h1>Not found</h1>
          <p className="muted">That connection does not exist.</p>
        </div>
      </>
    );
  }
  if (id !== undefined && !existing && !err) return <div className="loading">Loading…</div>;

  const fieldErr = (f: string) => (err?.field === f ? <div className="field-error">{err.message}</div> : null);
  const cls = (f: string) => `field ${err?.field === f ? 'has-error' : ''}`;

  const test = async () => {
    setBusy('test');
    setErr(null);
    setOk(null);
    try {
      const r = await api.testMongo(uri.trim() ? { uri: uri.trim() } : { id });
      setOk(`It works (${r.ms} ms). ${serverLine(r.server)}.`);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  };
  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('save');
    setErr(null);
    try {
      const r = existing ? await api.updateMongoConnection(existing.id, name.trim(), uri.trim()) : await api.createMongoConnection(name.trim(), uri.trim());
      navigate(`/databases/${r.connection.id}`);
    } catch (e) {
      setErr(e as ApiError);
      setBusy(null);
    }
  };

  return (
    <>
      <Back to="/databases" label="Databases" navigate={navigate} />
      <div className="page-head">
        <div>
          <h1>{existing ? `Edit ${existing.name}` : 'Add a MongoDB connection'}</h1>
          <p className="muted">The connection string is stored encrypted and is never shown again.</p>
        </div>
      </div>
      <form onSubmit={save} className="grid-2 grid-form">
        <section className="card">
          <div className="form-grid">
            <div className={cls('name')}>
              <label htmlFor="m-name">Name</label>
              <input id="m-name" value={name} placeholder="Production" onChange={(e) => setName(e.target.value)} />
              {fieldErr('name')}
            </div>
            <div className={cls('uri')}>
              <label htmlFor="m-uri">Connection string</label>
              <input
                id="m-uri"
                className="mono"
                value={uri}
                autoComplete="off"
                spellCheck={false}
                placeholder={existing ? `${existing.uri} (saved; leave blank to keep)` : 'mongodb://user:password@host:27017/?authSource=admin'}
                onChange={(e) => setUri(e.target.value)}
              />
              <div className="field-hint">
                Works with <code>mongodb://</code> and <code>mongodb+srv://</code> (Atlas). Percent-encode special characters in the password (<code>@</code> becomes <code>%40</code>). Add{' '}
                <code>?tls=true</code> for servers that need encryption.
              </div>
              {fieldErr('uri')}
            </div>
            {!existing && (
              <div className="btn-row">
                <button type="button" className="btn btn-small" onClick={() => { setUri(LOCAL_URI); if (!name) setName('Local MongoDB'); }}>
                  Fill in MongoDB on this server
                </button>
              </div>
            )}
          </div>
        </section>
        <div className="col">
          <section className="card">
            <h2>Check it works</h2>
            <p className="muted small">Connects, signs in and asks the server for its version. Nothing is saved.</p>
            {ok && <div className="alert alert-ok">{ok}</div>}
            {err && !['name', 'uri'].includes(err.field ?? '') && (
              <div className="alert alert-error">
                <pre className="pre-plain">{err.message}</pre>
              </div>
            )}
            <div className="btn-row">
              <button type="button" className="btn" disabled={busy !== null || (!uri.trim() && !existing)} onClick={test}>
                {busy === 'test' ? 'Testing…' : 'Test connection'}
              </button>
              <button className="btn btn-primary" disabled={busy !== null || !name.trim() || (!existing && !uri.trim())}>
                {busy === 'save' ? 'Saving…' : existing ? 'Save changes' : 'Add connection'}
              </button>
            </div>
          </section>
          {existing && (
            <section className="card card-danger">
              <h2>Remove connection</h2>
              <p className="muted small">Forgets this connection string. Your database and its data are not touched.</p>
              <div className="field">
                <label htmlFor="m-confirm">
                  Type <strong>{existing.name}</strong> to confirm
                </label>
                <input id="m-confirm" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} />
              </div>
              <button
                type="button"
                className="btn btn-danger"
                disabled={busy !== null || confirm !== existing.name}
                onClick={async () => {
                  setBusy('delete');
                  try {
                    await api.deleteMongoConnection(existing.id);
                    navigate('/databases');
                  } catch (e) {
                    setErr(e as ApiError);
                    setBusy(null);
                  }
                }}
              >
                Remove {existing.name}
              </button>
            </section>
          )}
        </div>
      </form>
    </>
  );
}

// ---- explorer --------------------------------------------------------------------------------

const PAGE_SIZES = [20, 50, 100];
const int = (n: number) => n.toLocaleString();

function useCopy() {
  const [done, setDone] = useState<string | null>(null);
  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setDone(key);
      setTimeout(() => setDone((d) => (d === key ? null : d)), 1500);
    } catch {
      /* clipboard not available (insecure context): nothing to do */
    }
  };
  return { copy, done };
}

function Documents({ connId, db, coll }: { connId: number; db: string; coll: string }) {
  const [filter, setFilter] = useState('');
  const [sort, setSort] = useState('');
  const [projection, setProjection] = useState('');
  const [limit, setLimit] = useState(20);
  const [skip, setSkip] = useState(0);
  const [advanced, setAdvanced] = useState(false);
  const [mode, setMode] = useState<'list' | 'table'>('list');
  const [res, setRes] = useState<MongoFindResult | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const { copy, done } = useCopy();

  const run = useCallback(
    async (over: { skip?: number; limit?: number; clear?: boolean } = {}) => {
      const mine = ++seq.current;
      const s = over.skip ?? skip;
      const l = over.limit ?? limit;
      setLoading(true);
      setErr(null);
      try {
        const r = await api.mongoQuery(connId, over.clear ? { db, collection: coll, filter: '', sort: '', projection: '', skip: s, limit: l } : { db, collection: coll, filter, sort, projection, skip: s, limit: l });
        if (mine !== seq.current) return;
        setRes(r);
      } catch (e) {
        if (mine !== seq.current) return;
        setErr(e as ApiError);
        setRes(null);
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    },
    [connId, db, coll, filter, sort, projection, skip, limit],
  );

  // First page when a collection is opened.
  useEffect(() => {
    void run({ skip: 0 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    setSkip(0);
    void run({ skip: 0 });
  };
  const go = (s: number) => {
    setSkip(s);
    void run({ skip: s });
  };
  const fieldErr = (f: string) => (err?.field === f ? <div className="field-error">{err.message}</div> : null);

  const docs = res?.documents ?? [];
  const from = docs.length ? res!.skip + 1 : 0;
  const to = res ? res.skip + docs.length : 0;
  const hasNext = res ? (res.total !== null ? to < res.total : docs.length === res.limit) : false;

  const columns: string[] = [];
  if (mode === 'table') {
    for (const d of docs) {
      for (const k of Object.keys(d as object)) if (!columns.includes(k)) columns.push(k);
    }
    columns.sort((a, b) => (a === '_id' ? -1 : b === '_id' ? 1 : 0));
  }

  return (
    <>
      <form onSubmit={submit}>
        <div className="mongo-bar">
          <div className={`field grow ${err?.field === 'filter' ? 'has-error' : ''}`}>
            <input
              className="mono"
              aria-label="Filter"
              value={filter}
              placeholder={'Filter, e.g. { status: "active" }   { age: { $gt: 30 } }   { _id: ObjectId("…") }'}
              spellCheck={false}
              autoComplete="off"
              onChange={(e) => setFilter(e.target.value)}
            />
            {fieldErr('filter')}
          </div>
          <button className="btn btn-primary" disabled={loading}>
            {loading ? 'Finding…' : 'Find'}
          </button>
          <button
            type="button"
            className="btn"
            onClick={() => {
              setFilter('');
              setSort('');
              setProjection('');
              setSkip(0);
              void run({ skip: 0, clear: true });
            }}
          >
            Reset
          </button>
          <button type="button" className="btn" aria-expanded={advanced} onClick={() => setAdvanced(!advanced)}>
            Options {advanced ? '▴' : '▾'}
          </button>
        </div>
        {advanced && (
          <div className="mongo-adv">
            <div className={`field ${err?.field === 'sort' ? 'has-error' : ''}`}>
              <label htmlFor="q-sort">Sort</label>
              <input id="q-sort" value={sort} placeholder="{ createdAt: -1 }" spellCheck={false} onChange={(e) => setSort(e.target.value)} />
              {fieldErr('sort')}
            </div>
            <div className={`field ${err?.field === 'projection' ? 'has-error' : ''}`}>
              <label htmlFor="q-proj">Project</label>
              <input id="q-proj" value={projection} placeholder="{ name: 1, email: 1 }" spellCheck={false} onChange={(e) => setProjection(e.target.value)} />
              {fieldErr('projection')}
            </div>
            <div className="field">
              <label htmlFor="q-limit">Per page</label>
              <select
                id="q-limit"
                value={limit}
                onChange={(e) => {
                  const l = Number(e.target.value);
                  setLimit(l);
                  setSkip(0);
                  void run({ skip: 0, limit: l });
                }}
              >
                {PAGE_SIZES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </form>
      {err && !['filter', 'sort', 'projection'].includes(err.field ?? '') && <div className="alert alert-error">{err.message}</div>}
      {res && (
        <div className="mongo-status">
          <span>
            {docs.length ? (
              <>
                <strong>
                  {int(from)}–{int(to)}
                </strong>
                {res.total !== null && <> of {int(res.total)}</>}
              </>
            ) : (
              'No documents match'
            )}{' '}
            · {res.ms} ms
          </span>
          <span className="spacer" />
          <div className="seg" role="group" aria-label="View">
            <button type="button" className={mode === 'list' ? 'on' : ''} onClick={() => setMode('list')}>
              List
            </button>
            <button type="button" className={mode === 'table' ? 'on' : ''} onClick={() => setMode('table')}>
              Table
            </button>
          </div>
          <button className="btn btn-small" disabled={loading || skip === 0} onClick={() => go(Math.max(0, skip - limit))}>
            ← Prev
          </button>
          <button className="btn btn-small" disabled={loading || !hasNext} onClick={() => go(skip + limit)}>
            Next →
          </button>
        </div>
      )}
      {res && mode === 'list' &&
        docs.map((d, i) => (
          <div className="card doc-card" key={`${res.skip}-${i}`}>
            <div className="doc-tools">
              <button className="btn btn-small" onClick={() => void copy(`d${i}`, relaxedJson(d))}>
                {done === `d${i}` ? 'Copied' : 'Copy JSON'}
              </button>
            </div>
            <DocTree doc={d} />
          </div>
        ))}
      {res && mode === 'table' && docs.length > 0 && (
        <section className="card table-card">
          <div className="table-scroll">
            <table className="table">
              <thead>
                <tr>
                  {columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {docs.map((d, i) => (
                  <tr key={`${res.skip}-${i}`}>
                    {columns.map((c) => {
                      const v = (d as Record<string, unknown>)[c];
                      const text = v === undefined ? '' : brief(v);
                      return (
                        <td key={c}>
                          <div className="cell-trunc" title={text}>
                            {text}
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}

function Overview({ connId, db, coll }: { connId: number; db: string; coll: string }) {
  const [data, setData] = useState<{ stats: MongoStats | null; indexes: MongoIndex[]; note: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    api
      .mongoStats(connId, db, coll)
      .then(setData)
      .catch((e: ApiError) => setErr(e.message));
  }, [connId, db, coll]);
  if (err) return <div className="alert alert-error">{err}</div>;
  if (!data) return <div className="loading">Loading…</div>;
  const s = data.stats;
  const stat = (label: string, v: string) => (
    <div key={label}>
      <dt>{label}</dt>
      <dd>{v}</dd>
    </div>
  );
  return (
    <>
      {data.note && <div className="alert alert-info">{data.note}</div>}
      {s && (
        <dl className="stat-grid">
          {stat('Documents', s.count === null ? '—' : int(s.count))}
          {stat('Data size', s.size === null ? '—' : bytes(s.size))}
          {stat('Average document', s.avgObjSize === null ? '—' : bytes(s.avgObjSize))}
          {stat('Storage on disk', s.storageSize === null ? '—' : bytes(s.storageSize))}
          {stat('Indexes', s.indexCount === null ? '—' : `${s.indexCount} (${s.totalIndexSize === null ? '—' : bytes(s.totalIndexSize)})`)}
        </dl>
      )}
      <section className="card table-card">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Index</th>
                <th>Keys</th>
                <th>Properties</th>
                <th className="num">Size</th>
              </tr>
            </thead>
            <tbody>
              {data.indexes.length === 0 && (
                <tr>
                  <td colSpan={4} className="muted">
                    No indexes.
                  </td>
                </tr>
              )}
              {data.indexes.map((ix) => (
                <tr key={ix.name}>
                  <td className="mono">{ix.name}</td>
                  <td className="mono">
                    {Object.entries(ix.key as Record<string, unknown>)
                      .map(([k, v]) => `${k}: ${brief(v)}`)
                      .join(', ')}
                  </td>
                  <td className="small">
                    {[ix.unique && 'unique', ix.sparse && 'sparse', ix.ttlSeconds !== null && `expires after ${int(ix.ttlSeconds)} s`, ix.partial !== null && 'partial'].filter(Boolean).join(', ') || '—'}
                  </td>
                  <td className="num">{ix.sizeBytes === null ? '—' : bytes(ix.sizeBytes)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function CollectionView({ connId, db, coll, type }: { connId: number; db: string; coll: string; type: string }) {
  const [tab, setTab] = useState<'docs' | 'info'>('docs');
  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="mono">
            {db}.{coll}
          </h1>
          {type !== 'collection' && <p className="muted">This is a {type}.</p>}
        </div>
      </div>
      <div className="mongo-tabs" role="tablist">
        <button role="tab" aria-selected={tab === 'docs'} className={`mongo-tab ${tab === 'docs' ? 'on' : ''}`} onClick={() => setTab('docs')}>
          Documents
        </button>
        <button role="tab" aria-selected={tab === 'info'} className={`mongo-tab ${tab === 'info' ? 'on' : ''}`} onClick={() => setTab('info')}>
          Indexes &amp; size
        </button>
      </div>
      {tab === 'docs' ? <Documents key={`${db}.${coll}`} connId={connId} db={db} coll={coll} /> : <Overview connId={connId} db={db} coll={coll} />}
    </>
  );
}

export function ExplorerPage({ id, db, coll, navigate }: { id: number; db: string | null; coll: string | null; navigate: (p: string) => void }) {
  const [conn, setConn] = useState<MongoConnection | null>(null);
  const [dbs, setDbs] = useState<MongoDatabase[] | null>(null);
  const [server, setServer] = useState<MongoServer | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [colls, setColls] = useState<Record<string, MongoCollection[] | 'loading' | string>>({});
  const [showSystem, setShowSystem] = useState(false);

  const loadDbs = useCallback(async () => {
    setError(null);
    try {
      const [c, r] = await Promise.all([api.mongoConnections(), api.mongoDatabases(id)]);
      setConn(c.connections.find((x) => x.id === id) ?? null);
      setDbs(r.databases);
      setServer(r.server);
      setNote(r.note);
    } catch (e) {
      setError(e as ApiError);
      api.mongoConnections().then((c) => setConn(c.connections.find((x) => x.id === id) ?? null)).catch(() => undefined);
    }
  }, [id]);
  useEffect(() => {
    void loadDbs();
  }, [loadDbs]);

  const loadColls = useCallback(
    async (name: string) => {
      setColls((c) => ({ ...c, [name]: 'loading' }));
      try {
        const r = await api.mongoCollections(id, name);
        setColls((c) => ({ ...c, [name]: r.collections }));
      } catch (e) {
        setColls((c) => ({ ...c, [name]: (e as ApiError).message }));
      }
    },
    [id],
  );

  // The database in the URL is always expanded.
  useEffect(() => {
    if (db && colls[db] === undefined) {
      setOpen((o) => ({ ...o, [db]: true }));
      void loadColls(db);
    }
  }, [db, colls, loadColls]);

  const toggle = (name: string) => {
    const next = !open[name];
    setOpen({ ...open, [name]: next });
    if (next && colls[name] === undefined) void loadColls(name);
  };

  const currentColl = db && coll && Array.isArray(colls[db]) ? (colls[db] as MongoCollection[]).find((c) => c.name === coll) : undefined;

  return (
    <>
      <Back to="/databases" label="Databases" navigate={navigate} />
      <div className="page-head">
        <div>
          <h1>{conn?.name ?? 'Database'}</h1>
          <p className="muted">{server ? serverLine(server) : conn ? <span className="mono">{conn.uri}</span> : ' '}</p>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => void loadDbs()}>
            Refresh
          </button>
          <button className="btn" onClick={() => navigate(`/databases/connections/${id}/edit`)}>
            Edit
          </button>
        </div>
      </div>
      {error && (
        <div className="alert alert-error">
          <strong>Cannot connect.</strong> {error.message}
          <div className="small">Check the connection string and that MongoDB is reachable from this server.</div>
        </div>
      )}
      {note && <div className="alert alert-info">{note}</div>}
      {!dbs && !error && <div className="loading">Connecting…</div>}
      {dbs && (
        <div className="mongo-layout">
          <aside className="card mongo-tree" aria-label="Databases">
            <h2>Databases ({dbs.length})</h2>
            {dbs.map((d) => {
              const list = colls[d.name];
              const isOpen = !!open[d.name];
              return (
                <div key={d.name}>
                  <button className={`tree-item ${db === d.name && !coll ? 'on' : ''}`} onClick={() => { toggle(d.name); navigate(`/databases/${id}/${enc(d.name)}`); }} aria-expanded={isOpen}>
                    <span className="tree-caret" aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                    <span className="tree-name">{d.name}</span>
                    {d.sizeOnDisk !== null && <span className="tree-meta">{bytes(d.sizeOnDisk)}</span>}
                  </button>
                  {isOpen && (
                    <div className="tree-children">
                      {list === 'loading' && <div className="muted small tree-item">Loading…</div>}
                      {typeof list === 'string' && list !== 'loading' && <div className="text-fail small tree-item">{list}</div>}
                      {Array.isArray(list) &&
                        list
                          .filter((c) => showSystem || !c.system)
                          .map((c) => (
                            <button key={c.name} className={`tree-item ${db === d.name && coll === c.name ? 'on' : ''}`} onClick={() => navigate(`/databases/${id}/${enc(d.name)}/${enc(c.name)}`)}>
                              <span className="tree-name" title={c.name}>{c.name}</span>
                              {c.type !== 'collection' && <span className="tree-meta">{c.type}</span>}
                            </button>
                          ))}
                      {Array.isArray(list) && list.length === 0 && <div className="muted small tree-item">No collections</div>}
                    </div>
                  )}
                </div>
              );
            })}
            <label className="check small" style={{ margin: '10px 8px 4px' }}>
              <input type="checkbox" checked={showSystem} onChange={(e) => setShowSystem(e.target.checked)} />
              <span>Show system collections</span>
            </label>
          </aside>
          <div style={{ minWidth: 0 }}>
            {db && coll ? (
              <CollectionView key={`${db}.${coll}`} connId={id} db={db} coll={coll} type={currentColl?.type ?? 'collection'} />
            ) : db ? (
              <DatabaseSummary db={db} list={colls[db]} onOpen={(c) => navigate(`/databases/${id}/${enc(db)}/${enc(c)}`)} showSystem={showSystem} />
            ) : (
              <section className="card empty">
                <h2>Pick a database</h2>
                <p className="muted">Choose a database on the left, then a collection, to see its documents.</p>
              </section>
            )}
          </div>
        </div>
      )}
    </>
  );
}

function DatabaseSummary({ db, list, onOpen, showSystem }: { db: string; list: MongoCollection[] | 'loading' | string | undefined; onOpen: (c: string) => void; showSystem: boolean }) {
  return (
    <>
      <div className="page-head">
        <h1 className="mono">{db}</h1>
      </div>
      {(list === undefined || list === 'loading') && <div className="loading">Loading…</div>}
      {typeof list === 'string' && list !== 'loading' && <div className="alert alert-error">{list}</div>}
      {Array.isArray(list) && (
        <section className="card table-card">
          <div className="table-scroll">
            <table className="table table-hover">
              <thead>
                <tr>
                  <th>Collection</th>
                  <th>Type</th>
                </tr>
              </thead>
              <tbody>
                {list.filter((c) => showSystem || !c.system).length === 0 && (
                  <tr>
                    <td colSpan={2} className="muted">
                      This database has no collections.
                    </td>
                  </tr>
                )}
                {list
                  .filter((c) => showSystem || !c.system)
                  .map((c) => (
                    <tr key={c.name} className="clickable" onClick={() => onOpen(c.name)}>
                      <td className="mono">{c.name}</td>
                      <td className="small muted">{c.type}{c.capped ? ', capped' : ''}{c.viewOn ? `, on ${c.viewOn}` : ''}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </>
  );
}
