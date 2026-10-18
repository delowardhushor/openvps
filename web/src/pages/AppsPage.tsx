import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type ProcessesResponse, type ProcessInfo } from '../api';
import { ControlButtons, OwnerBadge, StatusBadge, memory, uptime } from '../components/ProcessBits';

export function useProcesses(intervalMs = 5000) {
  const [data, setData] = useState<ProcessesResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setData(await api.processes());
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    void load();
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, intervalMs);
    return () => clearInterval(t);
  }, [load, intervalMs]);
  return { data, error, reload: load };
}

export function AgentBanner({ reason }: { reason: string | null }) {
  return (
    <div className="alert alert-warn">
      <strong>The OpenVPS agent is not running</strong>, so applications can't be listed or controlled.
      <div className="small">
        On the server, run <code>sudo openvps provision</code> (needed once after upgrading from v0.1), then reload this page.
        {reason ? <> Details: {reason}</> : null}
      </div>
    </div>
  );
}

interface Row {
  key: string;
  name: string;
  owner: ProcessInfo['owner'];
  proc: ProcessInfo | null;
  registered: boolean;
  detail: string | null;
  lastError: string | null;
}

function ProcessTable({ rows, manageRoot, navigate, onMsg, now }: { rows: Row[]; manageRoot: boolean; navigate: (p: string) => void; onMsg: (m: string | null, e: string | null) => void; now: number }) {
  return (
    <div className="table-scroll">
      <table className="table table-hover">
        <thead>
          <tr>
            <th>Name</th>
            <th>Status</th>
            <th className="num hide-sm">CPU</th>
            <th className="num hide-sm">Memory</th>
            <th className="num hide-sm">Uptime</th>
            <th className="num hide-sm">Restarts</th>
            <th aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const href = `/apps/${r.owner}/${encodeURIComponent(r.name)}`;
            return (
              <tr key={r.key} onClick={() => navigate(href)} className="clickable">
                <td>
                  <a
                    href={href}
                    className="row-link"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      navigate(href);
                    }}
                  >
                    {r.name}
                  </a>
                  {r.detail && <div className="muted small mono ellipsis" title={r.detail}>{r.detail}</div>}
                  {r.lastError && <div className="text-fail small">{r.lastError}</div>}
                </td>
                <td>
                  <StatusBadge status={r.proc?.status ?? 'missing'} />
                  {r.proc && r.proc.instances > 1 && <span className="muted small"> ×{r.proc.instances}</span>}
                </td>
                <td className="num hide-sm">{r.proc?.status === 'online' ? `${r.proc.cpu}%` : '—'}</td>
                <td className="num hide-sm">{memory(r.proc)}</td>
                <td className="num hide-sm">{uptime(r.proc, now)}</td>
                <td className="num hide-sm">
                  {r.proc ? (
                    <span className={r.proc.unstableRestarts > 0 || r.proc.restarts > 10 ? 'text-warn' : ''}>{r.proc.restarts}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="actions" onClick={(e) => e.stopPropagation()}>
                  <ControlButtons owner={r.owner} name={r.name} status={r.proc?.status ?? 'missing'} allowed={r.owner === 'apps' || manageRoot} onDone={onMsg} compact />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function AppsPage({ navigate }: { navigate: (p: string) => void }) {
  const { data, error, reload } = useProcesses();
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [manageRoot, setManageRoot] = useState(true);
  const now = Date.now();

  useEffect(() => {
    api
      .agent()
      .then((a) => setManageRoot(a.available ? a.info.root.manage : false))
      .catch(() => undefined);
  }, []);

  const onMsg = (m: string | null, e: string | null) => {
    setMsg(m);
    setErr(e);
    void reload();
  };

  const managed: Row[] = data
    ? [
        ...data.registered.map((a) => ({
          key: `apps:${a.name}`,
          name: a.name,
          owner: 'apps' as const,
          proc: a.process,
          registered: true,
          detail: a.spec.startType === 'npm' ? `npm run ${a.spec.npmScript} · ${a.spec.cwd}` : `${a.spec.script} · ${a.spec.cwd}`,
          lastError: a.lastError,
        })),
        // Processes in the apps PM2 that are not registered (e.g. started by hand) still show up.
        ...data.apps.processes
          .filter((p) => !data.registered.some((a) => a.name === p.name))
          .map((p) => ({ key: `apps:${p.name}`, name: p.name, owner: 'apps' as const, proc: p, registered: false, detail: p.script, lastError: null })),
      ]
    : [];
  const rootRows: Row[] = data
    ? data.root.processes.map((p) => ({ key: `root:${p.name}`, name: p.name, owner: 'root' as const, proc: p, registered: false, detail: p.cwd ?? p.script, lastError: null }))
    : [];

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Applications</h1>
          <p className="muted">Node.js apps managed with PM2 on this server.</p>
        </div>
        <button className="btn btn-primary" onClick={() => navigate('/apps/new')} disabled={!data?.agent.available}>
          New application
        </button>
      </div>

      {error && <div className="alert alert-error">{error}</div>}
      {data && !data.agent.available && <AgentBanner reason={data.agent.reason} />}
      {msg && <div className="alert alert-ok" role="status">{msg}</div>}
      {err && <div className="alert alert-error" role="alert">{err}</div>}
      {!data && !error && <div className="loading">Loading applications…</div>}

      {data?.agent.available && (
        <>
          <section className="card table-card section-gap">
            <div className="card-head card-head-pad">
              <h2>
                Managed by OpenVPS <OwnerBadge owner="apps" />
              </h2>
              <span className="muted small">Runs as the unprivileged <code>ovapps</code> user</span>
            </div>
            {managed.length ? (
              <ProcessTable rows={managed} manageRoot={manageRoot} navigate={navigate} onMsg={onMsg} now={now} />
            ) : (
              <div className="empty-inline">
                <p>No applications yet.</p>
                <p className="muted small">
                  Put your app's code in a folder under <code>/srv/apps</code> (for example with <code>git clone</code>), then add it here.
                  Git deployments from the panel arrive in the next release.
                </p>
                <button className="btn btn-primary" onClick={() => navigate('/apps/new')}>
                  Add your first application
                </button>
              </div>
            )}
          </section>

          <section className="card table-card section-gap">
            <div className="card-head card-head-pad">
              <h2>
                Existing PM2 apps <OwnerBadge owner="root" />
              </h2>
              <span className="muted small">
                {manageRoot ? 'Already running under root. You can start, stop, restart, reload and read logs.' : 'Read-only (disabled in configuration).'}
              </span>
            </div>
            {!data.root.status.available ? (
              <div className="empty-inline muted">{data.root.status.reason ?? 'PM2 for root is not available.'}</div>
            ) : rootRows.length ? (
              <ProcessTable rows={rootRows} manageRoot={manageRoot} navigate={navigate} onMsg={onMsg} now={now} />
            ) : (
              <div className="empty-inline muted">Root's PM2 has no processes.</div>
            )}
          </section>
        </>
      )}
    </>
  );
}
