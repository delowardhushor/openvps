import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type AgentInfo, type AppRecord, type Owner, type ProcessInfo } from '../api';
import { AppForm, initialForm, toSpec, type AppFormValue } from '../components/AppForm';
import { EnvEditor, rowsHaveErrors, type EnvRow } from '../components/EnvEditor';
import { LogViewer } from '../components/LogViewer';
import { ControlButtons, OwnerBadge, StatusBadge, memory, uptime } from '../components/ProcessBits';
import { AgentBanner } from './AppsPage';
import { dateTime } from '../format';

function useAgentInfo() {
  const [info, setInfo] = useState<AgentInfo | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  useEffect(() => {
    api
      .agent()
      .then((a) => (a.available ? setInfo(a.info) : setUnavailable(a.reason)))
      .catch((e: ApiError) => setUnavailable(e.message));
  }, []);
  return { info, unavailable };
}

function BackLink({ navigate }: { navigate: (p: string) => void }) {
  return (
    <a
      href="/apps"
      className="back"
      onClick={(e) => {
        e.preventDefault();
        navigate('/apps');
      }}
    >
      ← Applications
    </a>
  );
}

export function NewAppPage({ navigate }: { navigate: (p: string) => void }) {
  const { info, unavailable } = useAgentInfo();
  const [form, setForm] = useState<AppFormValue>(() => initialForm(null));
  const [env, setEnv] = useState<EnvRow[]>([{ key: 'PORT', value: '' }]);
  const [start, setStart] = useState(true);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);

  useEffect(() => {
    if (info) setForm((f) => ({ ...initialForm(info), name: f.name }));
  }, [info]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (rowsHaveErrors(env)) return;
    setBusy(true);
    setErr(null);
    const envObj = Object.fromEntries(env.filter((r) => r.key && !r.removed).map((r) => [r.key, r.value]));
    try {
      const r = await api.createApp(toSpec(form), envObj, start);
      navigate(`/apps/apps/${encodeURIComponent(r.app.name)}`);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <BackLink navigate={navigate} />
      <div className="page-head">
        <div>
          <h1>New application</h1>
          <p className="muted">Run a Node.js app from a folder on this server with PM2. It runs as the unprivileged apps user.</p>
        </div>
      </div>
      {unavailable && <AgentBanner reason={unavailable} />}
      <form onSubmit={submit} className="grid-2 grid-form">
        <section className="card">
          <h2>Application</h2>
          <AppForm info={info} value={form} onChange={setForm} error={err} />
        </section>
        <div className="col">
          <section className="card">
            <h2>Environment variables</h2>
            <p className="muted small">Stored encrypted. After saving, values can be replaced but not viewed.</p>
            <EnvEditor rows={env} onChange={setEnv} />
            {err?.field === 'env' && <div className="field-error">{err.message}</div>}
          </section>
          <section className="card">
            <label className="check">
              <input type="checkbox" checked={start} onChange={(e) => setStart(e.target.checked)} /> Start it now
            </label>
            {err && !['name', 'cwd', 'script', 'npmScript', 'runtime', 'args', 'execMode', 'instances', 'maxMemoryMb', 'env'].includes(err.field ?? '') && (
              <div className="alert alert-error section-gap-sm">{err.message}</div>
            )}
            <div className="btn-row section-gap-sm">
              <button className="btn btn-primary" disabled={busy || !info || !form.name || rowsHaveErrors(env)}>
                {busy ? (start ? 'Creating and starting…' : 'Creating…') : 'Create application'}
              </button>
              <button type="button" className="btn" onClick={() => navigate('/apps')}>
                Cancel
              </button>
            </div>
          </section>
        </div>
      </form>
    </>
  );
}

function ProcessFacts({ p, record }: { p: ProcessInfo | null; record: AppRecord | null }) {
  const now = Date.now();
  return (
    <dl className="kv">
      <dt>Status</dt>
      <dd>
        <StatusBadge status={p?.status ?? 'missing'} />
        {p && p.instances > 1 ? ` · ${p.instances} instances` : ''}
      </dd>
      <dt>Uptime</dt>
      <dd>{uptime(p, now)}</dd>
      <dt>CPU · Memory</dt>
      <dd>
        {p?.status === 'online' ? `${p.cpu}%` : '—'} · {memory(p)}
      </dd>
      <dt>Restarts</dt>
      <dd>
        {p ? p.restarts : '—'}
        {p && p.unstableRestarts > 0 ? <span className="text-warn"> ({p.unstableRestarts} unstable)</span> : null}
      </dd>
      <dt>Directory</dt>
      <dd className="mono">{record?.spec.cwd ?? p?.cwd ?? '—'}</dd>
      <dt>Runs</dt>
      <dd className="mono">
        {record ? (record.spec.startType === 'npm' ? `npm run ${record.spec.npmScript}` : record.spec.script) : (p?.script ?? '—')}
        {record && record.spec.args.length ? ` ${record.spec.args.join(' ')}` : ''}
      </dd>
      <dt>Node.js</dt>
      <dd className="mono">
        {p?.nodeVersion ? `v${p.nodeVersion.replace(/^v/, '')}` : ''} {record?.spec.runtime ?? p?.interpreter ?? ''}
      </dd>
      <dt>Mode</dt>
      <dd>{p?.execMode ?? record?.spec.execMode ?? '—'}</dd>
      {record?.lastAppliedAt && (
        <>
          <dt>Last applied</dt>
          <dd>{dateTime(record.lastAppliedAt)}</dd>
        </>
      )}
    </dl>
  );
}

export function AppDetailPage({ owner, name, navigate }: { owner: Owner; name: string; navigate: (p: string) => void }) {
  const { info } = useAgentInfo();
  const [proc, setProc] = useState<ProcessInfo | null>(null);
  const [record, setRecord] = useState<AppRecord | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [agentDown, setAgentDown] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<'logs' | 'env' | 'settings'>('logs');

  const load = useCallback(async () => {
    try {
      const all = await api.processes();
      if (!all.agent.available) setAgentDown(all.agent.reason);
      const list = owner === 'root' ? all.root.processes : all.apps.processes;
      setProc(list.find((p) => p.name === name) ?? null);
      setRecord(owner === 'apps' ? (await api.apps()).apps.find((a) => a.name === name) ?? null : null);
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setLoaded(true);
    }
  }, [owner, name]);

  useEffect(() => {
    void load();
    const t = setInterval(() => document.visibilityState !== 'hidden' && void load(), 5000);
    return () => clearInterval(t);
  }, [load]);

  const onMsg = (m: string | null, e: string | null) => {
    setMsg(m);
    setErr(e);
    void load();
  };

  if (loaded && !proc && !record && !agentDown) {
    return (
      <>
        <BackLink navigate={navigate} />
        <div className="card empty">
          <h1>Not found</h1>
          <p className="muted">There is no {owner === 'root' ? "root PM2 process" : 'application'} named {name}.</p>
        </div>
      </>
    );
  }

  const manageable = owner === 'apps' || (info?.root.manage ?? true);
  return (
    <>
      <BackLink navigate={navigate} />
      <div className="page-head">
        <div>
          <h1 className="title-row">
            {name} <OwnerBadge owner={owner} />
          </h1>
          <p className="muted">
            {owner === 'root'
              ? "An app already running under root's PM2. OpenVPS can control it but doesn't change its configuration."
              : 'Managed by OpenVPS. Runs as the apps user.'}
          </p>
        </div>
        <ControlButtons owner={owner} name={name} status={proc?.status ?? 'missing'} allowed={manageable} onDone={onMsg} />
      </div>
      {agentDown && <AgentBanner reason={agentDown} />}
      {msg && <div className="alert alert-ok" role="status">{msg}</div>}
      {err && <div className="alert alert-error" role="alert">{err}</div>}
      {record?.lastError && <div className="alert alert-error">Last start failed: {record.lastError}</div>}

      <div className="grid-detail">
        <section className="card">
          <h2>Process</h2>
          <ProcessFacts p={proc} record={record} />
        </section>
        <div className="col">
          {owner === 'apps' && record && (
            <div className="tabs tabs-page" role="tablist">
              {(['logs', 'env', 'settings'] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} className={`tab ${tab === t ? 'tab-active' : ''}`} onClick={() => setTab(t)}>
                  {t === 'logs' ? 'Logs' : t === 'env' ? `Environment (${record.envKeys.length})` : 'Settings'}
                </button>
              ))}
            </div>
          )}
          {(tab === 'logs' || !record) && (proc ? <LogViewer owner={owner} name={name} /> : <section className="card muted">Not running in PM2, so there are no logs to show. Start it to see output.</section>)}
          {tab === 'env' && record && <EnvPanel record={record} onSaved={(m) => onMsg(m, null)} />}
          {tab === 'settings' && record && <SettingsPanel record={record} info={info} onSaved={(m) => onMsg(m, null)} onDeleted={() => navigate('/apps')} />}
        </div>
      </div>
    </>
  );
}

function EnvPanel({ record, onSaved }: { record: AppRecord; onSaved: (m: string) => void }) {
  const fresh = (): EnvRow[] => record.envKeys.map((k) => ({ key: k, value: '', stored: true }));
  const [rows, setRows] = useState<EnvRow[]>(fresh);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => setRows(fresh()), [record.envKeys.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps

  const set: Record<string, string> = {};
  const unset: string[] = [];
  for (const r of rows) {
    if (r.removed && r.stored) unset.push(r.key);
    else if (!r.removed && r.key && (!r.stored || r.value !== '')) set[r.key] = r.value;
  }
  const dirty = unset.length > 0 || Object.keys(set).length > 0;

  const save = async (restart: boolean) => {
    setBusy(true);
    setErr(null);
    try {
      await api.updateEnv(record.name, set, unset, restart);
      onSaved(restart ? 'Environment saved and the app restarted.' : 'Environment saved. It applies on the next restart.');
    } catch (e) {
      setErr((e as ApiError).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card">
      <h2>Environment variables</h2>
      <p className="muted small">Encrypted at rest. Stored values are never displayed; type a new value to replace one.</p>
      <EnvEditor rows={rows} onChange={setRows} />
      {err && <div className="alert alert-error section-gap-sm">{err}</div>}
      <div className="btn-row section-gap-sm">
        <button className="btn btn-primary" disabled={busy || !dirty || rowsHaveErrors(rows)} onClick={() => void save(true)}>
          {busy ? 'Saving…' : 'Save and restart'}
        </button>
        <button className="btn" disabled={busy || !dirty || rowsHaveErrors(rows)} onClick={() => void save(false)}>
          Save only
        </button>
        {dirty && (
          <button className="btn" disabled={busy} onClick={() => setRows(fresh())}>
            Discard
          </button>
        )}
      </div>
    </section>
  );
}

function SettingsPanel({ record, info, onSaved, onDeleted }: { record: AppRecord; info: AgentInfo | null; onSaved: (m: string) => void; onDeleted: () => void }) {
  const [form, setForm] = useState<AppFormValue>(() => initialForm(info, record.spec));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<ApiError | null>(null);
  const [confirm, setConfirm] = useState('');

  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.updateApp(record.name, toSpec(form), true);
      onSaved('Settings saved and the app restarted.');
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteApp(record.name);
      onDeleted();
    } catch (e) {
      setErr(e as ApiError);
      setBusy(false);
    }
  };

  return (
    <>
      <section className="card">
        <h2>Settings</h2>
        <AppForm info={info} value={form} onChange={setForm} nameLocked error={err} />
        {err && !err.field && <div className="alert alert-error">{err.message}</div>}
        <button className="btn btn-primary" disabled={busy} onClick={() => void save()}>
          {busy ? 'Saving…' : 'Save and restart'}
        </button>
      </section>
      <section className="card card-danger">
        <h2>Delete application</h2>
        <p className="muted small">
          Stops it and removes it from PM2 and OpenVPS. The files in <code>{record.spec.cwd}</code> are not deleted.
        </p>
        <div className="field">
          <label htmlFor="confirm-delete">
            Type <strong>{record.name}</strong> to confirm
          </label>
          <input id="confirm-delete" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" />
        </div>
        <button className="btn btn-danger" disabled={busy || confirm !== record.name} onClick={() => void remove()}>
          Delete {record.name}
        </button>
      </section>
    </>
  );
}
