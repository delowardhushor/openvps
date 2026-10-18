import { useEffect, useState } from 'react';
import type { AgentInfo, AppSpec } from '../api';

export interface AppFormValue {
  name: string;
  cwd: string;
  cwdTouched: boolean;
  startType: 'file' | 'npm';
  script: string;
  npmScript: string;
  args: string;
  runtime: string;
  execMode: 'fork' | 'cluster';
  instances: number;
  maxMemoryMb: string;
}

export function initialForm(info: AgentInfo | null, spec?: AppSpec): AppFormValue {
  if (spec) {
    return {
      name: spec.name,
      cwd: spec.cwd,
      cwdTouched: true,
      startType: spec.startType,
      script: spec.script ?? '',
      npmScript: spec.npmScript ?? 'start',
      args: spec.args.join('\n'),
      runtime: spec.runtime,
      execMode: spec.execMode,
      instances: spec.instances,
      maxMemoryMb: spec.maxMemoryMb ? String(spec.maxMemoryMb) : '',
    };
  }
  // Prefer a system Node.js over OpenVPS's own runtime for apps.
  const rts = info?.runtimes ?? [];
  const preferred = rts.find((r) => !r.path.startsWith('/opt/openvps/')) ?? rts[0];
  return {
    name: '',
    cwd: info?.allowedRoots[0] ? `${info.allowedRoots[0]}/` : '/srv/apps/',
    cwdTouched: false,
    startType: 'npm',
    script: 'index.js',
    npmScript: 'start',
    args: '',
    runtime: preferred?.path ?? '',
    execMode: 'fork',
    instances: 1,
    maxMemoryMb: '',
  };
}

export function toSpec(v: AppFormValue): AppSpec {
  const cluster = v.startType === 'file' && v.execMode === 'cluster';
  return {
    name: v.name.trim(),
    cwd: v.cwd.trim().replace(/\/+$/, ''),
    startType: v.startType,
    script: v.startType === 'file' ? v.script.trim() : null,
    npmScript: v.startType === 'npm' ? v.npmScript.trim() : null,
    args: v.args
      .split('\n')
      .map((a) => a.trim())
      .filter(Boolean),
    runtime: v.runtime,
    execMode: cluster ? 'cluster' : 'fork',
    instances: cluster ? v.instances : 1,
    maxMemoryMb: v.maxMemoryMb.trim() ? Number(v.maxMemoryMb) : null,
  };
}

function FieldError({ field, err }: { field: string; err: { field?: string; message: string } | null }) {
  return err && err.field === field ? <div className="field-error">{err.message}</div> : null;
}

export function AppForm({
  info,
  value,
  onChange,
  nameLocked = false,
  error,
}: {
  info: AgentInfo | null;
  value: AppFormValue;
  onChange: (v: AppFormValue) => void;
  nameLocked?: boolean;
  error: { field?: string; message: string } | null;
}) {
  const set = (patch: Partial<AppFormValue>) => onChange({ ...value, ...patch });
  const root = info?.allowedRoots[0] ?? '/srv/apps';
  const runtimes = info?.runtimes ?? [];
  const rt = runtimes.find((r) => r.path === value.runtime);
  const daemonNode = runtimes.find((r) => r.path.startsWith('/opt/openvps/'));
  const [showAdvanced, setShowAdvanced] = useState(value.execMode === 'cluster' || !!value.maxMemoryMb || !!value.args);

  // Suggest the directory from the name until the user edits it.
  useEffect(() => {
    if (!value.cwdTouched && !nameLocked) onChange({ ...value, cwd: `${root}/${value.name}` });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value.name]);

  return (
    <div className="form-grid">
      <div className={`field ${error?.field === 'name' ? 'has-error' : ''}`}>
        <label htmlFor="app-name">Name</label>
        <input id="app-name" value={value.name} disabled={nameLocked} placeholder="my-api" autoComplete="off" spellCheck={false} onChange={(e) => set({ name: e.target.value.toLowerCase() })} />
        <div className="field-hint">Lowercase letters, digits and dashes. Also the PM2 process name.</div>
        <FieldError field="name" err={error} />
      </div>

      <div className={`field ${error?.field === 'cwd' ? 'has-error' : ''}`}>
        <label htmlFor="app-cwd">Directory</label>
        <input id="app-cwd" className="mono" value={value.cwd} spellCheck={false} onChange={(e) => set({ cwd: e.target.value, cwdTouched: true })} />
        <div className="field-hint">
          Where the code is, inside <code>{root}</code>. It must be readable by the <code>{info?.apps.user ?? 'apps'}</code> user.
        </div>
        <FieldError field="cwd" err={error} />
      </div>

      <fieldset className="field">
        <legend>How to start it</legend>
        <div className="segmented" role="radiogroup">
          <label className={value.startType === 'npm' ? 'seg-on' : ''}>
            <input type="radio" name="startType" checked={value.startType === 'npm'} onChange={() => set({ startType: 'npm', execMode: 'fork', instances: 1 })} />
            npm script
          </label>
          <label className={value.startType === 'file' ? 'seg-on' : ''}>
            <input type="radio" name="startType" checked={value.startType === 'file'} onChange={() => set({ startType: 'file' })} />
            Entry file
          </label>
        </div>
      </fieldset>

      {value.startType === 'npm' ? (
        <div className={`field ${error?.field === 'npmScript' ? 'has-error' : ''}`}>
          <label htmlFor="app-npm">npm script</label>
          <div className="input-prefix">
            <span className="mono">npm run</span>
            <input id="app-npm" className="mono" value={value.npmScript} spellCheck={false} onChange={(e) => set({ npmScript: e.target.value })} />
          </div>
          <div className="field-hint">From the <code>scripts</code> section of package.json, e.g. <code>start</code>.</div>
          <FieldError field="npmScript" err={error} />
        </div>
      ) : (
        <div className={`field ${error?.field === 'script' ? 'has-error' : ''}`}>
          <label htmlFor="app-script">Entry file</label>
          <input id="app-script" className="mono" value={value.script} placeholder="dist/server.js" spellCheck={false} onChange={(e) => set({ script: e.target.value })} />
          <div className="field-hint">Relative to the directory.</div>
          <FieldError field="script" err={error} />
        </div>
      )}

      <div className={`field ${error?.field === 'runtime' ? 'has-error' : ''}`}>
        <label htmlFor="app-runtime">Node.js</label>
        {runtimes.length ? (
          <select id="app-runtime" value={value.runtime} onChange={(e) => set({ runtime: e.target.value })}>
            {!rt && value.runtime && <option value={value.runtime}>{value.runtime} (not available)</option>}
            {runtimes.map((r) => (
              <option key={r.path} value={r.path}>
                {r.version} — {r.path}
                {r.path.startsWith('/opt/openvps/') ? ' (OpenVPS)' : ''}
                {r.npmCli ? '' : ' — no npm'}
              </option>
            ))}
          </select>
        ) : (
          <div className="alert alert-warn">No Node.js runtime is available to the apps user.</div>
        )}
        <FieldError field="runtime" err={error} />
      </div>

      <button type="button" className="link-btn" onClick={() => setShowAdvanced(!showAdvanced)} aria-expanded={showAdvanced}>
        {showAdvanced ? '▾' : '▸'} Advanced options
      </button>

      {showAdvanced && (
        <>
          <div className={`field ${error?.field === 'args' ? 'has-error' : ''}`}>
            <label htmlFor="app-args">Arguments</label>
            <textarea id="app-args" className="mono" rows={3} value={value.args} placeholder={'--port\n3000'} spellCheck={false} onChange={(e) => set({ args: e.target.value })} />
            <div className="field-hint">One per line. Passed as-is; no shell is involved.</div>
            <FieldError field="args" err={error} />
          </div>
          {value.startType === 'file' && (
            <div className={`field ${error?.field === 'execMode' || error?.field === 'instances' ? 'has-error' : ''}`}>
              <label>Mode</label>
              <div className="segmented">
                <label className={value.execMode === 'fork' ? 'seg-on' : ''}>
                  <input type="radio" name="execMode" checked={value.execMode === 'fork'} onChange={() => set({ execMode: 'fork', instances: 1 })} />
                  Single process
                </label>
                <label className={value.execMode === 'cluster' ? 'seg-on' : ''}>
                  <input type="radio" name="execMode" checked={value.execMode === 'cluster'} onChange={() => set({ execMode: 'cluster', instances: Math.max(2, value.instances), runtime: daemonNode?.path ?? value.runtime })} />
                  Cluster
                </label>
              </div>
              {value.execMode === 'cluster' && (
                <div className="inline-field">
                  <label htmlFor="app-inst">Instances</label>
                  <input id="app-inst" type="number" min={1} max={16} value={value.instances} onChange={(e) => set({ instances: Number(e.target.value) })} />
                </div>
              )}
              <div className="field-hint">
                Cluster mode runs several copies behind one port and supports zero-downtime reload. It always uses OpenVPS's Node.js{daemonNode ? ` (${daemonNode.version})` : ''}.
              </div>
              <FieldError field="execMode" err={error} />
              <FieldError field="instances" err={error} />
            </div>
          )}
          <div className={`field ${error?.field === 'maxMemoryMb' ? 'has-error' : ''}`}>
            <label htmlFor="app-mem">Restart above memory (MB)</label>
            <input id="app-mem" type="number" min={32} max={65536} placeholder="no limit" value={value.maxMemoryMb} onChange={(e) => set({ maxMemoryMb: e.target.value })} />
            <FieldError field="maxMemoryMb" err={error} />
          </div>
        </>
      )}
    </div>
  );
}
