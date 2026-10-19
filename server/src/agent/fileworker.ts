/**
 * The file manager's helper process. The agent starts one for every file operation, running
 * as the user that owns the managed folder (for example `ovapps` for /srv/apps), so the
 * kernel enforces what can be touched: a symlink planted by an app cannot lead this process
 * to files the app's own user could not reach anyway.
 *
 * Protocol: the request is JSON in argv[2]; file contents arrive on stdin (uploads) or leave
 * on stdout (downloads). The answer is one JSON line on stdout, the same envelope the agent
 * uses ({ok:true,result} / {ok:false,error}); a download sends that line first, then the bytes.
 *
 * Only Node built-ins are loaded, to keep each start cheap.
 */
import { constants as C, type Stats } from 'node:fs';
import { link, lstat, mkdir, open, opendir, realpath, rename, rm, stat, statfs, unlink, type FileHandle } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import type { Readable, Writable } from 'node:stream';
import {
  FILE_LIMITS,
  FileSpecError,
  isFileAction,
  isIn,
  parseFileRequest,
  type DownloadHeader,
  type FileEntry,
  type FileListing,
  type FileRequest,
  type UploadResult,
} from './files-spec.ts';

export class FileError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function fsError(e: unknown): FileError {
  if (e instanceof FileError) return e;
  const code = (e as NodeJS.ErrnoException).code;
  switch (code) {
    case 'ENOENT':
      return new FileError('not_found', 'That file or folder does not exist.');
    case 'EACCES':
    case 'EPERM':
      return new FileError('forbidden', 'Permission denied: it belongs to another user than the one that manages this folder.');
    case 'EEXIST':
      return new FileError('exists', 'Something with that name already exists.');
    case 'ENOTDIR':
      return new FileError('not_dir', 'A part of the path is a file, not a folder.');
    case 'EISDIR':
      return new FileError('is_dir', 'That is a folder.');
    case 'ENOTEMPTY':
      return new FileError('not_empty', 'The folder is not empty.');
    case 'EXDEV':
      return new FileError('cross_device', 'It cannot be moved to another disk.');
    case 'ENOSPC':
    case 'EDQUOT':
      return new FileError('no_space', 'The disk is full.');
    case 'EROFS':
      return new FileError('forbidden', 'The disk is read-only.');
    case 'ELOOP':
      return new FileError('forbidden', 'The path loops through a symbolic link.');
    default:
      return new FileError('io', `The file system reported an error${code ? ` (${code})` : ''}.`);
  }
}

const outside = () => new FileError('forbidden', 'That path leads outside the managed folder.');

async function real(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch (e) {
    throw fsError(e);
  }
}

/** The folder that holds `rel`, resolved through links but required to stay inside the root. */
async function parentOf(root: string, rel: string): Promise<{ dir: string; name: string }> {
  const parts = rel.split('/');
  const name = parts.pop()!;
  const dir = parts.length ? await real(join(root, ...parts)) : root;
  if (!isIn(root, dir)) throw outside();
  return { dir, name };
}

/** An existing entry. Links are followed (and must stay inside the root) only when `follow` is set. */
async function existing(root: string, rel: string, follow: boolean) {
  if (rel === '') {
    try {
      return { path: root, st: await stat(root) };
    } catch (e) {
      throw fsError(e);
    }
  }
  const { dir, name } = await parentOf(root, rel);
  let path = join(dir, name);
  try {
    let st = await lstat(path);
    if (st.isSymbolicLink() && follow) {
      path = await real(path);
      if (!isIn(root, path)) throw outside();
      st = await stat(path);
    }
    return { path, st };
  } catch (e) {
    throw fsError(e);
  }
}

/** Create the missing folders of `parts` below the root, one at a time, never leaving it. */
async function ensureDirs(root: string, parts: string[]): Promise<string> {
  let cur = root;
  for (const seg of parts) {
    const next = join(cur, seg);
    try {
      const st = await lstat(next);
      if (st.isSymbolicLink()) {
        const r = await real(next);
        if (!isIn(root, r)) throw outside();
        if (!(await stat(r)).isDirectory()) throw new FileError('not_dir', `"${seg}" is a file, not a folder.`);
        cur = r;
      } else if (st.isDirectory()) {
        cur = next;
      } else {
        throw new FileError('not_dir', `"${seg}" is a file, not a folder.`);
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw fsError(e);
      try {
        await mkdir(next, { mode: 0o755 });
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code !== 'EEXIST') throw fsError(e2);
      }
      cur = next;
    }
  }
  return cur;
}

async function writeAll(fh: FileHandle, buf: Buffer): Promise<void> {
  let off = 0;
  while (off < buf.length) {
    const { bytesWritten } = await fh.write(buf, off, buf.length - off);
    off += bytesWritten;
  }
}

const typeOf = (st: { isFile(): boolean; isDirectory(): boolean; isSymbolicLink(): boolean }) =>
  st.isSymbolicLink() ? 'link' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';

async function list(root: string, rel: string): Promise<FileListing> {
  const { path, st } = await existing(root, rel, true);
  if (!st.isDirectory()) throw new FileError('not_dir', 'That is a file, not a folder.');
  const names: string[] = [];
  let truncated = false;
  try {
    for await (const d of await opendir(path)) {
      if (names.length >= FILE_LIMITS.maxEntries) {
        truncated = true;
        break;
      }
      names.push(d.name);
    }
  } catch (e) {
    throw fsError(e);
  }
  const entries: FileEntry[] = [];
  for (let i = 0; i < names.length; i += 64) {
    const batch = await Promise.all(
      names.slice(i, i + 64).map(async (name): Promise<FileEntry | null> => {
        const p = join(path, name);
        try {
          const s = await lstat(p);
          const e: FileEntry = { name, type: typeOf(s), size: s.isFile() ? s.size : 0, mtimeMs: Math.round(s.mtimeMs), mode: s.mode & 0o7777 };
          if (s.isSymbolicLink()) {
            try {
              const r = await realpath(p);
              if (!isIn(root, r)) e.link = 'outside';
              else {
                const t = await stat(r);
                e.link = t.isDirectory() ? 'dir' : t.isFile() ? 'file' : 'other';
              }
            } catch {
              e.link = 'broken';
            }
          }
          return e;
        } catch {
          return null; // vanished while listing
        }
      }),
    );
    for (const e of batch) if (e) entries.push(e);
  }
  let disk: FileListing['disk'] = null;
  try {
    const f = await statfs(path);
    disk = { availableBytes: Number(f.bavail) * Number(f.bsize), totalBytes: Number(f.blocks) * Number(f.bsize) };
  } catch {
    /* not available */
  }
  return { path: rel, entries, truncated, disk };
}

async function upload(root: string, p: Extract<FileRequest, { action: 'files.upload' }>['params'], stdin: Readable): Promise<UploadResult> {
  const parts = p.path.split('/');
  const name = parts.pop()!;
  const dir = await ensureDirs(root, parts);
  const dest = join(dir, name);

  let prev: Stats | null = null;
  try {
    prev = await lstat(dest);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw fsError(e);
  }
  if (prev?.isDirectory()) throw new FileError('is_dir', `"${name}" is a folder.`);
  if (prev && !p.overwrite) throw new FileError('exists', `"${name}" already exists.`);
  if (prev && !prev.isFile()) throw new FileError('exists', `"${name}" is a link or special file and is not replaced.`);
  if (prev && p.ifMtimeMs !== null && Math.abs(prev.mtimeMs - p.ifMtimeMs) >= 1) {
    throw new FileError('changed', 'The file changed on the server since you opened it.');
  }
  try {
    const f = await statfs(dir);
    const free = Number(f.bavail) * Number(f.bsize);
    const reserve = Math.min(FILE_LIMITS.reserveBytes, Math.floor((Number(f.blocks) * Number(f.bsize)) / 50));
    if (free < p.size + reserve) throw new FileError('no_space', 'There is not enough free disk space for this file.');
  } catch (e) {
    if (e instanceof FileError) throw e; // statfs itself failing is not a reason to refuse
  }

  const tmp = join(dir, `.openvps-upload-${randomBytes(8).toString('hex')}`);
  let fh: FileHandle | null = null;
  try {
    fh = await open(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o644);
    let received = 0;
    for await (const chunk of stdin) {
      const buf = chunk as Buffer;
      received += buf.length;
      if (received > p.size) throw new FileError('too_large', 'More data arrived than announced.');
      await writeAll(fh, buf);
    }
    if (received !== p.size) throw new FileError('incomplete', 'The upload was interrupted.');
    await fh.chmod(prev ? prev.mode & 0o7777 : 0o644);
    await fh.datasync();
    await fh.close();
    fh = null;
    if (prev) {
      await rename(tmp, dest);
    } else {
      await link(tmp, dest); // fails if something appeared meanwhile, instead of replacing it
      await unlink(tmp);
    }
    const s = await lstat(dest);
    return { size: s.size, mtimeMs: Math.round(s.mtimeMs), replaced: prev !== null };
  } catch (e) {
    if (fh) await fh.close().catch(() => undefined);
    await unlink(tmp).catch(() => undefined);
    throw fsError(e);
  }
}

const line = (res: unknown) => JSON.stringify(res) + '\n';
const ok = (result: unknown) => line({ ok: true, result });
const fail = (code: string, message: string, field?: string) => line({ ok: false, error: { code, message, ...(field ? { field } : {}) } });

/** Run one request. Answers (and file bytes for downloads) go to `out`. */
export async function runRequest(req: FileRequest, stdin: Readable, out: Writable): Promise<void> {
  const root = await real(req.params.root);
  switch (req.action) {
    case 'files.list':
      out.write(ok(await list(root, req.params.path)));
      return;
    case 'files.mkdir': {
      const { dir, name } = await parentOf(root, req.params.path);
      try {
        await mkdir(join(dir, name), { mode: 0o755 });
      } catch (e) {
        throw fsError(e);
      }
      out.write(ok({}));
      return;
    }
    case 'files.move': {
      const from = await existing(root, req.params.from, false);
      const { dir, name } = await parentOf(root, req.params.to);
      const dest = join(dir, name);
      if (from.st.isDirectory() && (dest === from.path || dest.startsWith(from.path + '/'))) {
        throw new FileError('invalid', 'A folder cannot be moved into itself.');
      }
      try {
        await lstat(dest);
        throw new FileError('exists', `"${name}" already exists in the destination.`);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw fsError(e);
      }
      try {
        await rename(from.path, dest);
      } catch (e) {
        throw fsError(e);
      }
      out.write(ok({}));
      return;
    }
    case 'files.delete': {
      const { path, st } = await existing(root, req.params.path, false);
      try {
        if (st.isDirectory()) await rm(path, { recursive: true, force: false });
        else await unlink(path);
      } catch (e) {
        throw fsError(e);
      }
      out.write(ok({ type: typeOf(st) }));
      return;
    }
    case 'files.upload':
      out.write(ok(await upload(root, req.params, stdin)));
      return;
    case 'files.download': {
      const { path, st } = await existing(root, req.params.path, true);
      if (!st.isFile()) throw new FileError('invalid', 'Only files can be downloaded.');
      if (req.params.maxBytes !== null && st.size > req.params.maxBytes) throw new FileError('too_large', 'The file is too large for this.');
      let fh: FileHandle;
      try {
        // O_NONBLOCK keeps a swapped-in FIFO from hanging the open; the check below rejects it.
        fh = await open(path, C.O_RDONLY | C.O_NONBLOCK | C.O_NOFOLLOW);
      } catch (e) {
        throw fsError(e);
      }
      try {
        const fst = await fh.stat();
        if (!fst.isFile()) throw new FileError('invalid', 'Only files can be downloaded.');
        const header: DownloadHeader = { name: basename(path), size: fst.size, mtimeMs: Math.round(fst.mtimeMs) };
        out.write(ok(header));
        await pipeline(fh.createReadStream({ start: 0, end: fst.size > 0 ? fst.size - 1 : undefined, autoClose: false, emitClose: false }), out, { end: false });
      } finally {
        await fh.close().catch(() => undefined);
      }
      return;
    }
  }
}

/** Process entry: parse argv, run, report errors in the same envelope. */
export async function main(argv: string[], stdin: Readable, out: Writable): Promise<void> {
  try {
    process.umask(0o022);
    const raw = JSON.parse(argv[2] ?? '') as { action?: unknown; params?: Record<string, unknown> };
    if (!isFileAction(raw.action)) throw new FileError('invalid', 'Unknown file action.');
    const req = parseFileRequest(raw.action, raw.params ?? {});
    await runRequest(req, stdin, out);
  } catch (e) {
    if (e instanceof FileSpecError) out.write(fail('invalid', e.message, e.field));
    else {
      const fe = fsError(e);
      out.write(fail(fe.code, fe.message));
    }
  }
}

const self = process.argv[1] ? basename(process.argv[1]) : '';
if (self === 'fileworker.js' || self === 'fileworker.ts') {
  void main(process.argv, process.stdin, process.stdout).then(
    () => {
      process.exitCode = 0;
    },
    () => {
      process.exitCode = 1;
    },
  );
}
