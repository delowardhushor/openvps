import { useState, type ReactNode } from 'react';
import type { User } from '../api';

interface NavItem {
  path: string;
  label: string;
  icon: ReactNode;
  phase?: number;
}

const I = {
  grid: <path d="M3 3h7v7H3zM14 3h7v7h-7zM3 14h7v7H3zM14 14h7v7h-7z" />,
  box: <path d="M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8" />,
  rocket: <path d="M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2m-1-4 3 3m8.5-12.5c-3 0-7 2-9.5 6.5l3 3C16.5 12 18.5 8 18.5 5.5zM15 9h.01" />,
  globe: <path d="M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM3 12h18M12 3c2.5 2.5 3.5 5.5 3.5 9s-1 6.5-3.5 9c-2.5-2.5-3.5-5.5-3.5-9s1-6.5 3.5-9z" />,
  lock: <path d="M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4" />,
  db: <path d="M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />,
  archive: <path d="M3 4h18v4H3zM5 8v12h14V8M10 12h4" />,
  list: <path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" />,
  gear: <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />,
  out: <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9" />,
  menu: <path d="M3 6h18M3 12h18M3 18h18" />,
};

export function Icon({ children }: { children: ReactNode }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const NAV: NavItem[] = [
  { path: '/', label: 'Overview', icon: I.grid },
  { path: '/apps', label: 'Applications', icon: I.box },
  { path: '/deployments', label: 'Deployments', icon: I.rocket, phase: 2 },
  { path: '/sites', label: 'Sites & domains', icon: I.globe },
  { path: '/certificates', label: 'SSL certificates', icon: I.lock },
  { path: '/databases', label: 'Databases', icon: I.db },
  { path: '/backups', label: 'Backups', icon: I.archive },
  { path: '/activity', label: 'Activity log', icon: I.list },
  { path: '/settings', label: 'Settings', icon: I.gear },
];

export function Layout({
  path,
  navigate,
  user,
  hostname,
  onLogout,
  children,
}: {
  path: string;
  navigate: (to: string) => void;
  user: User;
  hostname: string | null;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`shell ${open ? 'nav-open' : ''}`}>
      <aside className="sidebar">
        <div className="brand">
          <img src="/favicon.svg" alt="" width={26} height={26} />
          <div>
            <div className="brand-name">OpenVPS</div>
            {hostname && <div className="brand-host" title={hostname}>{hostname}</div>}
          </div>
        </div>
        <nav aria-label="Main">
          {NAV.map((n) => {
            const active = n.path === '/' ? path === '/' : path.startsWith(n.path);
            return (
              <a
                key={n.path}
                href={n.path}
                className={`nav-item ${active ? 'active' : ''} ${n.phase ? 'soon' : ''}`}
                aria-current={active ? 'page' : undefined}
                onClick={(e) => {
                  e.preventDefault();
                  setOpen(false);
                  navigate(n.path);
                }}
              >
                <Icon>{n.icon}</Icon>
                <span>{n.label}</span>
                {n.phase && <span className="badge-soon">Soon</span>}
              </a>
            );
          })}
        </nav>
        <div className="sidebar-foot">
          <div className="who">
            <span className="avatar" aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span>
            <span className="who-name">{user.username}</span>
          </div>
          <button className="btn-icon" onClick={onLogout} title="Sign out" aria-label="Sign out">
            <Icon>{I.out}</Icon>
          </button>
        </div>
      </aside>
      <div className="scrim" onClick={() => setOpen(false)} />
      <div className="main">
        <header className="topbar-mobile">
          <button className="btn-icon" onClick={() => setOpen(true)} aria-label="Open menu">
            <Icon>{I.menu}</Icon>
          </button>
          <span className="brand-name">OpenVPS</span>
        </header>
        <main className="content">{children}</main>
      </div>
    </div>
  );
}

export function ComingSoon({ title, phase, children }: { title: string; phase: number; children: ReactNode }) {
  return (
    <>
      <div className="page-head">
        <h1>{title}</h1>
      </div>
      <section className="card empty">
        <div className="empty-phase">Planned for phase {phase}</div>
        <p>{children}</p>
        <p className="muted">
          This module is not part of the current release. Track progress in the project roadmap on GitHub.
        </p>
      </section>
    </>
  );
}
