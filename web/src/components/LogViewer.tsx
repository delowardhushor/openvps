import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Owner } from '../api';
import { stripAnsi } from '../format';

export function LogViewer({ owner, name }: { owner: Owner; name: string }) {
  const [stream, setStream] = useState<'out' | 'err'>('out');
  const [lines, setLines] = useState(200);
  const [follow, setFollow] = useState(true);
  const [data, setData] = useState<string[] | null>(null);
  const [path, setPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLPreElement>(null);
  const stick = useRef(true);

  const load = useCallback(async () => {
    try {
      const r = await api.logs(owner, name, stream, lines);
      setData(r.lines.map(stripAnsi));
      setPath(r.path);
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
    }
  }, [owner, name, stream, lines]);

  useEffect(() => {
    setData(null);
    void load();
  }, [load]);

  useEffect(() => {
    if (!follow) return;
    const t = setInterval(() => {
      if (document.visibilityState !== 'hidden') void load();
    }, 3000);
    return () => clearInterval(t);
  }, [follow, load]);

  // Keep scrolled to the bottom unless the user scrolled up to read.
  useEffect(() => {
    const el = boxRef.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [data]);

  return (
    <section className="card logs-card">
      <div className="card-head">
        <div className="tabs" role="tablist" aria-label="Log stream">
          {(['out', 'err'] as const).map((s) => (
            <button key={s} role="tab" aria-selected={stream === s} className={`tab ${stream === s ? 'tab-active' : ''}`} onClick={() => setStream(s)}>
              {s === 'out' ? 'Output' : 'Errors'}
            </button>
          ))}
        </div>
        <div className="toolbar toolbar-tight">
          <select value={lines} onChange={(e) => setLines(Number(e.target.value))} aria-label="Lines">
            {[100, 200, 500, 1000].map((n) => (
              <option key={n} value={n}>
                Last {n} lines
              </option>
            ))}
          </select>
          <label className="check">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} /> Live
          </label>
          <button className="btn btn-small" onClick={() => void load()}>
            Refresh
          </button>
        </div>
      </div>
      {error && <div className="alert alert-error">{error}</div>}
      <pre
        ref={boxRef}
        className="logbox"
        tabIndex={0}
        aria-label={`${stream === 'out' ? 'Output' : 'Error'} log`}
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {data === null ? 'Loading…' : data.length === 0 ? 'No log lines yet.' : data.join('\n')}
      </pre>
      {path && <div className="muted small logpath">{path}</div>}
    </section>
  );
}
