import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, type SessionInfo, type User } from '../api';
import { ago, dateTime, shortUserAgent } from '../format';
import { Field } from './AuthPages';

export function SettingsPage({ user }: { user: User }) {
  return (
    <>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p className="muted">Signed in as {user.username}.</p>
        </div>
      </div>
      <div className="grid-2">
        <div className="col">
          <PasswordForm />
        </div>
        <div className="col">
          <SessionList />
          <section className="card">
            <h2>Recovery</h2>
            <p className="muted">If you lose access to the panel, run these on the server over SSH:</p>
            <dl className="kv kv-cmd">
              <dt>Reset a password</dt>
              <dd><code>sudo openvps reset-password {user.username}</code></dd>
              <dt>Unlock after failed logins</dt>
              <dd><code>sudo openvps unlock {user.username}</code></dd>
              <dt>Sign out everyone</dt>
              <dd><code>sudo openvps revoke-sessions</code></dd>
            </dl>
          </section>
        </div>
      </div>
    </>
  );
}

function PasswordForm() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<ApiError | null>(null);
  const [ok, setOk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== next;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setErr(null);
    setOk(null);
    try {
      const r = await api.changePassword(current, next);
      setOk(
        r.otherSessionsRevoked
          ? `Password changed. ${r.otherSessionsRevoked} other session(s) were signed out.`
          : 'Password changed.',
      );
      setCurrent('');
      setNext('');
      setConfirm('');
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const fieldErr = (f: string) => (err?.field === f ? err.message : null);
  return (
    <section className="card">
      <h2>Change password</h2>
      <form onSubmit={submit}>
        <Field label="Current password" name="currentPassword" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} error={fieldErr('currentPassword')} required />
        <Field label="New password" name="newPassword" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} error={fieldErr('newPassword') ?? fieldErr('password')} hint="At least 12 characters. Other sessions will be signed out." required />
        <Field label="Confirm new password" name="confirmPassword" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} error={mismatch ? 'Passwords do not match.' : null} required />
        {err && !err.field && <div className="alert alert-error">{err.message}</div>}
        {ok && <div className="alert alert-ok" role="status">{ok}</div>}
        <button className="btn btn-primary" disabled={busy || !current || !next || mismatch}>
          {busy ? 'Saving…' : 'Change password'}
        </button>
      </form>
    </section>
  );
}

function SessionList() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setSessions((await api.sessions()).sessions);
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const revoke = async (id: string) => {
    try {
      await api.revokeSession(id);
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    }
  };
  const revokeOthers = async () => {
    try {
      await api.revokeOtherSessions();
      await load();
    } catch (e) {
      setError((e as ApiError).message);
    }
  };
  const others = sessions.filter((s) => !s.current).length;

  return (
    <section className="card">
      <div className="card-head">
        <h2>Active sessions</h2>
        {others > 0 && (
          <button className="btn btn-small" onClick={revokeOthers}>
            Sign out other sessions
          </button>
        )}
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <ul className="sessions">
        {sessions.map((s) => (
          <li key={s.id}>
            <div>
              <div>
                {shortUserAgent(s.userAgent)} {s.current && <span className="pill pill-success">This browser</span>}
              </div>
              <div className="muted small">
                <code>{s.ip ?? 'unknown IP'}</code> · signed in {dateTime(s.createdAt)} · active {ago(s.lastSeenAt)}
              </div>
            </div>
            {!s.current && (
              <button className="btn btn-small" onClick={() => void revoke(s.id)}>
                Sign out
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
