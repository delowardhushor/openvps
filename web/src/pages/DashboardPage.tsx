import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type HistoryPoint, type Overview, type ServiceStatus, type Snapshot, type AuditEntry } from '../api';
import { Meter, Sparkline } from '../components/Charts';
import { actionLabel, ago, bytes, duration, pct, rate, reasonLabel } from '../format';

const OVERVIEW_REFRESH_MS = 30_000;

function usePageVisible(): boolean {
  const [visible, setVisible] = useState(() => document.visibilityState !== 'hidden');
  useEffect(() => {
    const on = () => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', on);
    return () => document.removeEventListener('visibilitychange', on);
  }, []);
  return visible;
}

function useNow(ms = 1000): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function DashboardPage({ onHost }: { onHost?: (hostname: string) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [history, setHistory] = useState<HistoryPoint[]>([]);
  const [intervalSec, setIntervalSec] = useState(5);
  const [stale, setStale] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [collectorError, setCollectorError] = useState<string | null>(null);
  const visible = usePageVisible();
  const now = useNow();
  const maxPoints = useRef(720);

  const pushPoint = useCallback((s: Snapshot) => {
    setHistory((h) => {
      if (h.length && h[h.length - 1]!.t >= s.collectedAt) return h;
      const root = s.disks.find((d) => d.mountpoint === '/') ?? s.disks[0];
      const next = [
        ...h,
        {
          t: s.collectedAt,
          cpu: s.cpu.percent,
          mem: s.memory.usedPercent,
          disk: root?.usedPercent ?? 0,
          rx: s.network?.rxBytesPerSec ?? 0,
          tx: s.network?.txBytesPerSec ?? 0,
        },
      ];
      return next.length > maxPoints.current ? next.slice(-maxPoints.current) : next;
    });
  }, []);

  const loadOverview = useCallback(async () => {
    try {
      const o = await api.overview();
      setOverview(o);
      setIntervalSec(o.intervalSeconds);
      setStale(o.stale);
      setCollectorError(o.error);
      if (o.metrics) {
        setSnap(o.metrics);
        pushPoint(o.metrics);
      }
      onHost?.(o.host.hostname);
      setFetchError(null);
    } catch (e) {
      setFetchError((e as ApiError).message);
    }
  }, [onHost, pushPoint]);

  // Initial load: overview plus the server-side history buffer.
  useEffect(() => {
    void loadOverview();
    api
      .history()
      .then((h) => {
        maxPoints.current = Math.max(60, h.points.length + 60);
        setHistory((cur) => {
          const last = h.points.at(-1)?.t ?? 0;
          return [...h.points, ...cur.filter((p) => p.t > last)];
        });
      })
      .catch(() => {});
  }, [loadOverview]);

  // Live metrics polling, paused while the tab is hidden.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const m = await api.metrics();
        if (cancelled) return;
        setStale(m.stale);
        setCollectorError(m.error);
        setIntervalSec(m.intervalSeconds);
        if (m.metrics) {
          setSnap(m.metrics);
          pushPoint(m.metrics);
        }
        setFetchError(null);
      } catch (e) {
        if (!cancelled) setFetchError((e as ApiError).message);
      }
    };
    void tick();
    const t = setInterval(tick, intervalSec * 1000);
    const o = setInterval(() => void loadOverview(), OVERVIEW_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
      clearInterval(o);
    };
  }, [visible, intervalSec, pushPoint, loadOverview]);

  if (!overview && !fetchError) return <div className="loading">Loading server overview…</div>;
  if (!overview) {
    return (
      <div className="alert alert-error" role="alert">
        Could not load the dashboard: {fetchError}
      </div>
    );
  }

  const ageSec = snap ? Math.max(0, Math.round((now - snap.collectedAt) / 1000)) : null;
  const isStale = !!fetchError || stale || (ageSec !== null && ageSec > intervalSec * 3);
  const root = snap?.disks.find((d) => d.mountpoint === '/') ?? snap?.disks[0];
  const h = overview.host;

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Overview</h1>
          <p className="muted">
            {h.hostname} · {h.os.prettyName} · {h.arch}
          </p>
        </div>
        <div className={`live ${isStale ? 'live-stale' : ''}`} role="status" aria-live="polite">
          <span className="live-dot" aria-hidden="true" />
          {isStale ? 'Stale' : 'Live'}
          {snap && <span className="live-age"> · updated {ageSec! < 2 ? 'just now' : `${ageSec}s ago`}</span>}
        </div>
      </div>

      {!h.supported && h.supportNote && (
        <div className="alert alert-warn">
          <strong>Unsupported platform.</strong> {h.supportNote} OpenVPS will run, but some features may not work as expected.
        </div>
      )}
      {fetchError && <div className="alert alert-error">Lost contact with the server: {fetchError} Retrying…</div>}
      {!fetchError && collectorError && <div className="alert alert-warn">Metrics collection error: {collectorError}</div>}

      {snap ? (
        <section className="stats" aria-label="Resource usage">
          <article className="card stat">
            <header>
              <span className="stat-label">CPU</span>
              <span className="stat-meta">{snap.cpu.count} {snap.cpu.count === 1 ? 'core' : 'cores'}</span>
            </header>
            <div className="stat-value">{pct(snap.cpu.percent)}</div>
            <div className="stat-sub">
              Load {snap.load.map((l) => l.toFixed(2)).join(' · ')}
            </div>
            <Sparkline values={history.map((p) => p.cpu)} max={100} label="CPU" />
          </article>

          <article className="card stat">
            <header>
              <span className="stat-label">Memory</span>
              <span className="stat-meta">{bytes(snap.memory.totalBytes)}</span>
            </header>
            <div className="stat-value">{pct(snap.memory.usedPercent)}</div>
            <div className="stat-sub">
              {bytes(snap.memory.usedBytes)} used · {bytes(snap.memory.availableBytes)} available
            </div>
            <Sparkline values={history.map((p) => p.mem)} max={100} label="Memory" />
          </article>

          <article className="card stat">
            <header>
              <span className="stat-label">Disk {root ? <code>{root.mountpoint}</code> : null}</span>
              <span className="stat-meta">{root ? bytes(root.totalBytes) : '—'}</span>
            </header>
            <div className="stat-value">{root ? pct(root.usedPercent) : '—'}</div>
            <div className="stat-sub">{root ? `${bytes(root.availableBytes)} free` : 'No disk data'}</div>
            {root && <Meter value={root.usedPercent} label="Root disk usage" />}
          </article>

          <article className="card stat">
            <header>
              <span className="stat-label">Network</span>
              <span className="stat-meta">{snap.network?.interfaces.join(', ') || '—'}</span>
            </header>
            {snap.network ? (
              <>
                <div className="stat-value stat-value-sm">
                  <span className="arrow" aria-label="received">↓</span> {rate(snap.network.rxBytesPerSec)}
                </div>
                <div className="stat-sub">
                  <span className="arrow" aria-label="sent">↑</span> {rate(snap.network.txBytesPerSec)} sent
                </div>
                <Sparkline values={history.map((p) => p.rx + p.tx)} label="Network throughput" />
              </>
            ) : (
              <div className="stat-sub">Not available on this platform</div>
            )}
          </article>
        </section>
      ) : (
        <div className="alert alert-info">Collecting the first metrics sample…</div>
      )}

      <div className="grid-2">
        <div className="col">
          <section className="card">
            <h2>System</h2>
            <dl className="kv">
              <dt>Uptime</dt>
              <dd>{snap ? duration(snap.uptimeSeconds) : '—'}</dd>
              <dt>Operating system</dt>
              <dd>{h.os.prettyName}</dd>
              <dt>Kernel</dt>
              <dd><code>{h.kernel}</code></dd>
              <dt>Processor</dt>
              <dd>{h.cpuModel} ({h.cpuCount}×)</dd>
              {snap && snap.memory.swapTotalBytes > 0 && (
                <>
                  <dt>Swap</dt>
                  <dd>{bytes(snap.memory.swapUsedBytes)} of {bytes(snap.memory.swapTotalBytes)}</dd>
                </>
              )}
              <dt>OpenVPS</dt>
              <dd>
                v{overview.version} · Node {overview.panel.nodeVersion} · {bytes(overview.panel.memoryRssBytes, 0)} RAM
              </dd>
              <dt>Panel access</dt>
              <dd>
                {overview.panel.tls ? 'HTTPS' : <span className="text-warn">HTTP (unencrypted)</span>} on port {overview.panel.port}
              </dd>
            </dl>
            {snap && snap.cpu.count > 1 && (
              <div className="cores" aria-label="Per-core usage">
                {snap.cpu.cores.map((c, i) => (
                  <div key={i} className="core" title={`Core ${i}: ${pct(c)}`}>
                    <div className="core-fill" style={{ height: `${c}%` }} />
                  </div>
                ))}
              </div>
            )}
          </section>

          {snap && snap.disks.length > 0 && (
            <section className="card">
              <h2>Storage</h2>
              <ul className="disks">
                {snap.disks.map((d) => (
                  <li key={d.mountpoint}>
                    <div className="disk-row">
                      <code>{d.mountpoint}</code>
                      <span className="muted small">{d.device} · {d.fstype}</span>
                      <span className="disk-num">
                        {bytes(d.usedBytes)} / {bytes(d.totalBytes)} · {pct(d.usedPercent)}
                      </span>
                    </div>
                    <Meter value={d.usedPercent} label={`${d.mountpoint} usage`} />
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>

        <div className="col">
          <Services services={overview.services} />
          <section className="card">
            <h2>Applications</h2>
            <p className="muted">
              Node.js applications, PM2 processes and Git deployments arrive in phase 2. Deployment and backup results will
              appear here.
            </p>
          </section>
          <RecentActivity entries={overview.activity.recent} now={now} />
        </div>
      </div>
    </>
  );
}

const STATE_LABEL: Record<ServiceStatus['state'], string> = {
  active: 'Running',
  inactive: 'Stopped',
  failed: 'Failed',
  activating: 'Starting',
  deactivating: 'Stopping',
  'not-installed': 'Not installed',
  unknown: 'Unknown',
};

function Services({ services }: { services: ServiceStatus[] }) {
  return (
    <section className="card">
      <h2>Services</h2>
      {services.length === 0 ? (
        <p className="muted">No services configured.</p>
      ) : (
        <ul className="services">
          {services.map((s) => (
            <li key={s.name}>
              <span className={`dot dot-${s.state}`} aria-hidden="true" />
              <code>{s.name}</code>
              <span className={`svc-state svc-${s.state}`}>{STATE_LABEL[s.state]}</span>
              {s.enabled === false && s.state !== 'not-installed' && <span className="muted small">disabled at boot</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export function RecentActivity({ entries, now }: { entries: AuditEntry[]; now: number }) {
  return (
    <section className="card">
      <h2>Recent activity</h2>
      {entries.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ul className="activity">
          {entries.map((e) => (
            <li key={e.id}>
              <span className={`dot dot-${e.outcome}`} aria-hidden="true" />
              <span className="act-main">
                {actionLabel(e.action)}
                {e.outcome === 'failure' && <span className="text-fail"> failed</span>}
                {e.target && <span className="muted"> · {e.target}</span>}
                {e.outcome === 'failure' && reasonLabel(e.details?.reason) && (
                  <span className="muted"> ({reasonLabel(e.details?.reason)})</span>
                )}
              </span>
              <time className="muted small" dateTime={new Date(e.ts).toISOString()}>
                {ago(e.ts, now)}
              </time>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
