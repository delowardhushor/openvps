import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  api,
  ApiError,
  type AppRecord,
  type ArtifactInfo,
  type BackupDestination,
  type BackupPlanView,
  type BackupRun,
  type BackupsOverview,
  type InspectResult,
  type S3Target,
} from '../api';
import { PlanForm, initialPlanForm, toPlanInput, type PlanFormValue } from '../components/PlanForm';
import { RunSummary, RunWatcher, backupTime, kindLabel, scheduleLabel } from '../components/BackupBits';
import { ago, bytes, dateTime, shortDate } from '../format';

function useBackups() {
  const [data, setData] = useState<BackupsOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api.backups());
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  const busy = !!data?.plans.some((p) => p.running);
  useEffect(() => {
    const t = setInterval(() => void load(), busy ? 3000 : 30_000);
    return () => clearInterval(t);
  }, [load, busy]);
  return { data, error, reload: load };
}

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

function Link({ to, navigate, children }: { to: string; navigate: (p: string) => void; children: React.ReactNode }) {
  return (
    <a
      className="row-link"
      href={to}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

function describeSources(p: BackupPlanView): string {
  const files = p.sources.filter((s) => s.type === 'files').length;
  const mongo = p.sources.filter((s) => s.type === 'mongodb').length;
  return [files ? `${files} folder${files > 1 ? 's' : ''}` : '', mongo ? `${mongo} MongoDB` : ''].filter(Boolean).join(' + ');
}

function keptWhere(p: { keepLocal: boolean; destination: string | null }): string {
  return [p.keepLocal ? 'this server' : '', p.destination ? `cloud (${p.destination})` : ''].filter(Boolean).join(' + ');
}

// ---- overview ------------------------------------------------------------------------

export function BackupsPage({ navigate }: { navigate: (p: string) => void }) {
  const { data, error } = useBackups();
  const needsMongo = !!data?.plans.some((p) => p.sources.some((s) => s.type === 'mongodb'));
  const localOnly = data?.plans.filter((p) => !p.destination) ?? [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Backups</h1>
          <p className="muted">Scheduled copies of your folders and MongoDB databases, kept here and in S3-compatible cloud storage.</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/backups/plans/new')} disabled={data ? !data.agent.available : false}>
          New backup plan
        </button>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      {!data && !error && <div className="loading">Loading backups…</div>}
      {data && !data.agent.available && (
        <div className="alert alert-warn">
          <strong>The OpenVPS agent is not running.</strong> On the server, run <code>sudo openvps provision</code>.
        </div>
      )}
      {data?.status && !data.status.tar && <div className="alert alert-error">The <code>tar</code> program was not found, so backups cannot run.</div>}
      {data?.status && needsMongo && !data.status.mongodump && (
        <div className="alert alert-warn">
          A plan backs up MongoDB, but <code>mongodump</code> is not installed. Run <code>sudo openvps provision</code> on the server
          to install MongoDB Community (or the{' '}
          <a href="https://www.mongodb.com/docs/database-tools/installation/installation-linux/" target="_blank" rel="noreferrer">
            MongoDB Database Tools
          </a>
          , if MongoDB is already there).
        </div>
      )}
      {data && !data.scheduler && <div className="alert alert-info">Scheduled backups are turned off in the configuration (<code>backups.scheduler</code>). Plans only run when you click.</div>}
      {localOnly.length > 0 && (
        <div className="alert alert-warn">
          <strong>{localOnly.map((p) => p.name).join(', ')}</strong> {localOnly.length > 1 ? 'are' : 'is'} kept only on this server. If the server or its disk is lost, so are the backups. Add cloud storage for an off-server copy.
        </div>
      )}

      {data && (
        <>
          <section className="card table-card section-gap">
            <div className="card-head card-head-pad">
              <h2>Backup plans</h2>
              {data.status && <span className="muted small">{data.status.freeBytes !== null ? `${bytes(data.status.freeBytes)} free on this server` : ''}</span>}
            </div>
            {data.plans.length ? (
              <div className="table-scroll">
                <table className="table table-hover">
                  <thead>
                    <tr>
                      <th>Plan</th>
                      <th className="hide-sm">Kept in</th>
                      <th>Last backup</th>
                      <th className="hide-sm">Next</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.plans.map((p) => (
                      <tr key={p.name} className="clickable" onClick={() => navigate(`/backups/plans/${p.name}`)}>
                        <td>
                          <Link to={`/backups/plans/${p.name}`} navigate={navigate}>
                            {p.name}
                          </Link>
                          <div className="muted small">
                            {describeSources(p)} · {scheduleLabel(p.schedule)}
                            {!p.enabled && ' · paused'}
                          </div>
                        </td>
                        <td className="hide-sm small">{keptWhere(p)}</td>
                        <td>
                          {p.running ? <RunSummary run={p.running} /> : p.lastBackup ? <RunSummary run={p.lastBackup} /> : <span className="muted">Never run</span>}
                        </td>
                        <td className="hide-sm small">{p.enabled && p.nextRunAt ? dateTime(p.nextRunAt) : <span className="muted">—</span>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-inline">
                <p>No backup plans yet.</p>
                <p className="muted small">Choose folders and databases, a schedule and where to keep the copies.</p>
                <button className="btn btn-primary" onClick={() => navigate('/backups/plans/new')} disabled={!data.agent.available}>
                  Create your first plan
                </button>
              </div>
            )}
          </section>

          <section className="card table-card section-gap">
            <div className="card-head card-head-pad">
              <h2>Cloud storage</h2>
              <button className="btn btn-small" onClick={() => navigate('/backups/destinations/new')}>
                Add storage
              </button>
            </div>
            {data.destinations.length ? (
              <div className="table-scroll">
                <table className="table table-hover">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Bucket</th>
                      <th className="hide-sm">Used by</th>
                      <th>Connection</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.destinations.map((d) => (
                      <tr key={d.name} className="clickable" onClick={() => navigate(`/backups/destinations/${d.name}`)}>
                        <td>
                          <Link to={`/backups/destinations/${d.name}`} navigate={navigate}>
                            {d.name}
                          </Link>
                        </td>
                        <td className="small">
                          <span className="mono">{d.target.bucket}</span>
                          <div className="muted mono ellipsis">{d.target.endpoint.replace(/^https?:\/\//, '')}</div>
                        </td>
                        <td className="hide-sm small">{d.usedBy.length ? d.usedBy.join(', ') : <span className="muted">no plan yet</span>}</td>
                        <td>
                          {d.lastTestOk === null ? <span className="pill pill-muted">Not tested</span> : d.lastTestOk ? <span className="pill pill-success">Works</span> : <span className="pill pill-failure">Failed</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-inline">
                <p className="muted">Works with Amazon S3, Cloudflare R2, Backblaze B2, Wasabi, DigitalOcean Spaces, MinIO and other S3-compatible services.</p>
              </div>
            )}
          </section>

          <section className="card table-card section-gap">
            <div className="card-head card-head-pad">
              <h2>Recent activity</h2>
            </div>
            {data.runs.length ? (
              <div className="table-scroll">
                <table className="table">
                  <thead>
                    <tr>
                      <th>When</th>
                      <th>Plan</th>
                      <th>What</th>
                      <th>Result</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.runs.slice(0, 15).map((r) => (
                      <tr key={r.id}>
                        <td className="small nowrap">{ago(r.startedAt, data.serverTime)}</td>
                        <td>{r.plan}</td>
                        <td className="small">
                          {kindLabel(r.kind)}
                          {r.trigger === 'schedule' && <span className="muted"> · scheduled</span>}
                        </td>
                        <td>
                          <RunSummary run={r} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="empty-inline muted">Nothing has run yet.</div>
            )}
          </section>
        </>
      )}
    </>
  );
}

// ---- plan form -----------------------------------------------------------------------

export function PlanFormPage({ name, navigate }: { name?: string; navigate: (p: string) => void }) {
  const { data, error: loadError } = useBackups();
  const [apps, setApps] = useState<AppRecord[]>([]);
  const [form, setForm] = useState<PlanFormValue | null>(name ? null : initialPlanForm());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  useEffect(() => {
    api.apps().then((r) => setApps(r.apps)).catch(() => undefined);
  }, []);
  const plan = name ? data?.plans.find((p) => p.name === name) : undefined;
  useEffect(() => {
    if (plan && !form) setForm(initialPlanForm(plan));
  }, [plan, form]);
  useEffect(() => {
    // New plans start with one folder row so the form isn't empty.
    if (!name && form && form.files.length === 0 && form.mongo.length === 0 && !form.name && apps.length) {
      setForm({ ...form, files: [{ name: '', path: apps[0]!.spec.cwd, exclude: 'node_modules' }] });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apps]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setErr(null);
    try {
      const input = toPlanInput(form, !!name);
      const r = name ? await api.updatePlan(name, input) : await api.createPlan(input);
      navigate(`/backups/plans/${r.plan.name}`);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (name && data && !plan) {
    return (
      <>
        <Back to="/backups" label="Backups" navigate={navigate} />
        <div className="card empty">
          <h1>Not found</h1>
          <p className="muted">There is no backup plan named {name}.</p>
        </div>
      </>
    );
  }
  if (!form || !data) return <div className="loading">{loadError ?? 'Loading…'}</div>;

  const known = ['name', 'sources', 'mongoUris', 'schedule', 'destination', 'keepLast', 'maxAgeDays'];
  return (
    <>
      <Back to={name ? `/backups/plans/${name}` : '/backups'} label={name ?? 'Backups'} navigate={navigate} />
      <div className="page-head">
        <div>
          <h1>{name ? `Edit ${name}` : 'New backup plan'}</h1>
          <p className="muted">Choose what to back up, when, and where to keep it.</p>
        </div>
      </div>
      <form onSubmit={submit} className="grid-2 grid-form">
        <section className="card">
          <PlanForm
            value={form}
            onChange={setForm}
            destinations={data.destinations}
            apps={apps}
            roots={data.status?.fileRoots ?? ['/srv/apps']}
            timezone={data.timezone}
            editing={!!name}
            error={err}
            navigate={navigate}
          />
        </section>
        <div className="col">
          <section className="card">
            <h2>Good to know</h2>
            <ul className="small">
              <li>The first backup runs at the next scheduled time. Click <strong>Back up now</strong> on the plan page to try it right away.</li>
              <li>Backups are compressed. Each run is one file you can download from the server or the bucket.</li>
              <li>An off-server copy is what saves you if the server is lost.</li>
            </ul>
            {err && !known.includes(err.field ?? '') && (
              <div className="alert alert-error">
                <pre className="pre-plain">{err.message}</pre>
              </div>
            )}
            <div className="btn-row">
              <button className="btn btn-primary" disabled={busy || (!name && !form.name) || (form.files.length === 0 && form.mongo.length === 0)}>
                {busy ? 'Saving…' : name ? 'Save changes' : 'Create plan'}
              </button>
              <button type="button" className="btn" onClick={() => navigate(name ? `/backups/plans/${name}` : '/backups')}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      </form>
    </>
  );
}

// ---- plan detail ---------------------------------------------------------------------

function ArtifactTable({
  title,
  where,
  items,
  busy,
  onRestore,
  onVerify,
  onDelete,
  empty,
}: {
  title: string;
  where: 'local' | 'remote';
  items: ArtifactInfo[];
  busy: boolean;
  onRestore: (a: ArtifactInfo) => void;
  onVerify: (a: ArtifactInfo, deep: boolean) => void;
  onDelete: (a: ArtifactInfo) => void;
  empty: string;
}) {
  const [confirming, setConfirming] = useState<string | null>(null);
  return (
    <section className="card table-card section-gap">
      <div className="card-head card-head-pad">
        <h2>{title}</h2>
        <span className="muted small">{items.length} backup{items.length === 1 ? '' : 's'}</span>
      </div>
      {items.length ? (
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Taken</th>
                <th>Size</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {items.map((a) => (
                <tr key={a.name}>
                  <td>
                    {backupTime(a.createdAt)} <span className="muted small">({ago(a.createdAt)})</span>
                    {!a.complete && <div className="text-warn small">Incomplete: no description file, so it can't be restored.</div>}
                  </td>
                  <td className="nowrap">{bytes(a.sizeBytes)}</td>
                  <td className="nowrap">
                    {confirming === a.name ? (
                      <span className="btn-row btn-row-compact">
                        <span className="small">Delete this backup for good?</span>
                        <button className="btn btn-small btn-danger" disabled={busy} onClick={() => { setConfirming(null); onDelete(a); }}>
                          Delete
                        </button>
                        <button className="btn btn-small" onClick={() => setConfirming(null)}>
                          Keep
                        </button>
                      </span>
                    ) : (
                      <span className="btn-row btn-row-compact">
                        <button className="btn btn-small btn-primary" disabled={busy || !a.complete} onClick={() => onRestore(a)}>
                          Restore…
                        </button>
                        <button className="btn btn-small" disabled={busy || !a.complete} onClick={() => onVerify(a, false)} title={where === 'remote' ? 'Compares size and checksum recorded at upload' : 'Recalculates the checksum'}>
                          Check
                        </button>
                        {where === 'remote' && (
                          <button className="btn btn-small" disabled={busy || !a.complete} onClick={() => onVerify(a, true)} title="Downloads the backup and checks every byte">
                            Full check
                          </button>
                        )}
                        <button className="btn btn-small btn-danger-ghost" disabled={busy} onClick={() => setConfirming(a.name)}>
                          Delete
                        </button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty-inline muted">{empty}</div>
      )}
    </section>
  );
}

function RestoreWizard({ plan, where, artifact, onClose, onFinished }: { plan: BackupPlanView; where: 'local' | 'remote'; artifact: ArtifactInfo; onClose: () => void; onFinished: (run: BackupRun) => void }) {
  const [info, setInfo] = useState<InspectResult | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);
  const [chosen, setChosen] = useState<Record<string, 'original' | 'alternate' | null>>({});
  const [drop, setDrop] = useState(false);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [runId, setRunId] = useState<number | null>(null);

  useEffect(() => {
    api
      .inspectBackup(plan.name, where, artifact.name)
      .then((r) => {
        setInfo(r);
        setChosen(Object.fromEntries(r.members.map((m) => [m.file, m.kind === 'files' ? ('alternate' as const) : null])));
      })
      .catch((e: ApiError) => setLoadErr(e.message));
  }, [plan.name, where, artifact.name]);

  const selected = info?.members.filter((m) => !!chosen[m.file]) ?? [];
  const start = async () => {
    setBusy(true);
    setErr(null);
    try {
      const items = selected.map((m) => ({ file: m.file, target: chosen[m.file] === 'alternate' ? ('alternate' as const) : ('original' as const) }));
      const r = await api.restoreBackup(plan.name, { where, artifact: artifact.name, items, drop, confirm });
      setRunId(r.run.id);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const overwriting = selected.filter((m) => m.kind === 'files' && chosen[m.file] === 'original' && m.current?.exists);
  const mongoSelected = selected.filter((m) => m.kind === 'mongodb');

  return (
    <section className="card card-warn section-gap">
      <div className="card-head">
        <h2>
          Restore the backup from {backupTime(artifact.createdAt)} <span className="muted small">({where === 'local' ? 'this server' : 'cloud'})</span>
        </h2>
        <button className="btn btn-small" onClick={onClose}>
          Close
        </button>
      </div>
      {loadErr && <div className="alert alert-error">{loadErr}</div>}
      {!info && !loadErr && <div className="loading">Reading the backup…</div>}
      {info && runId === null && (
        <>
          <p className="muted small">Taken on {info.manifest.hostname}. Choose what to restore.</p>
          <div className="form-grid">
            {info.members.map((m) => {
              const isFiles = m.kind === 'files';
              const on = !!chosen[m.file];
              const mongoMissing = !isFiles && !info.mongoSources.includes(m.source);
              return (
                <div key={m.file} className="field">
                  <label className="check check-block">
                    <input
                      type="checkbox"
                      checked={on}
                      disabled={mongoMissing}
                      onChange={(e) => setChosen({ ...chosen, [m.file]: e.target.checked ? (isFiles ? 'alternate' : 'original') : null })}
                    />
                    <span>
                      {isFiles ? (
                        <>
                          Folder <span className="mono">{m.path}</span>
                        </>
                      ) : (
                        <>
                          MongoDB <strong>{m.source}</strong>
                          {m.database ? ` (database ${m.database})` : ''}
                        </>
                      )}
                      <span className="muted small block">{bytes(m.sizeBytes)} compressed</span>
                    </span>
                  </label>
                  {isFiles && on && (
                    <div className="segmented" role="radiogroup" aria-label={`Where to restore ${m.path}`}>
                      <label className={chosen[m.file] === 'alternate' ? 'seg-on' : ''}>
                        <input type="radio" name={`t-${m.file}`} checked={chosen[m.file] === 'alternate'} onChange={() => setChosen({ ...chosen, [m.file]: 'alternate' })} /> Into a separate folder (safe)
                      </label>
                      <label className={chosen[m.file] === 'original' ? 'seg-on' : ''}>
                        <input type="radio" name={`t-${m.file}`} checked={chosen[m.file] === 'original'} disabled={m.current?.allowed === false} onChange={() => setChosen({ ...chosen, [m.file]: 'original' })} /> Over the current folder
                      </label>
                    </div>
                  )}
                  {isFiles && on && chosen[m.file] === 'original' && m.current?.exists && (
                    <div className="alert alert-warn small">
                      <strong>This overwrites live files.</strong> <span className="mono">{m.path}</span> already has {m.current.entries} item{m.current.entries === 1 ? '' : 's'}. Files with the same names are replaced by the backed-up versions; files that only exist on the server are left alone.
                    </div>
                  )}
                  {isFiles && on && chosen[m.file] === 'original' && m.current && !m.current.exists && <div className="muted small">The folder doesn't exist now; it will be created.</div>}
                  {isFiles && on && chosen[m.file] === 'alternate' && <div className="muted small">Files go into a new folder inside the server's backup directory so you can look first and copy what you need. The result shows where.</div>}
                  {mongoMissing && <div className="text-warn small">This plan no longer has a connection string for “{m.source}”. Add the MongoDB source to the plan first.</div>}
                </div>
              );
            })}
          </div>

          {mongoSelected.length > 0 && (
            <>
              <label className="check check-block">
                <input type="checkbox" checked={drop} onChange={(e) => setDrop(e.target.checked)} />
                <span>
                  Replace existing collections (drop each one before restoring it)
                  <span className="muted small block">Without this, documents that already exist are skipped and the rest are added.</span>
                </span>
              </label>
              <div className="alert alert-warn small">
                <strong>MongoDB data is written back into the live database.</strong> {drop ? 'Collections in the backup are dropped first, so changes made since the backup are lost.' : 'Existing documents with the same _id are kept as they are.'}
              </div>
            </>
          )}

          {(overwriting.length > 0 || mongoSelected.length > 0) && (
            <p className="muted small">Tip: take a fresh backup first (close this and click “Back up now”) so you can undo this restore.</p>
          )}

          <div className="field">
            <label htmlFor="restore-confirm">
              Type <strong>{plan.name}</strong> to confirm
            </label>
            <input id="restore-confirm" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} />
          </div>
          {err && (
            <div className="alert alert-error">
              <pre className="pre-plain">{err.message}</pre>
            </div>
          )}
          <div className="btn-row">
            <button className="btn btn-primary" disabled={busy || selected.length === 0 || confirm !== plan.name} onClick={start}>
              {busy ? 'Starting…' : `Restore ${selected.length} item${selected.length === 1 ? '' : 's'}`}
            </button>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
          </div>
        </>
      )}
      {runId !== null && (
        <>
          <RunWatcher runId={runId} onFinished={onFinished} />
          <button className="btn" onClick={onClose}>
            Close
          </button>
        </>
      )}
    </section>
  );
}

export function PlanDetailPage({ name, navigate }: { name: string; navigate: (p: string) => void }) {
  const { data, error, reload } = useBackups();
  const plan = data?.plans.find((p) => p.name === name);
  const [artifacts, setArtifacts] = useState<{ local: ArtifactInfo[]; remote: ArtifactInfo[] | null; remoteError: string | null; hasRemote: boolean } | null>(null);
  const [artifactsErr, setArtifactsErr] = useState<string | null>(null);
  const [watching, setWatching] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [restoring, setRestoring] = useState<{ where: 'local' | 'remote'; artifact: ArtifactInfo } | null>(null);
  const [confirm, setConfirm] = useState('');

  const loadArtifacts = useCallback(async () => {
    try {
      setArtifacts(await api.artifacts(name));
      setArtifactsErr(null);
    } catch (e) {
      setArtifactsErr((e as ApiError).message);
    }
  }, [name]);
  useEffect(() => {
    if (plan) void loadArtifacts();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [!!plan, loadArtifacts]);

  // Pick up a task that is already running (started by the schedule, or before a page reload).
  useEffect(() => {
    if (watching === null && plan?.running) setWatching(plan.running.id);
  }, [plan?.running, watching]);

  const finished = useCallback(
    (_run: BackupRun) => {
      void reload();
      void loadArtifacts();
    },
    [reload, loadArtifacts],
  );

  const act = async (fn: () => Promise<{ run: BackupRun }>) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fn();
      setWatching(r.run.id);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const remove = async (where: 'local' | 'remote', a: ArtifactInfo) => {
    setBusy(true);
    setErr(null);
    try {
      await api.deleteBackup(name, where, a.name);
      await loadArtifacts();
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  if (data && !plan) {
    return (
      <>
        <Back to="/backups" label="Backups" navigate={navigate} />
        <div className="card empty">
          <h1>Not found</h1>
          <p className="muted">There is no backup plan named {name}.</p>
        </div>
      </>
    );
  }
  if (!plan || !data) return <div className="loading">{error ?? 'Loading…'}</div>;
  const history = data.runs.filter((r) => r.plan === name);
  const running = !!plan.running || busy;

  return (
    <>
      <Back to="/backups" label="Backups" navigate={navigate} />
      <div className="page-head">
        <div>
          <h1 className="title-row">
            {plan.name} {!plan.enabled && <span className="pill pill-muted">paused</span>}
          </h1>
          <p className="muted">
            {describeSources(plan)} · {scheduleLabel(plan.schedule)} · kept in {keptWhere(plan)}
          </p>
        </div>
        <div className="btn-row">
          <button className="btn" onClick={() => navigate(`/backups/plans/${plan.name}/edit`)}>
            Edit
          </button>
          <button className="btn btn-primary" disabled={running || !data.agent.available} onClick={() => act(() => api.runPlan(plan.name))}>
            {running ? 'Working…' : 'Back up now'}
          </button>
        </div>
      </div>
      {err && (
        <div className="alert alert-error">
          <pre className="pre-plain">{err.message}</pre>
        </div>
      )}
      {watching !== null && <RunWatcher key={watching} runId={watching} onFinished={finished} />}

      <div className="grid-2 section-gap section-gap-sm">
        <section className="card">
          <h2>What is backed up</h2>
          <dl className="kv">
            {plan.sources.map((s) =>
              s.type === 'files' ? (
                <FragmentRow key={s.name} label="Folder" value={<span className="mono">{s.path}</span>} note={s.exclude.length ? `skipping ${s.exclude.join(', ')}` : undefined} />
              ) : (
                <FragmentRow key={s.name} label="MongoDB" value={<span className="mono">{plan.mongo[s.name] ?? s.name}</span>} note={s.databases.length ? `databases: ${s.databases.join(', ')}` : 'all databases'} />
              ),
            )}
          </dl>
        </section>
        <section className="card">
          <h2>Schedule and retention</h2>
          <dl className="kv">
            <dt>Runs</dt>
            <dd>
              {scheduleLabel(plan.schedule)} <span className="muted small">({data.timezone})</span>
            </dd>
            <dt>Next run</dt>
            <dd>{plan.enabled && plan.nextRunAt ? dateTime(plan.nextRunAt) : '—'}</dd>
            <dt>Last good backup</dt>
            <dd>{plan.lastSuccessAt ? `${shortDate(plan.lastSuccessAt)} (${ago(plan.lastSuccessAt)})` : <span className="text-warn">none yet</span>}</dd>
            <dt>Keeps</dt>
            <dd>
              newest {plan.retention.keepLast}
              {plan.retention.maxAgeDays ? `, nothing older than ${plan.retention.maxAgeDays} days` : ''}
            </dd>
          </dl>
        </section>
      </div>

      {restoring && (
        <RestoreWizard
          key={`${restoring.where}-${restoring.artifact.name}`}
          plan={plan}
          where={restoring.where}
          artifact={restoring.artifact}
          onClose={() => setRestoring(null)}
          onFinished={finished}
        />
      )}

      {artifactsErr && <div className="alert alert-error">{artifactsErr}</div>}
      {artifacts && (
        <>
          {plan.keepLocal || artifacts.local.length > 0 ? (
            <ArtifactTable
              title="On this server"
              where="local"
              items={artifacts.local}
              busy={running}
              empty="No backups here yet."
              onRestore={(a) => setRestoring({ where: 'local', artifact: a })}
              onVerify={(a, deep) => act(() => api.verifyBackup(plan.name, 'local', a.name, deep))}
              onDelete={(a) => void remove('local', a)}
            />
          ) : null}
          {artifacts.hasRemote && (
            <>
              {artifacts.remoteError && <div className="alert alert-error">Could not read the cloud storage: {artifacts.remoteError}</div>}
              <ArtifactTable
                title={`In cloud storage (${plan.destination})`}
                where="remote"
                items={artifacts.remote ?? []}
                busy={running}
                empty={artifacts.remoteError ? 'Unavailable.' : 'No backups in the bucket yet.'}
                onRestore={(a) => setRestoring({ where: 'remote', artifact: a })}
                onVerify={(a, deep) => act(() => api.verifyBackup(plan.name, 'remote', a.name, deep))}
                onDelete={(a) => void remove('remote', a)}
              />
            </>
          )}
        </>
      )}

      <section className="card table-card section-gap">
        <div className="card-head card-head-pad">
          <h2>History</h2>
        </div>
        {history.length ? (
          <div className="table-scroll">
            <table className="table">
              <tbody>
                {history.slice(0, 15).map((r) => (
                  <tr key={r.id}>
                    <td className="small nowrap">{ago(r.startedAt, data.serverTime)}</td>
                    <td className="small">
                      {kindLabel(r.kind)}
                      {r.trigger === 'schedule' && <span className="muted"> · scheduled</span>}
                    </td>
                    <td>
                      <RunSummary run={r} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="empty-inline muted">Nothing has run yet.</div>
        )}
      </section>

      <section className="card card-danger section-gap">
        <h2>Delete plan</h2>
        <p className="muted small">Stops the schedule and forgets the settings. Backups already made — on this server and in the bucket — are not deleted.</p>
        <div className="field">
          <label htmlFor="confirm-plan">
            Type <strong>{plan.name}</strong> to confirm
          </label>
          <input id="confirm-plan" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} />
        </div>
        <button
          className="btn btn-danger"
          disabled={busy || running || confirm !== plan.name}
          onClick={async () => {
            try {
              await api.deletePlan(plan.name);
              navigate('/backups');
            } catch (e) {
              setErr(e as ApiError);
            }
          }}
        >
          Delete {plan.name}
        </button>
      </section>
    </>
  );
}

function FragmentRow({ label, value, note }: { label: string; value: React.ReactNode; note?: string }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>
        {value}
        {note && <div className="muted small">{note}</div>}
      </dd>
    </>
  );
}

// ---- cloud storage ---------------------------------------------------------------------

interface DestForm {
  name: string;
  endpoint: string;
  region: string;
  bucket: string;
  prefix: string;
  pathStyle: boolean;
  accessKeyId: string;
  secretAccessKey: string;
}

const PRESETS: { label: string; endpoint: string; region: string; pathStyle: boolean; hint: string }[] = [
  { label: 'Amazon S3', endpoint: 'https://s3.us-east-1.amazonaws.com', region: 'us-east-1', pathStyle: false, hint: 'Use the endpoint and region of your bucket, e.g. https://s3.eu-central-1.amazonaws.com and eu-central-1.' },
  { label: 'Cloudflare R2', endpoint: 'https://ACCOUNT_ID.r2.cloudflarestorage.com', region: 'auto', pathStyle: true, hint: 'Replace ACCOUNT_ID with your Cloudflare account ID. Create an API token with Object Read & Write.' },
  { label: 'Backblaze B2', endpoint: 'https://s3.us-west-004.backblazeb2.com', region: 'us-west-004', pathStyle: true, hint: 'Use the S3 endpoint shown on your bucket page, and its region.' },
  { label: 'Wasabi', endpoint: 'https://s3.wasabisys.com', region: 'us-east-1', pathStyle: true, hint: 'For other Wasabi regions use s3.REGION.wasabisys.com.' },
  { label: 'DigitalOcean Spaces', endpoint: 'https://nyc3.digitaloceanspaces.com', region: 'nyc3', pathStyle: false, hint: 'Use your Space’s region, e.g. fra1.digitaloceanspaces.com.' },
  { label: 'MinIO / other', endpoint: 'https://minio.example.com', region: 'us-east-1', pathStyle: true, hint: 'Any S3-compatible service. Plain http:// works only for servers on a private network.' },
];

function destForm(d?: BackupDestination): DestForm {
  return {
    name: d?.name ?? '',
    endpoint: d?.target.endpoint ?? '',
    region: d?.target.region ?? 'us-east-1',
    bucket: d?.target.bucket ?? '',
    prefix: d?.target.prefix ?? '',
    pathStyle: d?.target.pathStyle ?? true,
    accessKeyId: '',
    secretAccessKey: '',
  };
}

export function DestinationFormPage({ name, navigate }: { name?: string; navigate: (p: string) => void }) {
  const { data, error: loadError } = useBackups();
  const existing = name ? data?.destinations.find((d) => d.name === name) : undefined;
  const [form, setForm] = useState<DestForm | null>(name ? null : destForm());
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'test' | 'delete' | null>(null);
  const [err, setErr] = useState<ApiError | null>(null);
  const [tested, setTested] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');

  useEffect(() => {
    if (existing && !form) setForm(destForm(existing));
  }, [existing, form]);

  if (name && data && !existing) {
    return (
      <>
        <Back to="/backups" label="Backups" navigate={navigate} />
        <div className="card empty">
          <h1>Not found</h1>
          <p className="muted">There is no storage named {name}.</p>
        </div>
      </>
    );
  }
  if (!form || !data) return <div className="loading">{loadError ?? 'Loading…'}</div>;

  const set = (p: Partial<DestForm>) => setForm({ ...form, ...p });
  const input = () => {
    const target: S3Target = { endpoint: form.endpoint.trim(), region: form.region.trim(), bucket: form.bucket.trim(), prefix: form.prefix.trim(), pathStyle: form.pathStyle };
    return { ...(name ? {} : { name: form.name.trim() }), target, secrets: { accessKeyId: form.accessKeyId.trim(), secretAccessKey: form.secretAccessKey.trim() } };
  };
  const fieldErr = (f: string) => (err?.field === f ? <div className="field-error">{err.message}</div> : null);
  const cls = (f: string) => `field ${err?.field === f ? 'has-error' : ''}`;

  const test = async () => {
    setBusy('test');
    setErr(null);
    setTested(null);
    try {
      const r = await api.testDestination({ ...input(), ...(name ? { name } : {}) });
      setTested(`It works: a test file was written, read back and deleted (${r.ms} ms).`);
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
      if (name) await api.updateDestination(name, input());
      else await api.createDestination(input() as Required<ReturnType<typeof input>>);
      navigate('/backups');
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(null);
    }
  };

  const known = ['name', 'endpoint', 'region', 'bucket', 'prefix', 'accessKeyId', 'secretAccessKey', 'pathStyle'];
  return (
    <>
      <Back to="/backups" label="Backups" navigate={navigate} />
      <div className="page-head">
        <div>
          <h1>{name ? `Cloud storage: ${name}` : 'Add cloud storage'}</h1>
          <p className="muted">An S3-compatible bucket that holds an off-server copy of your backups.</p>
        </div>
      </div>
      <form onSubmit={save} className="grid-2 grid-form">
        <section className="card">
          <div className="form-grid">
            {!name && (
              <fieldset className="field">
                <legend>Provider</legend>
                <div className="chips">
                  {PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      className={`chip ${form.endpoint === p.endpoint ? 'chip-on' : ''}`}
                      onClick={() => {
                        set({ endpoint: p.endpoint, region: p.region, pathStyle: p.pathStyle });
                        setHint(p.hint);
                      }}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
                {hint && <div className="field-hint">{hint}</div>}
              </fieldset>
            )}
            <div className={cls('name')}>
              <label htmlFor="d-name">Name</label>
              <input id="d-name" className="mono" value={form.name} disabled={!!name} placeholder="offsite" spellCheck={false} onChange={(e) => set({ name: e.target.value.toLowerCase() })} />
              {fieldErr('name')}
            </div>
            <div className={cls('endpoint')}>
              <label htmlFor="d-endpoint">Endpoint</label>
              <input id="d-endpoint" className="mono" value={form.endpoint} placeholder="https://s3.eu-central-1.amazonaws.com" spellCheck={false} onChange={(e) => set({ endpoint: e.target.value })} />
              {fieldErr('endpoint')}
            </div>
            <div className={cls('region')}>
              <label htmlFor="d-region">Region</label>
              <input id="d-region" className="mono" value={form.region} spellCheck={false} onChange={(e) => set({ region: e.target.value })} />
              {fieldErr('region')}
            </div>
            <div className={cls('bucket')}>
              <label htmlFor="d-bucket">Bucket</label>
              <input id="d-bucket" className="mono" value={form.bucket} placeholder="my-server-backups" spellCheck={false} onChange={(e) => set({ bucket: e.target.value })} />
              <div className="field-hint">Create the bucket first, and keep it private.</div>
              {fieldErr('bucket')}
            </div>
            <div className={cls('prefix')}>
              <label htmlFor="d-prefix">Folder in the bucket (optional)</label>
              <input id="d-prefix" className="mono" value={form.prefix} placeholder="my-vps/" spellCheck={false} onChange={(e) => set({ prefix: e.target.value })} />
              <div className="field-hint">Useful when several servers share one bucket.</div>
              {fieldErr('prefix')}
            </div>
            <div className={cls('accessKeyId')}>
              <label htmlFor="d-key">Access key ID</label>
              <input id="d-key" className="mono" autoComplete="off" spellCheck={false} value={form.accessKeyId} placeholder={existing ? `${existing.keyHint} (saved)` : ''} onChange={(e) => set({ accessKeyId: e.target.value })} />
              {fieldErr('accessKeyId')}
            </div>
            <div className={cls('secretAccessKey')}>
              <label htmlFor="d-secret">Secret access key</label>
              <input id="d-secret" type="password" className="mono" autoComplete="new-password" value={form.secretAccessKey} placeholder={existing ? 'saved — leave blank to keep' : ''} onChange={(e) => set({ secretAccessKey: e.target.value })} />
              <div className="field-hint">Stored encrypted. Use a key that can only access this bucket.</div>
              {fieldErr('secretAccessKey')}
            </div>
            <label className="check check-block">
              <input type="checkbox" checked={form.pathStyle} onChange={(e) => set({ pathStyle: e.target.checked })} />
              <span>
                Path-style addressing
                <span className="muted small block">On for most providers (R2, B2, Wasabi, MinIO). Off for Amazon S3 and DigitalOcean Spaces.</span>
              </span>
            </label>
          </div>
        </section>
        <div className="col">
          <section className="card">
            <h2>Check it works</h2>
            <p className="muted small">Writes a tiny file to the bucket, reads it back and deletes it.</p>
            {tested && <div className="alert alert-ok">{tested}</div>}
            {err && !known.includes(err.field ?? '') && (
              <div className="alert alert-error">
                <pre className="pre-plain">{err.message}</pre>
              </div>
            )}
            <div className="btn-row">
              <button type="button" className="btn" disabled={busy !== null || !form.bucket || !form.endpoint} onClick={test}>
                {busy === 'test' ? 'Testing…' : 'Test connection'}
              </button>
              <button className="btn btn-primary" disabled={busy !== null || (!name && (!form.name || !form.accessKeyId || !form.secretAccessKey))}>
                {busy === 'save' ? 'Saving…' : name ? 'Save changes' : 'Add storage'}
              </button>
            </div>
            {existing?.lastTestAt && (
              <p className="muted small section-gap-sm">
                Last test {ago(existing.lastTestAt)}: {existing.lastTestOk ? 'worked' : 'failed'}. {existing.lastTestMessage}
              </p>
            )}
          </section>
          {existing && (
            <section className="card card-danger">
              <h2>Remove storage</h2>
              {existing.usedBy.length ? (
                <p className="muted small">Still used by {existing.usedBy.join(', ')}. Change those plans first.</p>
              ) : (
                <>
                  <p className="muted small">Forgets the connection. Files already in the bucket are not deleted.</p>
                  <div className="field">
                    <label htmlFor="confirm-dest">
                      Type <strong>{existing.name}</strong> to confirm
                    </label>
                    <input id="confirm-dest" value={confirm} autoComplete="off" onChange={(e) => setConfirm(e.target.value)} />
                  </div>
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={busy !== null || confirm !== existing.name}
                    onClick={async () => {
                      setBusy('delete');
                      try {
                        await api.deleteDestination(existing.name);
                        navigate('/backups');
                      } catch (e) {
                        setErr(e as ApiError);
                        setBusy(null);
                      }
                    }}
                  >
                    Remove {existing.name}
                  </button>
                </>
              )}
            </section>
          )}
        </div>
      </form>
    </>
  );
}

