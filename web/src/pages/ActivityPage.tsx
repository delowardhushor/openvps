import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type AuditEntry } from '../api';
import { actionLabel, dateTime, reasonLabel } from '../format';

const FILTERS = [
  { value: '', label: 'All activity' },
  { value: 'auth.', label: 'Authentication' },
  { value: 'setup.', label: 'Setup' },
  { value: 'cli.', label: 'Command line' },
];

function detailsText(d: AuditEntry['details']): string {
  if (!d) return '';
  return Object.entries(d)
    .map(([k, v]) => `${k.replace(/([A-Z])/g, ' $1').toLowerCase()}: ${k === 'reason' ? reasonLabel(v) : String(v)}`)
    .join(' · ');
}

export function ActivityPage() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [next, setNext] = useState<number | null>(null);
  const [action, setAction] = useState('');
  const [failuresOnly, setFailuresOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(
    async (before?: number) => {
      setLoading(true);
      try {
        const r = await api.audit({ limit: 50, before, action, outcome: failuresOnly ? 'failure' : undefined });
        setEntries((cur) => (before ? [...cur, ...r.entries] : r.entries));
        setNext(r.nextBefore);
        setError(null);
      } catch (e) {
        setError((e as ApiError).message);
      } finally {
        setLoading(false);
      }
    },
    [action, failuresOnly],
  );

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Activity log</h1>
          <p className="muted">Sign-ins and administrative operations on this server. Secrets are never recorded.</p>
        </div>
      </div>
      <div className="toolbar">
        <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by category">
          {FILTERS.map((f) => (
            <option key={f.value} value={f.value}>
              {f.label}
            </option>
          ))}
        </select>
        <label className="check">
          <input type="checkbox" checked={failuresOnly} onChange={(e) => setFailuresOnly(e.target.checked)} /> Failures only
        </label>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <section className="card table-card">
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Time</th>
                <th>Event</th>
                <th>Result</th>
                <th>User</th>
                <th>IP address</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {entries.map((e) => (
                <tr key={e.id}>
                  <td className="nowrap">{dateTime(e.ts)}</td>
                  <td>
                    {actionLabel(e.action)}
                    {e.target && e.target !== e.actor && <div className="muted small">{e.target}</div>}
                  </td>
                  <td>
                    <span className={`pill pill-${e.outcome}`}>{e.outcome}</span>
                  </td>
                  <td>{e.actor ?? <span className="muted">—</span>}</td>
                  <td><code>{e.ip ?? '—'}</code></td>
                  <td className="muted small">{detailsText(e.details)}</td>
                </tr>
              ))}
              {!loading && entries.length === 0 && (
                <tr>
                  <td colSpan={6} className="muted center">No matching events.</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        {next && (
          <div className="table-foot">
            <button className="btn" onClick={() => void load(next)} disabled={loading}>
              Load older events
            </button>
          </div>
        )}
      </section>
    </>
  );
}
