export function bytes(n: number, digits = 1): string {
  if (!Number.isFinite(n)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  let v = Math.abs(n);
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${(n < 0 ? -v : v).toFixed(i === 0 ? 0 : digits)} ${units[i]}`;
}

export function rate(bytesPerSec: number): string {
  return `${bytes(bytesPerSec)}/s`;
}

export function pct(n: number): string {
  return `${n.toFixed(n >= 10 || n === 0 ? 0 : 1)}%`;
}

export function duration(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

export function ago(ts: number, now = Date.now()): string {
  const s = Math.round((now - ts) / 1000);
  if (s < 5) return 'just now';
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function dateTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

/** Human labels for audit actions. Unknown actions fall back to the raw name. */
const ACTIONS: Record<string, string> = {
  'auth.login': 'Sign-in',
  'auth.logout': 'Sign-out',
  'auth.password_change': 'Password change',
  'auth.session_revoke': 'Session revoked',
  'setup.admin_create': 'Initial setup',
  'cli.password_reset': 'Password reset (CLI)',
  'cli.unlock': 'Account unlocked (CLI)',
  'cli.revoke_sessions': 'Sessions revoked (CLI)',
  'cli.admin_create': 'Administrator created (CLI)',
};

export function actionLabel(a: string): string {
  return ACTIONS[a] ?? a;
}

const REASONS: Record<string, string> = {
  bad_password: 'wrong password',
  unknown_user: 'unknown user',
  locked: 'account locked',
  ip_rate_limited: 'too many attempts from this IP',
  invalid_setup_token: 'invalid setup token',
  bad_current_password: 'wrong current password',
};

export function reasonLabel(r: unknown): string | null {
  return typeof r === 'string' ? (REASONS[r] ?? r.replace(/_/g, ' ')) : null;
}

export function shortUserAgent(ua: string | null): string {
  if (!ua) return 'Unknown client';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : /curl\//.test(ua) ? 'curl' : null;
  const os = /Windows/.test(ua) ? 'Windows' : /Mac OS X/.test(ua) ? 'macOS' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 40);
}
