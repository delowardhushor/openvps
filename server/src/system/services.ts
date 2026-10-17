import type { Runner } from './exec.ts';

export type ServiceState = 'active' | 'inactive' | 'failed' | 'activating' | 'deactivating' | 'not-installed' | 'unknown';

export interface ServiceStatus {
  name: string;
  state: ServiceState;
  enabled: boolean | null;
}

const UNIT = /^[A-Za-z0-9@._-]{1,64}$/;

/** Read-only systemd status checks for the dashboard. */
export async function serviceStatus(run: Runner, names: string[]): Promise<ServiceStatus[]> {
  const valid = names.filter((n) => UNIT.test(n));
  if (valid.length === 0) return [];
  const units = valid.map((n) => (n.includes('.') ? n : `${n}.service`));
  const res = await run('systemctl', ['show', '--property=Id,LoadState,ActiveState,UnitFileState', '--', ...units]);
  if (res.code === 127) return valid.map((name) => ({ name, state: 'unknown', enabled: null }));
  // Output: blocks of KEY=VALUE separated by blank lines, in the order requested.
  const blocks = res.stdout.trim().split(/\n\s*\n/);
  return valid.map((name, i) => {
    const kv = new Map<string, string>();
    for (const line of (blocks[i] ?? '').split('\n')) {
      const idx = line.indexOf('=');
      if (idx > 0) kv.set(line.slice(0, idx), line.slice(idx + 1));
    }
    const load = kv.get('LoadState');
    if (!load) return { name, state: 'unknown', enabled: null };
    if (load === 'not-found') return { name, state: 'not-installed', enabled: null };
    const active = kv.get('ActiveState') ?? 'unknown';
    const known: ServiceState[] = ['active', 'inactive', 'failed', 'activating', 'deactivating'];
    const ufs = kv.get('UnitFileState');
    return {
      name,
      state: (known as string[]).includes(active) ? (active as ServiceState) : 'unknown',
      enabled: ufs === 'enabled' ? true : ufs === 'disabled' || ufs === 'masked' ? false : null,
    };
  });
}
