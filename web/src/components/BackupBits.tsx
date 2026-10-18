import { useEffect, useRef, useState } from 'react';
import { api, type BackupRun, type RunStatus, type Schedule } from '../api';
import { bytes, shortDate } from '../format';

export const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

const two = (n: number) => String(n).padStart(2, '0');

export function scheduleLabel(s: Schedule): string {
  switch (s.kind) {
    case 'manual':
      return 'Only when you click Back up now';
    case 'hourly':
      return `Every hour at :${two(s.minute)}`;
    case 'daily':
      return `Every day at ${two(s.hour)}:${two(s.minute)}`;
    case 'weekly':
      return `Every ${WEEKDAYS[s.weekday]} at ${two(s.hour)}:${two(s.minute)}`;
  }
}

const KIND: Record<BackupRun['kind'], string> = { backup: 'Backup', restore: 'Restore', verify: 'Check' };
export const kindLabel = (k: BackupRun['kind']) => KIND[k];

const STATUS: Record<RunStatus, { cls: string; label: string }> = {
  running: { cls: 'pill-info', label: 'Running' },
  succeeded: { cls: 'pill-success', label: 'Succeeded' },
  partial: { cls: 'pill-warn', label: 'Partly done' },
  failed: { cls: 'pill-failure', label: 'Failed' },
};

export function StatusPill({ status }: { status: RunStatus }) {
  const s = STATUS[status];
  return <span className={`pill ${s.cls}`}>{s.label}</span>;
}

/** "Mar 3, 2026, 03:15" from an artifact's timestamp. */
export function backupTime(ts: number): string {
  return new Date(ts).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function RunSummary({ run }: { run: BackupRun }) {
  return (
    <>
      <StatusPill status={run.status} />{' '}
      {run.status === 'running' ? (
        <span className="muted small">{run.step ?? 'Working…'}</span>
      ) : (
        <span className="muted small">
          {run.finishedAt ? shortDate(run.finishedAt) : ''}
          {run.sizeBytes ? ` · ${bytes(run.sizeBytes)}` : ''}
        </span>
      )}
      {run.message && run.status !== 'succeeded' && <div className={`small ${run.status === 'failed' ? 'text-fail' : 'text-warn'}`}>{run.message}</div>}
    </>
  );
}

/** Follows a running task until it ends, showing what it is doing. */
export function RunWatcher({ runId, onFinished }: { runId: number; onFinished: (run: BackupRun) => void }) {
  const [state, setState] = useState<{ run: BackupRun; log: string[] } | null>(null);
  const [lost, setLost] = useState(false);
  const done = useRef(onFinished);
  done.current = onFinished;

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      try {
        const r = await api.backupRun(runId);
        if (stop) return;
        setLost(false);
        setState(r);
        if (r.run.status !== 'running') {
          done.current(r.run);
          return;
        }
      } catch {
        if (!stop) setLost(true);
      }
      timer = setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => {
      stop = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  const run = state?.run;
  if (!run) return <div className="loading">Starting…</div>;
  const level = run.status === 'failed' ? 'alert-error' : run.status === 'partial' ? 'alert-warn' : run.status === 'succeeded' ? 'alert-ok' : 'alert-info';
  return (
    <div className={`alert ${level}`} role="status" aria-live="polite">
      <strong>
        {kindLabel(run.kind)} {run.status === 'running' ? 'in progress' : STATUS[run.status].label.toLowerCase()}
      </strong>
      {run.status === 'running' && <div className="small">{run.step ?? 'Working…'}</div>}
      {lost && <div className="small">Lost contact with the panel; still trying…</div>}
      {run.message && <div className="small">{run.message}</div>}
      {run.status === 'running' && state.log.length > 0 && <pre className="pre-plain small">{state.log.slice(-6).join('\n')}</pre>}
      {run.result?.checks && (
        <ul className="small">
          {run.result.checks.map((c) => (
            <li key={c.name}>
              {c.ok ? '✓' : '✗'} {c.name}: {c.detail}
            </li>
          ))}
        </ul>
      )}
      {run.result?.restored && (
        <ul className="small">
          {run.result.restored.map((r) => (
            <li key={r.source + r.target}>
              {r.kind === 'files' ? 'Folder' : 'MongoDB'} <strong>{r.source}</strong> → <span className="mono">{r.target}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
