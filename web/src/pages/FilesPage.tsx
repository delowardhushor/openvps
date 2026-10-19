import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import { api, ApiError, fileDownloadUrl, uploadFile, type FileEntry, type FileListing, type FilesInfo, type UploadHandle } from '../api';
import { bytes, dateTime } from '../format';

// ---- paths ------------------------------------------------------------------------------

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const parentOf = (p: string) => p.split('/').slice(0, -1).join('/');
const baseName = (p: string) => p.split('/').at(-1) ?? p;
const encodePath = (p: string) => p.split('/').filter(Boolean).map(encodeURIComponent).join('/');
const decode = (s: string) => {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
};

/** /files/<root number>/<folder>/<folder>... */
function parseRoute(path: string): { root: number; dir: string } {
  const m = /^\/files(?:\/(\d+)(?:\/(.*))?)?\/?$/.exec(path);
  if (!m) return { root: 0, dir: '' };
  return { root: Number(m[1] ?? 0), dir: (m[2] ?? '').split('/').filter(Boolean).map(decode).join('/') };
}
const routeFor = (root: number, dir: string) => `/files/${root}${dir ? '/' + encodePath(dir) : ''}`;

// ---- small pieces -----------------------------------------------------------------------

const ICON = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
function FileIcon({ entry }: { entry: FileEntry }) {
  const isDir = entry.type === 'dir' || (entry.type === 'link' && entry.link === 'dir');
  return (
    <svg className="fm-icon" viewBox="0 0 24 24" aria-hidden="true" {...ICON}>
      {isDir ? <path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" /> : <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5" />}
    </svg>
  );
}

function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="btn-icon" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

function NameDialog({ title, label, initial, action, onSubmit, onClose }: { title: string; label: string; initial: string; action: string; onSubmit: (name: string) => Promise<void>; onClose: () => void }) {
  const [name, setName] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const clean = name.trim();
  const problem = !clean ? 'Enter a name.' : clean.includes('/') ? 'A name cannot contain "/".' : clean === '.' || clean === '..' ? 'That name is not allowed.' : null;
  const submit = async () => {
    if (problem || busy) return;
    setBusy(true);
    try {
      await onSubmit(clean);
      onClose();
    } catch (e) {
      setError((e as ApiError).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={title} onClose={onClose}>
      <div className="field">
        <label htmlFor="fm-name">{label}</label>
        <input
          id="fm-name"
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void submit()}
          onFocus={(e) => e.currentTarget.select()}
          spellCheck={false}
        />
        {error && <div className="field-error">{error}</div>}
      </div>
      <div className="btn-row">
        <button className="btn btn-primary" onClick={() => void submit()} disabled={!!problem || busy}>
          {action}
        </button>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  );
}

function Editor({ root, path, maxBytes, onClose, onSaved }: { root: string; path: string; maxBytes: number; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState('');
  const [mtime, setMtime] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    api
      .filesText(root, path)
      .then((f) => {
        if (!live) return;
        setText(f.content);
        setOrig(f.content);
        setMtime(f.mtimeMs);
      })
      .catch((e: ApiError) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [root, path]);

  const dirty = text !== null && text !== orig;
  const save = async (force = false) => {
    if (text === null || saving) return;
    setSaving(true);
    setConflict(false);
    try {
      const r = await api.filesSaveText({ root, path, content: text, mtimeMs: force ? null : mtime });
      setOrig(text);
      setMtime(r.mtimeMs);
      setSavedAt(Date.now());
      setError(null);
      onSaved();
    } catch (e) {
      const err = e as ApiError;
      if (err.code === 'changed') setConflict(true);
      else setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  const close = () => {
    if (!dirty || window.confirm('Close without saving your changes?')) onClose();
  };
  const reload = () => {
    setText(null);
    setConflict(false);
    api
      .filesText(root, path)
      .then((f) => {
        setText(f.content);
        setOrig(f.content);
        setMtime(f.mtimeMs);
      })
      .catch((e: ApiError) => setError(e.message));
  };

  return (
    <Modal title={baseName(path)} onClose={close} wide>
      <div className="muted small fm-editor-path">{path}</div>
      {error && <div className="alert alert-error">{error}</div>}
      {conflict && (
        <div className="alert alert-warn">
          This file was changed on the server after you opened it.{' '}
          <button className="link-btn inline" onClick={reload}>
            Reload it
          </button>{' '}
          (your edits are lost) or{' '}
          <button className="link-btn inline" onClick={() => void save(true)}>
            overwrite it
          </button>
          .
        </div>
      )}
      {text === null && !error ? (
        <div className="loading">Opening…</div>
      ) : (
        text !== null && (
          <textarea
            className="fm-editor"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                void save();
              }
            }}
            spellCheck={false}
            autoFocus
            wrap="off"
            aria-label={`Contents of ${baseName(path)}`}
          />
        )
      )}
      <div className="btn-row fm-editor-foot">
        <button className="btn btn-primary" onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? 'Saving…' : 'Save'}
        </button>
        <button className="btn" onClick={close}>
          Close
        </button>
        <span className="muted small">
          {dirty ? 'Unsaved changes · Ctrl+S saves' : savedAt ? 'Saved' : `Opens text files up to ${bytes(maxBytes, 0)}`}
        </span>
      </div>
    </Modal>
  );
}

// ---- uploads ----------------------------------------------------------------------------

interface UploadItem {
  id: number;
  root: string;
  rel: string;
  file: File;
  overwrite: boolean;
  state: 'queued' | 'uploading' | 'done' | 'error';
  sent: number;
  error?: string;
  code?: string;
  handle?: UploadHandle;
}

const CONCURRENCY = 2;
const MAX_FILES_PER_DROP = 20000;

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, err: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (e: FsEntry[]) => void, err: (e: unknown) => void) => void };
}

/** Files (with folder paths) from a drop. Must start synchronously: the data goes away after the event. */
async function filesFromDrop(dt: DataTransfer): Promise<Array<{ rel: string; file: File }>> {
  const entries = Array.from(dt.items ?? [])
    .map((i) => (i.kind === 'file' ? (i as unknown as { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.() ?? null : null))
    .filter((e): e is FsEntry => !!e);
  if (entries.length === 0) return Array.from(dt.files).map((f) => ({ rel: f.name, file: f }));
  const out: Array<{ rel: string; file: File }> = [];
  const walk = async (e: FsEntry, prefix: string): Promise<void> => {
    if (out.length > MAX_FILES_PER_DROP) return;
    if (e.isFile && e.file) {
      const file = await new Promise<File>((ok, err) => e.file!(ok, err));
      out.push({ rel: prefix + e.name, file });
    } else if (e.isDirectory && e.createReader) {
      const reader = e.createReader();
      for (;;) {
        const batch = await new Promise<FsEntry[]>((ok, err) => reader.readEntries(ok, err));
        if (batch.length === 0) break;
        for (const child of batch) await walk(child, `${prefix}${e.name}/`);
      }
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types ?? []).includes('Files');

// ---- page -------------------------------------------------------------------------------

export function FilesPage({ path, navigate }: { path: string; navigate: (to: string) => void }) {
  const route = parseRoute(path);
  const [info, setInfo] = useState<FilesInfo | null>(null);
  const [infoError, setInfoError] = useState<string | null>(null);
  const [listing, setListing] = useState<FileListing | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [dialog, setDialog] = useState<
    | { kind: 'mkdir' }
    | { kind: 'newfile' }
    | { kind: 'rename'; entry: FileEntry }
    | { kind: 'delete'; names: string[] }
    | { kind: 'edit'; path: string }
    | null
  >(null);
  const [dragging, setDragging] = useState(false);
  const [dropRow, setDropRow] = useState<string | null>(null);
  const dragDepth = useRef(0);

  useEffect(() => {
    api
      .filesInfo()
      .then(setInfo)
      .catch((e: ApiError) => setInfoError(e.message));
  }, []);

  const rootPath = info?.roots[route.root]?.path ?? null;
  const dir = route.dir;

  const load = useCallback(async () => {
    if (!rootPath) return;
    setLoading(true);
    try {
      setListing(await api.filesList(rootPath, dir));
      setError(null);
    } catch (e) {
      setError((e as ApiError).message);
      setListing(null);
    } finally {
      setLoading(false);
    }
  }, [rootPath, dir]);

  useEffect(() => {
    setSelected(new Set());
    void load();
  }, [load]);

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(t);
  }, [notice]);

  // ---- upload queue (a ref holds the truth; `tick` repaints) ----
  const queue = useRef<UploadItem[]>([]);
  const nextId = useRef(1);
  const [, setTick] = useState(0);
  const repaint = () => setTick((n) => n + 1);
  const active = useRef(0);
  const ctxRef = useRef({ rootPath, load });
  ctxRef.current = { rootPath, load };

  const pump = useCallback(() => {
    while (active.current < CONCURRENCY) {
      const item = queue.current.find((i) => i.state === 'queued');
      if (!item) break;
      item.state = 'uploading';
      active.current++;
      const h = uploadFile(item.root, item.rel, item.file, {
        overwrite: item.overwrite,
        onProgress: (sent) => {
          item.sent = sent;
          repaint();
        },
      });
      item.handle = h;
      h.promise
        .then(() => {
          item.state = 'done';
          item.sent = item.file.size;
        })
        .catch((e: ApiError) => {
          item.state = 'error';
          item.error = e.code === 'aborted' ? 'Cancelled' : e.message;
          item.code = e.code;
        })
        .finally(() => {
          item.handle = undefined;
          active.current--;
          repaint();
          if (active.current === 0 && !queue.current.some((i) => i.state === 'queued')) void ctxRef.current.load();
          pump();
        });
    }
    repaint();
  }, []);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (queue.current.some((i) => i.state === 'uploading' || i.state === 'queued')) e.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  const enqueue = useCallback(
    (items: Array<{ rel: string; file: File }>, targetDir: string) => {
      if (!info || !rootPath || items.length === 0) return;
      if (items.length > MAX_FILES_PER_DROP) {
        setError(`That is more than ${MAX_FILES_PER_DROP} files at once. Upload them in smaller groups or as a zip file.`);
        return;
      }
      // Names that already exist at the top level of the target folder.
      const existing = targetDir === dir && listing ? new Set(listing.entries.map((e) => e.name)) : new Set<string>();
      const clashes = [...new Set(items.map((i) => i.rel.split('/')[0]!))].filter((n) => existing.has(n));
      let overwrite = false;
      if (clashes.length > 0) {
        overwrite = window.confirm(
          `${clashes.length === 1 ? `"${clashes[0]}" already exists` : `${clashes.length} items already exist`} in this folder. Replace ${clashes.length === 1 ? 'it' : 'them'}?\n\nOK replaces files with the same name, Cancel skips the ones that exist.`,
        );
      }
      for (const it of items) {
        const top = it.rel.split('/')[0]!;
        const clash = clashes.includes(top);
        const full = join(targetDir, it.rel);
        const entry: UploadItem = { id: nextId.current++, root: rootPath, rel: full, file: it.file, overwrite, state: 'queued', sent: 0 };
        if (it.file.size > info.maxUploadBytes) {
          entry.state = 'error';
          entry.error = `Too large (the limit is ${bytes(info.maxUploadBytes, 0)}).`;
        } else if (clash && !overwrite && it.rel.indexOf('/') < 0) {
          entry.state = 'error';
          entry.code = 'skipped';
          entry.error = 'Skipped: already exists.';
        }
        queue.current.push(entry);
      }
      pump();
    },
    [info, rootPath, dir, listing, pump],
  );

  const onPick = (e: ChangeEvent<HTMLInputElement>, folder: boolean) => {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    enqueue(
      files.map((f) => ({ rel: folder ? ((f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name) : f.name, file: f })),
      dir,
    );
  };

  const onDropFiles = async (e: DragEvent, targetDir: string) => {
    e.preventDefault();
    e.stopPropagation();
    dragDepth.current = 0;
    setDragging(false);
    setDropRow(null);
    if (!hasFiles(e)) return;
    try {
      enqueue(await filesFromDrop(e.dataTransfer), targetDir);
    } catch {
      setError('Could not read the dropped items. Try the Upload button instead.');
    }
  };

  const retry = (item: UploadItem, overwrite: boolean) => {
    item.state = 'queued';
    item.overwrite = overwrite;
    item.error = undefined;
    item.code = undefined;
    item.sent = 0;
    pump();
  };
  const cancelAll = () => {
    for (const i of queue.current) {
      if (i.state === 'queued') {
        i.state = 'error';
        i.error = 'Cancelled';
        i.code = 'aborted';
      } else if (i.state === 'uploading') i.handle?.abort();
    }
    repaint();
  };
  const clearFinished = () => {
    queue.current = queue.current.filter((i) => i.state === 'queued' || i.state === 'uploading');
    repaint();
  };

  // ---- actions ----
  const goDir = (d: string) => navigate(routeFor(route.root, d));
  const entryPath = (name: string) => join(dir, name);
  const openEntry = (e: FileEntry) => {
    const isDir = e.type === 'dir' || (e.type === 'link' && e.link === 'dir');
    if (isDir) return goDir(entryPath(e.name));
    if (e.type === 'file' && info && e.size <= info.maxEditBytes) return setDialog({ kind: 'edit', path: entryPath(e.name) });
    if (e.type === 'file') window.location.assign(fileDownloadUrl(rootPath!, entryPath(e.name)));
  };
  const mkdir = async (name: string) => {
    await api.filesMkdir(rootPath!, entryPath(name));
    setNotice(`Folder "${name}" created.`);
    await load();
  };
  const newFile = async (name: string) => {
    await api.filesSaveText({ root: rootPath!, path: entryPath(name), content: '', create: true });
    await load();
    setDialog({ kind: 'edit', path: entryPath(name) });
  };
  const rename = async (e: FileEntry, name: string) => {
    if (name === e.name) return;
    await api.filesMove(rootPath!, entryPath(e.name), entryPath(name));
    setNotice(`Renamed to "${name}".`);
    await load();
  };
  const remove = async (names: string[]) => {
    let done = 0;
    try {
      for (const n of names) {
        await api.filesDelete(rootPath!, entryPath(n));
        done++;
      }
      setNotice(done === 1 ? `Deleted "${names[0]}".` : `Deleted ${done} items.`);
    } catch (e) {
      setError((e as ApiError).message);
    } finally {
      setDialog(null);
      setSelected(new Set());
      await load();
    }
  };

  const entries = useMemo(() => {
    const list = [...(listing?.entries ?? [])];
    const isDir = (e: FileEntry) => e.type === 'dir' || (e.type === 'link' && e.link === 'dir');
    list.sort((a, b) => Number(isDir(b)) - Number(isDir(a)) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
    return list;
  }, [listing]);

  const crumbs = dir ? dir.split('/') : [];
  const items = queue.current;
  const busyCount = items.filter((i) => i.state === 'queued' || i.state === 'uploading').length;
  const allSelected = entries.length > 0 && selected.size === entries.length;

  if (infoError) return <div className="alert alert-error">{infoError}</div>;
  if (!info) return <div className="loading">Loading…</div>;
  if (!rootPath) {
    return (
      <>
        <div className="page-head"><h1>Files</h1></div>
        <div className="alert alert-warn">That folder is not managed by the file manager.</div>
        <button className="btn" onClick={() => navigate('/files')}>Back to files</button>
      </>
    );
  }

  return (
    <div
      className={`fm ${dragging ? 'fm-dragging' : ''}`}
      onDragEnter={(e) => {
        if (!hasFiles(e)) return;
        dragDepth.current++;
        setDragging(true);
      }}
      onDragOver={(e) => hasFiles(e) && e.preventDefault()}
      onDragLeave={(e) => {
        if (!hasFiles(e)) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => void onDropFiles(e, dir)}
    >
      <div className="page-head">
        <div>
          <h1>Files</h1>
          <p className="muted">Browse and change the files of your apps and websites. Drop files or folders anywhere on this page to upload them.</p>
        </div>
      </div>

      <div className="toolbar">
        {info.roots.length > 1 && (
          <select value={route.root} onChange={(e) => navigate(routeFor(Number(e.target.value), ''))} aria-label="Location">
            {info.roots.map((r, i) => (
              <option key={r.path} value={i}>
                {r.path}
              </option>
            ))}
          </select>
        )}
        <label className="btn btn-primary">
          Upload files
          <input type="file" multiple hidden onChange={(e) => onPick(e, false)} />
        </label>
        <label className="btn">
          Upload folder
          <input type="file" hidden onChange={(e) => onPick(e, true)} {...({ webkitdirectory: '', directory: '' } as Record<string, string>)} />
        </label>
        <button className="btn" onClick={() => setDialog({ kind: 'mkdir' })}>
          New folder
        </button>
        <button className="btn" onClick={() => setDialog({ kind: 'newfile' })}>
          New file
        </button>
        <button className="btn" onClick={() => void load()} disabled={loading}>
          Refresh
        </button>
        {selected.size > 0 && (
          <button className="btn btn-danger" onClick={() => setDialog({ kind: 'delete', names: [...selected] })}>
            Delete {selected.size} selected
          </button>
        )}
      </div>

      <nav className="fm-crumbs" aria-label="Folder path">
        <button className="link-btn inline" onClick={() => goDir('')}>
          {rootPath}
        </button>
        {crumbs.map((c, i) => (
          <span key={i}>
            <span className="muted"> / </span>
            {i === crumbs.length - 1 ? (
              <strong>{c}</strong>
            ) : (
              <button className="link-btn inline" onClick={() => goDir(crumbs.slice(0, i + 1).join('/'))}>
                {c}
              </button>
            )}
          </span>
        ))}
        {listing?.disk && <span className="muted small fm-disk">{bytes(listing.disk.availableBytes)} free</span>}
      </nav>

      {notice && <div className="alert alert-ok" role="status">{notice}</div>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {listing?.truncated && <div className="alert alert-warn">This folder has more items than can be shown here; only the first ones are listed.</div>}

      <section className="card table-card">
        <div className="table-scroll">
          <table className="table table-hover fm-table">
            <thead>
              <tr>
                <th className="fm-check">
                  <input
                    type="checkbox"
                    aria-label="Select all"
                    checked={allSelected}
                    onChange={() => setSelected(allSelected ? new Set() : new Set(entries.map((e) => e.name)))}
                  />
                </th>
                <th>Name</th>
                <th className="num">Size</th>
                <th>Modified</th>
                <th className="actions">Actions</th>
              </tr>
            </thead>
            <tbody>
              {dir && (
                <tr className="clickable" onClick={() => goDir(parentOf(dir))}>
                  <td />
                  <td colSpan={4}>
                    <span className="fm-name">↑ Parent folder</span>
                  </td>
                </tr>
              )}
              {entries.map((e) => {
                const isDir = e.type === 'dir' || (e.type === 'link' && e.link === 'dir');
                const blocked = e.type === 'other' || (e.type === 'link' && (e.link === 'outside' || e.link === 'broken'));
                const canEdit = e.type === 'file' && e.size <= info.maxEditBytes;
                return (
                  <tr
                    key={e.name}
                    className={`${blocked ? '' : 'clickable'} ${dropRow === e.name ? 'fm-drop' : ''}`}
                    onClick={() => !blocked && openEntry(e)}
                    onDragOver={(ev) => {
                      if (isDir && hasFiles(ev)) {
                        ev.preventDefault();
                        ev.stopPropagation();
                        setDropRow(e.name);
                      }
                    }}
                    onDragLeave={() => setDropRow((r) => (r === e.name ? null : r))}
                    onDrop={(ev) => (isDir ? void onDropFiles(ev, entryPath(e.name)) : undefined)}
                  >
                    <td className="fm-check" onClick={(ev) => ev.stopPropagation()}>
                      <input
                        type="checkbox"
                        aria-label={`Select ${e.name}`}
                        checked={selected.has(e.name)}
                        onChange={() =>
                          setSelected((s) => {
                            const n = new Set(s);
                            if (n.has(e.name)) n.delete(e.name);
                            else n.add(e.name);
                            return n;
                          })
                        }
                      />
                    </td>
                    <td>
                      <span className="fm-name">
                        <FileIcon entry={e} />
                        <span className="fm-name-text">{e.name}</span>
                        {e.type === 'link' && <span className="muted small"> link{e.link === 'outside' ? ' (outside this folder)' : e.link === 'broken' ? ' (broken)' : ''}</span>}
                        {e.type === 'other' && <span className="muted small"> special file</span>}
                      </span>
                    </td>
                    <td className="num">{e.type === 'file' ? bytes(e.size) : '—'}</td>
                    <td className="nowrap">{dateTime(e.mtimeMs)}</td>
                    <td className="actions" onClick={(ev) => ev.stopPropagation()}>
                      <div className="btn-row btn-row-compact">
                        {canEdit && (
                          <button className="btn btn-small" onClick={() => setDialog({ kind: 'edit', path: entryPath(e.name) })}>
                            Edit
                          </button>
                        )}
                        {(e.type === 'file' || (e.type === 'link' && e.link === 'file')) && (
                          <a className="btn btn-small" href={fileDownloadUrl(rootPath, entryPath(e.name))}>
                            Download
                          </a>
                        )}
                        <button className="btn btn-small" onClick={() => setDialog({ kind: 'rename', entry: e })}>
                          Rename
                        </button>
                        <button className="btn btn-small btn-danger-ghost" onClick={() => setDialog({ kind: 'delete', names: [e.name] })}>
                          Delete
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {!loading && listing && entries.length === 0 && (
                <tr>
                  <td colSpan={5} className="muted center fm-empty">
                    This folder is empty. Drop files here to upload them.
                  </td>
                </tr>
              )}
              {loading && !listing && (
                <tr>
                  <td colSpan={5} className="muted center">Loading…</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      {dragging && (
        <div className="fm-overlay" aria-hidden="true">
          <div className="fm-overlay-box">Drop to upload to <code>{join(rootPath, dir) || rootPath}</code></div>
        </div>
      )}

      {items.length > 0 && (
        <aside className="card fm-uploads" aria-label="Uploads">
          <div className="card-head">
            <h2>{busyCount > 0 ? `Uploading ${busyCount} file${busyCount === 1 ? '' : 's'}…` : 'Uploads'}</h2>
            <div className="btn-row">
              {busyCount > 0 && (
                <button className="btn btn-small" onClick={cancelAll}>
                  Cancel all
                </button>
              )}
              {busyCount < items.length && (
                <button className="btn btn-small" onClick={clearFinished}>
                  Clear finished
                </button>
              )}
            </div>
          </div>
          <ul className="fm-upload-list">
            {items.slice(-200).map((i) => (
              <li key={i.id} className={`fm-upload fm-upload-${i.state}`}>
                <div className="fm-upload-top">
                  <span className="fm-upload-name" title={i.rel}>{i.rel}</span>
                  <span className="muted small">
                    {i.state === 'done' ? 'Done' : i.state === 'queued' ? 'Waiting' : i.state === 'uploading' ? `${Math.round((i.sent / Math.max(1, i.file.size)) * 100)}%` : ''}
                  </span>
                </div>
                {(i.state === 'uploading' || i.state === 'queued') && (
                  <div className="fm-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round((i.sent / Math.max(1, i.file.size)) * 100)}>
                    <div style={{ width: `${(i.sent / Math.max(1, i.file.size)) * 100}%` }} />
                  </div>
                )}
                {i.state === 'error' && (
                  <div className="fm-upload-error small">
                    {i.error}{' '}
                    {i.code === 'exists' && (
                      <button className="link-btn inline" onClick={() => retry(i, true)}>
                        Replace
                      </button>
                    )}
                    {(i.code === 'network' || i.code === 'timeout' || i.code === 'aborted' || i.code === 'skipped') && i.file.size <= info.maxUploadBytes && (
                      <button className="link-btn inline" onClick={() => retry(i, i.code === 'skipped')}>
                        Try again
                      </button>
                    )}
                  </div>
                )}
              </li>
            ))}
          </ul>
        </aside>
      )}

      {dialog?.kind === 'mkdir' && <NameDialog title="New folder" label="Folder name" initial="" action="Create" onSubmit={mkdir} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'newfile' && <NameDialog title="New file" label="File name" initial="" action="Create and open" onSubmit={newFile} onClose={() => setDialog(null)} />}
      {dialog?.kind === 'rename' && (
        <NameDialog title="Rename" label="New name" initial={dialog.entry.name} action="Rename" onSubmit={(n) => rename(dialog.entry, n)} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && (
        <Modal title="Delete permanently?" onClose={() => setDialog(null)}>
          <p>
            {dialog.names.length === 1 ? (
              <>
                <strong>{dialog.names[0]}</strong> will be deleted
              </>
            ) : (
              <>{dialog.names.length} items will be deleted</>
            )}
            . Folders are deleted with everything inside them. This cannot be undone.
          </p>
          {dialog.names.length > 1 && <ul className="fm-delete-list">{dialog.names.slice(0, 8).map((n) => <li key={n}>{n}</li>)}{dialog.names.length > 8 && <li>…and {dialog.names.length - 8} more</li>}</ul>}
          <div className="btn-row">
            <button className="btn btn-danger" onClick={() => void remove(dialog.names)} autoFocus>
              Delete
            </button>
            <button className="btn" onClick={() => setDialog(null)}>
              Cancel
            </button>
          </div>
        </Modal>
      )}
      {dialog?.kind === 'edit' && <Editor root={rootPath} path={dialog.path} maxBytes={info.maxEditBytes} onClose={() => setDialog(null)} onSaved={() => void load()} />}
    </div>
  );
}
