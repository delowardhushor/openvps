import { useCallback, useEffect, useState } from 'react';
import { api, onUnauthenticated, type User } from './api';
import { useRoute } from './router';
import { ComingSoon, Layout } from './components/Layout';
import { LoginPage, SetupPage } from './pages/AuthPages';
import { DashboardPage } from './pages/DashboardPage';
import { ActivityPage } from './pages/ActivityPage';
import { SettingsPage } from './pages/SettingsPage';

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'setup' }
  | { kind: 'login'; notice?: string }
  | { kind: 'app'; user: User };

export function App() {
  const [state, setState] = useState<State>({ kind: 'loading' });
  const [path, navigate] = useRoute();
  const [hostname, setHostname] = useState<string | null>(null);

  const boot = useCallback(async () => {
    try {
      const s = await api.setupStatus();
      if (s.needsSetup) return setState({ kind: 'setup' });
      try {
        const me = await api.me();
        setState({ kind: 'app', user: me.user });
      } catch {
        setState({ kind: 'login' });
      }
    } catch (e) {
      setState({ kind: 'error', message: (e as Error).message });
    }
  }, []);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(
    () =>
      onUnauthenticated(() =>
        setState((s) => (s.kind === 'app' ? { kind: 'login', notice: 'Your session has ended. Please sign in again.' } : s)),
      ),
    [],
  );

  useEffect(() => {
    document.title = hostname ? `${hostname} · OpenVPS` : 'OpenVPS';
  }, [hostname]);

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      setState({ kind: 'login', notice: 'You have been signed out.' });
    }
  };

  switch (state.kind) {
    case 'loading':
      return <div className="loading full">Loading…</div>;
    case 'error':
      return (
        <div className="auth-wrap">
          <div className="auth-card">
            <h1>Cannot reach OpenVPS</h1>
            <p className="muted">{state.message}</p>
            <button className="btn btn-primary" onClick={() => void boot()}>
              Retry
            </button>
          </div>
        </div>
      );
    case 'setup':
      return (
        <SetupPage
          onDone={(user) => {
            navigate('/');
            setState({ kind: 'app', user });
          }}
        />
      );
    case 'login':
      return <LoginPage notice={state.notice} onDone={(user) => setState({ kind: 'app', user })} />;
    case 'app':
      return (
        <Layout path={path} navigate={navigate} user={state.user} hostname={hostname} onLogout={() => void logout()}>
          <Page path={path} user={state.user} onHost={setHostname} />
        </Layout>
      );
  }
}

function Page({ path, user, onHost }: { path: string; user: User; onHost: (h: string) => void }) {
  if (path === '/' || path === '') return <DashboardPage onHost={onHost} />;
  if (path.startsWith('/activity')) return <ActivityPage />;
  if (path.startsWith('/settings')) return <SettingsPage user={user} />;
  if (path.startsWith('/apps'))
    return <ComingSoon title="Applications" phase={2}>Register Node.js applications, manage environment variables, and start, stop or restart them through PM2.</ComingSoon>;
  if (path.startsWith('/deployments'))
    return <ComingSoon title="Deployments" phase={2}>Deploy from a Git branch with dependency install, build steps, release history and rollback.</ComingSoon>;
  if (path.startsWith('/sites'))
    return <ComingSoon title="Sites & domains" phase={3}>Create validated Nginx reverse-proxy sites and attach domains to applications.</ComingSoon>;
  if (path.startsWith('/certificates'))
    return <ComingSoon title="SSL certificates" phase={3}>Issue and renew Let&apos;s Encrypt certificates and watch expiry dates.</ComingSoon>;
  if (path.startsWith('/backups'))
    return <ComingSoon title="Backups" phase={4}>Schedule MongoDB and file backups to off-server storage, with retention and tested restores.</ComingSoon>;
  return (
    <div className="card empty">
      <h1>Page not found</h1>
      <p className="muted">There is nothing at {path}.</p>
    </div>
  );
}
