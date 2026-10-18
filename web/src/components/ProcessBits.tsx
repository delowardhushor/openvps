import { useState } from 'react';
import { api, ApiError, type ControlOp, type ProcessInfo } from '../api';
import { bytes, duration } from '../format';

const STATUS_LABEL: Record<string, string> = {
  online: 'Running',
  stopped: 'Stopped',
  errored: 'Errored',
  launching: 'Starting',
  stopping: 'Stopping',
  'one-launch-status': 'Exited',
  unknown: 'Unknown',
  missing: 'Not running',
};

export function StatusBadge({ status }: { status: ProcessInfo['status'] | 'missing' }) {
  return (
    <span className={`status status-${status}`}>
      <span className="status-dot" aria-hidden="true" />
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

export function OwnerBadge({ owner }: { owner: ProcessInfo['owner'] }) {
  return owner === 'root' ? (
    <span className="owner owner-root" title="Already running under root's PM2. OpenVPS can start, stop, restart, reload and show logs.">
      root · existing
    </span>
  ) : (
    <span className="owner owner-apps" title="Created in OpenVPS and runs as the unprivileged apps user.">
      OpenVPS
    </span>
  );
}

export function uptime(p: ProcessInfo | null, now = Date.now()): string {
  if (!p || p.status !== 'online' || !p.startedAt) return '—';
  return duration((now - p.startedAt) / 1000);
}

export function memory(p: ProcessInfo | null): string {
  return p && p.status === 'online' ? bytes(p.memoryBytes, 0) : '—';
}

/** Start/stop/restart/reload buttons with per-action busy state and error reporting. */
export function ControlButtons({
  owner,
  name,
  status,
  allowed = true,
  onDone,
  compact = false,
}: {
  owner: ProcessInfo['owner'];
  name: string;
  status: ProcessInfo['status'] | 'missing';
  allowed?: boolean;
  onDone: (msg: string | null, err: string | null) => void;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<ControlOp | null>(null);
  const run = async (op: ControlOp) => {
    setBusy(op);
    try {
      const p = await api.control(owner, name, op);
      onDone(`${name}: ${op} done (${p.status}).`, null);
    } catch (e) {
      onDone(null, `${name}: ${(e as ApiError).message}`);
    } finally {
      setBusy(null);
    }
  };
  if (!allowed) return <span className="muted small">Read-only</span>;
  const running = status === 'online' || status === 'launching';
  const ops: ControlOp[] = running ? ['restart', 'reload', 'stop'] : ['start'];
  return (
    <div className={`btn-row ${compact ? 'btn-row-compact' : ''}`}>
      {ops.map((op) => (
        <button
          key={op}
          className={`btn btn-small ${op === 'stop' ? 'btn-danger-ghost' : ''} ${op === 'start' ? 'btn-primary' : ''}`}
          disabled={busy !== null}
          onClick={(e) => {
            e.stopPropagation();
            void run(op);
          }}
          title={op === 'reload' ? 'Zero-downtime reload (cluster mode); same as restart in fork mode' : undefined}
        >
          {busy === op ? `${op[0]!.toUpperCase()}${op.slice(1)}ing…` : op[0]!.toUpperCase() + op.slice(1)}
        </button>
      ))}
    </div>
  );
}
