import { useState } from 'react';
import type { AppRecord, BackupDestination, BackupPlan, BackupSource, PlanInput, Schedule } from '../api';
import { WEEKDAYS } from './BackupBits';

export interface FileRow {
  name: string;
  path: string;
  exclude: string;
}
export interface MongoRow {
  name: string;
  uri: string;
  databases: string;
  /** A connection string is already stored for this one. */
  stored: string | null;
}

export interface PlanFormValue {
  name: string;
  enabled: boolean;
  files: FileRow[];
  mongo: MongoRow[];
  kind: Schedule['kind'];
  hour: string;
  minute: string;
  weekday: string;
  keepLast: string;
  maxAgeDays: string;
  keepLocal: boolean;
  destination: string;
}

export function initialPlanForm(plan?: BackupPlan): PlanFormValue {
  const sched = plan?.schedule;
  return {
    name: plan?.name ?? '',
    enabled: plan?.enabled ?? true,
    files: (plan?.sources ?? []).flatMap((s) => (s.type === 'files' ? [{ name: s.name, path: s.path, exclude: s.exclude.join(', ') }] : [])),
    mongo: (plan?.sources ?? []).flatMap((s) => (s.type === 'mongodb' ? [{ name: s.name, uri: '', databases: s.databases.join(', '), stored: plan?.mongo[s.name] ?? null }] : [])),
    kind: sched?.kind ?? 'daily',
    hour: String(sched && 'hour' in sched ? sched.hour : 3),
    minute: String(sched && 'minute' in sched ? sched.minute : 15),
    weekday: String(sched?.kind === 'weekly' ? sched.weekday : 0),
    keepLast: String(plan?.retention.keepLast ?? 7),
    maxAgeDays: plan?.retention.maxAgeDays ? String(plan.retention.maxAgeDays) : '',
    keepLocal: plan?.keepLocal ?? true,
    destination: plan?.destination ?? '',
  };
}

const list = (text: string) => [...new Set(text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean))];

function slug(text: string, fallback: string): string {
  const s = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24);
  return /^[a-z]/.test(s) ? s : fallback;
}

/** Give every new row a unique, valid source name. */
function uniqueName(base: string, taken: Set<string>): string {
  let n = base;
  for (let i = 2; taken.has(n); i++) n = `${base}-${i}`;
  taken.add(n);
  return n;
}

export function toPlanInput(v: PlanFormValue, editing: boolean): PlanInput {
  const taken = new Set([...v.files, ...v.mongo].map((r) => r.name).filter(Boolean));
  const sources: BackupSource[] = [];
  const mongoUris: Record<string, string> = {};
  for (const f of v.files) {
    const path = f.path.trim();
    sources.push({ type: 'files', name: f.name || uniqueName(slug(path.split('/').filter(Boolean).at(-1) ?? '', 'folder'), taken), path, exclude: list(f.exclude) });
  }
  for (const m of v.mongo) {
    const name = m.name || uniqueName('mongodb', taken);
    sources.push({ type: 'mongodb', name, databases: list(m.databases) });
    if (m.uri.trim()) mongoUris[name] = m.uri.trim();
  }
  const n = (s: string, d: number) => (s.trim() === '' || Number.isNaN(Number(s)) ? d : Number(s));
  const schedule: Schedule =
    v.kind === 'manual'
      ? { kind: 'manual' }
      : v.kind === 'hourly'
        ? { kind: 'hourly', minute: n(v.minute, 0) }
        : v.kind === 'daily'
          ? { kind: 'daily', hour: n(v.hour, 3), minute: n(v.minute, 0) }
          : { kind: 'weekly', weekday: n(v.weekday, 0), hour: n(v.hour, 3), minute: n(v.minute, 0) };
  return {
    ...(editing ? {} : { name: v.name.trim() }),
    enabled: v.enabled,
    sources,
    mongoUris,
    schedule,
    retention: { keepLast: n(v.keepLast, 7), maxAgeDays: v.maxAgeDays.trim() ? n(v.maxAgeDays, 0) : null },
    keepLocal: v.keepLocal,
    destination: v.destination || null,
  };
}

function Err({ field, err }: { field: string; err: { field?: string; message: string } | null }) {
  return err && err.field === field ? <div className="field-error">{err.message}</div> : null;
}

export function PlanForm({
  value,
  onChange,
  destinations,
  apps,
  roots,
  timezone,
  editing,
  error,
  navigate,
}: {
  value: PlanFormValue;
  onChange: (v: PlanFormValue) => void;
  destinations: BackupDestination[];
  apps: AppRecord[];
  roots: string[];
  timezone: string;
  editing: boolean;
  error: { field?: string; message: string } | null;
  navigate: (to: string) => void;
}) {
  const set = (p: Partial<PlanFormValue>) => onChange({ ...value, ...p });
  const [advanced, setAdvanced] = useState(!!value.maxAgeDays);
  const suggestions = apps.filter((a) => !value.files.some((f) => f.path === a.spec.cwd));
  const timed = value.kind === 'daily' || value.kind === 'weekly';

  return (
    <div className="form-grid">
      <div className={`field ${error?.field === 'name' ? 'has-error' : ''}`}>
        <label htmlFor="plan-name">Plan name</label>
        <input id="plan-name" className="mono" value={value.name} disabled={editing} spellCheck={false} placeholder="nightly" onChange={(e) => set({ name: e.target.value.toLowerCase() })} />
        <div className="field-hint">Lowercase letters, digits and dashes. Backups are named after it.</div>
        <Err field="name" err={error} />
      </div>

      <fieldset className={`field ${error?.field === 'sources' ? 'has-error' : ''}`}>
        <legend>Folders to back up</legend>
        {value.files.map((f, i) => (
          <div key={i} className="inline-field">
            <input
              className="mono grow"
              aria-label="Folder path"
              placeholder={`${roots[0] ?? '/srv/apps'}/my-app`}
              value={f.path}
              spellCheck={false}
              onChange={(e) => set({ files: value.files.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)) })}
            />
            <input
              className="grow"
              aria-label="Skip these names"
              placeholder="skip: node_modules, *.log"
              value={f.exclude}
              spellCheck={false}
              onChange={(e) => set({ files: value.files.map((x, j) => (j === i ? { ...x, exclude: e.target.value } : x)) })}
            />
            <button type="button" className="btn btn-small" onClick={() => set({ files: value.files.filter((_, j) => j !== i) })} aria-label="Remove folder">
              Remove
            </button>
          </div>
        ))}
        <div className="chips">
          <button type="button" className="chip" onClick={() => set({ files: [...value.files, { name: '', path: '', exclude: 'node_modules' }] })}>
            + Add a folder
          </button>
          {suggestions.slice(0, 6).map((a) => (
            <button key={a.name} type="button" className="chip" onClick={() => set({ files: [...value.files, { name: '', path: a.spec.cwd, exclude: 'node_modules' }] })}>
              + {a.name}
            </button>
          ))}
        </div>
        <div className="field-hint">
          Must be inside {roots.map((r, i) => (<span key={r}>{i ? ' or ' : ''}<code>{r}</code></span>))}. <code>node_modules</code> is skipped by default; reinstall it with <code>npm ci</code>.
        </div>
        <Err field="sources" err={error} />
      </fieldset>

      <fieldset className={`field ${error?.field === 'mongoUris' ? 'has-error' : ''}`}>
        <legend>MongoDB databases</legend>
        {value.mongo.map((m, i) => (
          <div key={i} className="form-grid">
            <div className="field">
              <label htmlFor={`mongo-uri-${i}`}>Connection string</label>
              <input
                id={`mongo-uri-${i}`}
                type="password"
                className="mono"
                autoComplete="off"
                spellCheck={false}
                placeholder={m.stored ?? 'mongodb://user:password@localhost:27017/?authSource=admin'}
                value={m.uri}
                onChange={(e) => set({ mongo: value.mongo.map((x, j) => (j === i ? { ...x, uri: e.target.value } : x)) })}
              />
              {m.stored && <div className="field-hint">Saved: <span className="mono">{m.stored}</span>. Leave blank to keep it.</div>}
            </div>
            <div className="field">
              <label htmlFor={`mongo-dbs-${i}`}>Only these databases (optional)</label>
              <input
                id={`mongo-dbs-${i}`}
                className="mono"
                placeholder="all databases"
                value={m.databases}
                spellCheck={false}
                onChange={(e) => set({ mongo: value.mongo.map((x, j) => (j === i ? { ...x, databases: e.target.value } : x)) })}
              />
            </div>
            <div>
              <button type="button" className="btn btn-small" onClick={() => set({ mongo: value.mongo.filter((_, j) => j !== i) })}>
                Remove this MongoDB
              </button>
            </div>
          </div>
        ))}
        <div className="chips">
          <button type="button" className="chip" onClick={() => set({ mongo: [...value.mongo, { name: '', uri: '', databases: '', stored: null }] })}>
            + Add MongoDB
          </button>
        </div>
        <div className="field-hint">Needs <code>mongodump</code> on the server. The password is stored encrypted and is never shown again.</div>
        <Err field="mongoUris" err={error} />
      </fieldset>

      <fieldset className={`field ${error?.field === 'schedule' ? 'has-error' : ''}`}>
        <legend>When</legend>
        <div className="inline-field">
          <select aria-label="Schedule" value={value.kind} onChange={(e) => set({ kind: e.target.value as Schedule['kind'] })}>
            <option value="daily">Every day</option>
            <option value="weekly">Every week</option>
            <option value="hourly">Every hour</option>
            <option value="manual">Only when I click</option>
          </select>
          {value.kind === 'weekly' && (
            <select aria-label="Day" value={value.weekday} onChange={(e) => set({ weekday: e.target.value })}>
              {WEEKDAYS.map((d, i) => (
                <option key={d} value={i}>
                  {d}
                </option>
              ))}
            </select>
          )}
          {timed && (
            <>
              <span className="muted">at</span>
              <input aria-label="Hour" type="number" min={0} max={23} value={value.hour} onChange={(e) => set({ hour: e.target.value })} style={{ width: 70 }} />
              <span className="muted">:</span>
              <input aria-label="Minute" type="number" min={0} max={59} value={value.minute} onChange={(e) => set({ minute: e.target.value })} style={{ width: 70 }} />
            </>
          )}
          {value.kind === 'hourly' && (
            <>
              <span className="muted">at minute</span>
              <input aria-label="Minute" type="number" min={0} max={59} value={value.minute} onChange={(e) => set({ minute: e.target.value })} style={{ width: 70 }} />
            </>
          )}
        </div>
        <div className="field-hint">Server time ({timezone}). Pick a quiet hour.</div>
        <Err field="schedule" err={error} />
      </fieldset>

      <fieldset className={`field ${error?.field === 'destination' ? 'has-error' : ''}`}>
        <legend>Where to keep backups</legend>
        <label className="check check-block">
          <input type="checkbox" checked={value.keepLocal} onChange={(e) => set({ keepLocal: e.target.checked })} />
          <span>
            On this server
            <span className="muted small block">Fast to restore, but lost if the server or its disk is lost.</span>
          </span>
        </label>
        <div className="field">
          <label htmlFor="plan-dest">Cloud storage (recommended)</label>
          <select id="plan-dest" value={value.destination} onChange={(e) => set({ destination: e.target.value })}>
            <option value="">None</option>
            {destinations.map((d) => (
              <option key={d.name} value={d.name}>
                {d.name} · {d.target.bucket}
              </option>
            ))}
          </select>
          <div className="field-hint">
            {destinations.length ? 'An off-server copy survives losing this server. ' : 'Add S3-compatible storage first. '}
            <button type="button" className="link-btn inline" onClick={() => navigate('/backups/destinations/new')}>
              Add storage
            </button>
          </div>
        </div>
        <Err field="destination" err={error} />
      </fieldset>

      <div className={`field ${error?.field === 'keepLast' ? 'has-error' : ''}`}>
        <label htmlFor="plan-keep">Keep the newest</label>
        <div className="port-row">
          <input id="plan-keep" type="number" min={1} max={1000} value={value.keepLast} onChange={(e) => set({ keepLast: e.target.value })} style={{ width: 90 }} />
          <span className="muted">backups; older ones are deleted after each run.</span>
        </div>
        <Err field="keepLast" err={error} />
      </div>

      <button type="button" className="link-btn" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>
        {advanced ? '▾' : '▸'} More options
      </button>
      {advanced && (
        <>
          <div className={`field ${error?.field === 'maxAgeDays' ? 'has-error' : ''}`}>
            <label htmlFor="plan-age">Also delete backups older than (days)</label>
            <input id="plan-age" type="number" min={1} max={3650} placeholder="never" value={value.maxAgeDays} onChange={(e) => set({ maxAgeDays: e.target.value })} style={{ width: 120 }} />
            <div className="field-hint">The newest backup is always kept.</div>
            <Err field="maxAgeDays" err={error} />
          </div>
          <label className="check check-block">
            <input type="checkbox" checked={value.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
            <span>Run on schedule (turn off to pause this plan)</span>
          </label>
        </>
      )}
    </div>
  );
}
