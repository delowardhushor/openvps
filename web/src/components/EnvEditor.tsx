import { useState } from 'react';

export interface EnvRow {
  key: string;
  value: string;
  /** Existing variable whose value is stored server-side and not shown. */
  stored?: boolean;
  removed?: boolean;
}

const KEY = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;

/** Parse KEY=value lines (.env format, with optional quotes and comments). */
export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let v = m[2]!;
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    else v = v.replace(/\s+#.*$/, '');
    out[m[1]!] = v;
  }
  return out;
}

export function envRowError(rows: EnvRow[], i: number): string | null {
  const r = rows[i]!;
  if (r.removed) return null;
  if (!r.key) return r.value ? 'Name required' : null;
  if (!KEY.test(r.key)) return 'Letters, digits, underscore';
  if (/^(PM2_.*|HOME|USER|LOGNAME|SHELL|NODE_APP_INSTANCE|pm_id)$/.test(r.key)) return 'Managed by OpenVPS';
  if (rows.findIndex((x) => !x.removed && x.key === r.key) !== i) return 'Duplicate';
  return null;
}

/**
 * Key/value editor. Existing values are write-only: they show as "stored" and
 * can be replaced or removed, but never displayed.
 */
export function EnvEditor({ rows, onChange }: { rows: EnvRow[]; onChange: (rows: EnvRow[]) => void }) {
  const [paste, setPaste] = useState<string | null>(null);
  const update = (i: number, patch: Partial<EnvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));

  const importText = () => {
    const parsed = parseDotenv(paste ?? '');
    const next = [...rows.filter((r) => r.key || r.value)];
    for (const [key, value] of Object.entries(parsed)) {
      const idx = next.findIndex((r) => r.key === key);
      if (idx >= 0) next[idx] = { key, value, removed: false };
      else next.push({ key, value });
    }
    onChange(next.length ? next : [{ key: '', value: '' }]);
    setPaste(null);
  };

  return (
    <div className="env">
      {rows.length === 0 && <p className="muted small">No variables.</p>}
      {rows.map((r, i) => {
        const err = envRowError(rows, i);
        return (
          <div key={i} className={`env-row ${r.removed ? 'env-removed' : ''}`}>
            <input
              className="mono"
              placeholder="NAME"
              value={r.key}
              disabled={r.stored || r.removed}
              aria-label="Variable name"
              aria-invalid={!!err}
              onChange={(e) => update(i, { key: e.target.value.trim() })}
            />
            <input
              className="mono"
              placeholder={r.stored ? '•••••• (stored; type to replace)' : 'value'}
              value={r.value}
              disabled={r.removed}
              type="text"
              autoComplete="off"
              spellCheck={false}
              aria-label={`Value of ${r.key || 'variable'}`}
              onChange={(e) => update(i, { value: e.target.value })}
            />
            {r.removed ? (
              <button type="button" className="btn btn-small" onClick={() => update(i, { removed: false })}>
                Undo
              </button>
            ) : (
              <button
                type="button"
                className="btn btn-small btn-danger-ghost"
                aria-label={`Remove ${r.key || 'row'}`}
                onClick={() => (r.stored ? update(i, { removed: true }) : onChange(rows.filter((_, j) => j !== i)))}
              >
                Remove
              </button>
            )}
            {err && <div className="field-error env-err">{err}</div>}
          </div>
        );
      })}
      <div className="btn-row">
        <button type="button" className="btn btn-small" onClick={() => onChange([...rows, { key: '', value: '' }])}>
          Add variable
        </button>
        <button type="button" className="btn btn-small" onClick={() => setPaste(paste === null ? '' : null)}>
          Paste .env
        </button>
      </div>
      {paste !== null && (
        <div className="paste">
          <textarea
            className="mono"
            rows={6}
            placeholder={'PORT=3000\nDATABASE_URL=mongodb://localhost/app'}
            value={paste}
            onChange={(e) => setPaste(e.target.value)}
            aria-label="Paste .env content"
          />
          <button type="button" className="btn btn-small btn-primary" onClick={importText} disabled={!paste.trim()}>
            Import
          </button>
        </div>
      )}
    </div>
  );
}

export function rowsHaveErrors(rows: EnvRow[]): boolean {
  return rows.some((_, i) => envRowError(rows, i) !== null);
}
