import { useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from 'react';
import { api, ApiError, type User } from '../api';

function AuthCard({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
  return (
    <div className="auth-wrap">
      <div className="auth-card">
        <div className="auth-brand">
          <img src="/favicon.svg" alt="" width={36} height={36} />
          <span>OpenVPS</span>
        </div>
        <h1>{title}</h1>
        <p className="muted">{subtitle}</p>
        {children}
      </div>
    </div>
  );
}

export function Field({
  label,
  hint,
  error,
  ...input
}: { label: string; hint?: ReactNode; error?: string | null } & InputHTMLAttributes<HTMLInputElement>) {
  const id = input.id ?? input.name;
  return (
    <div className={`field ${error ? 'has-error' : ''}`}>
      <label htmlFor={id}>{label}</label>
      <input id={id} aria-invalid={!!error} aria-describedby={hint || error ? `${id}-hint` : undefined} {...input} />
      {(error || hint) && (
        <div className={error ? 'field-error' : 'field-hint'} id={`${id}-hint`}>
          {error ?? hint}
        </div>
      )}
    </div>
  );
}

function errorFor(err: ApiError | null, field: string): string | null {
  return err && err.field === field ? err.message : null;
}

export function SetupPage({ onDone, minLength = 12 }: { onDone: (u: User) => void; minLength?: number }) {
  const [token, setToken] = useState('');
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);
  const mismatch = confirm.length > 0 && confirm !== password;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.setup(token.trim(), username.trim(), password);
      onDone(r.user);
    } catch (e) {
      setErr(e as ApiError);
    } finally {
      setBusy(false);
    }
  };

  const generalError = err && !err.field ? err.message : null;

  return (
    <AuthCard
      title="Set up your panel"
      subtitle="Create the administrator account. This only happens once."
    >
      <div className="callout">
        <strong>Where is the setup token?</strong> It was printed at the end of installation. You can show it again on the
        server with:
        <code className="cmd">sudo openvps setup-token</code>
      </div>
      <form onSubmit={submit} noValidate>
        <Field
          label="Setup token"
          name="setupToken"
          autoComplete="off"
          spellCheck={false}
          value={token}
          onChange={(e) => setToken(e.target.value)}
          error={errorFor(err, 'setupToken')}
          required
          autoFocus
        />
        <Field
          label="Username"
          name="username"
          autoComplete="username"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          error={errorFor(err, 'username')}
          hint="3–32 characters: letters, digits, dot, dash or underscore."
          required
        />
        <Field
          label="Password"
          name="password"
          type="password"
          autoComplete="new-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          error={errorFor(err, 'password')}
          hint={`At least ${minLength} characters. A passphrase of several words works well.`}
          required
        />
        <Field
          label="Confirm password"
          name="confirm"
          type="password"
          autoComplete="new-password"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          error={mismatch ? 'Passwords do not match.' : null}
          required
        />
        {generalError && <div className="alert alert-error" role="alert">{generalError}</div>}
        <button className="btn btn-primary btn-block" disabled={busy || !token || !password || mismatch}>
          {busy ? 'Creating account…' : 'Create administrator'}
        </button>
      </form>
    </AuthCard>
  );
}

export function LoginPage({ onDone, notice }: { onDone: (u: User) => void; notice?: string | null }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState<ApiError | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr(null);
    try {
      const r = await api.login(username.trim(), password);
      onDone(r.user);
    } catch (e) {
      setErr(e as ApiError);
      setPassword('');
    } finally {
      setBusy(false);
    }
  };

  let message = err?.message ?? null;
  if (err?.retryAfterSeconds) message += ` Try again in ${Math.ceil(err.retryAfterSeconds / 60)} min.`;

  return (
    <AuthCard title="Sign in" subtitle="Manage this server from your browser.">
      {notice && <div className="alert alert-info">{notice}</div>}
      <form onSubmit={submit}>
        <Field label="Username" name="username" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
        <Field label="Password" name="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required />
        {message && <div className="alert alert-error" role="alert">{message}</div>}
        <button className="btn btn-primary btn-block" disabled={busy || !username || !password}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
      <p className="muted small auth-foot">
        Forgot your password? Run <code>sudo openvps reset-password &lt;username&gt;</code> on the server.
      </p>
    </AuthCard>
  );
}
