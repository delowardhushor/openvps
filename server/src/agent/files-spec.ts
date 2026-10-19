/**
 * File manager protocol: request shapes and the validation of paths. Shared by the panel,
 * the agent and the short-lived helper process (fileworker.ts), so it imports nothing
 * but Node built-ins and stays cheap to load.
 */

export class FileSpecError extends Error {
  readonly field: string;
  constructor(field: string, message: string) {
    super(message);
    this.field = field;
  }
}

export const FILE_LIMITS = {
  maxPath: 4096,
  maxName: 255,
  maxDepth: 64,
  /** Entries returned for one folder; bigger folders are cut and flagged. */
  maxEntries: 5000,
  /** Free space kept untouched on the disk when uploading. */
  reserveBytes: 64 * 1024 * 1024,
};

export type FileType = 'file' | 'dir' | 'link' | 'other';

export interface FileEntry {
  name: string;
  type: FileType;
  size: number;
  mtimeMs: number;
  /** Permission bits (e.g. 0o644). */
  mode: number;
  /** For links: what they point at, as far as it can be followed inside the root. */
  link?: 'file' | 'dir' | 'broken' | 'outside' | 'other';
}

export interface FileListing {
  /** Path of the listed folder relative to the root ('' = the root). */
  path: string;
  entries: FileEntry[];
  truncated: boolean;
  disk: { availableBytes: number; totalBytes: number } | null;
}

export interface UploadResult {
  size: number;
  mtimeMs: number;
  replaced: boolean;
}

export interface DownloadHeader {
  name: string;
  size: number;
  mtimeMs: number;
}

/** Requests the helper (and agent) understand. `root` is always one of the configured roots. */
export type FileRequest =
  | { action: 'files.list'; params: { root: string; path: string } }
  | { action: 'files.mkdir'; params: { root: string; path: string } }
  | { action: 'files.move'; params: { root: string; from: string; to: string } }
  | { action: 'files.delete'; params: { root: string; path: string } }
  | { action: 'files.upload'; params: { root: string; path: string; size: number; overwrite: boolean; ifMtimeMs: number | null } }
  | { action: 'files.download'; params: { root: string; path: string; maxBytes: number | null } };

export type FileAction = FileRequest['action'];
export const FILE_ACTIONS: readonly FileAction[] = ['files.list', 'files.mkdir', 'files.move', 'files.delete', 'files.upload', 'files.download'];
/** Actions that carry file contents after the request line. */
export const FILE_STREAM_ACTIONS: readonly FileAction[] = ['files.upload', 'files.download'];

export function isFileAction(a: unknown): a is FileAction {
  return typeof a === 'string' && (FILE_ACTIONS as readonly string[]).includes(a);
}

const CONTROL = /[\u0000-\u001f\u007f]/;

/**
 * A path below a root, written with "/" and no leading slash ('' is the root itself).
 * Refuses ".." and "." segments, empty segments, control characters and over-long names,
 * so the result can be joined to a root without escaping it.
 */
export function parseRelPath(input: unknown, field = 'path', opts: { allowEmpty?: boolean } = {}): string {
  if (typeof input !== 'string') throw new FileSpecError(field, 'The path must be text.');
  let p = input;
  while (p.startsWith('/')) p = p.slice(1);
  while (p.endsWith('/')) p = p.slice(0, -1);
  if (p === '') {
    if (opts.allowEmpty) return '';
    throw new FileSpecError(field, 'A file or folder name is required.');
  }
  if (p.length > FILE_LIMITS.maxPath || Buffer.byteLength(p) > FILE_LIMITS.maxPath) throw new FileSpecError(field, 'The path is too long.');
  if (CONTROL.test(p)) throw new FileSpecError(field, 'The path contains control characters.');
  const parts = p.split('/');
  if (parts.length > FILE_LIMITS.maxDepth) throw new FileSpecError(field, 'The path is nested too deeply.');
  for (const s of parts) {
    if (s === '' || s === '.' || s === '..') throw new FileSpecError(field, 'The path contains an invalid segment.');
    if (Buffer.byteLength(s) > FILE_LIMITS.maxName) throw new FileSpecError(field, 'A name in the path is too long (255 bytes at most).');
  }
  return p;
}

/** A single file or folder name (no "/"). */
export function parseName(input: unknown, field = 'name'): string {
  const p = parseRelPath(input, field);
  if (p.includes('/')) throw new FileSpecError(field, 'A name cannot contain "/".');
  return p;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function parseRoot(v: unknown): string {
  if (typeof v !== 'string' || !v.startsWith('/') || v.length > FILE_LIMITS.maxPath || CONTROL.test(v) || v.split('/').some((s) => s === '..' || s === '.')) {
    throw new FileSpecError('root', 'Invalid folder.');
  }
  return v.length > 1 && v.endsWith('/') ? v.slice(0, -1) : v;
}

/** Validate a files.* request (shape only; the agent checks the root against its allowlist). */
export function parseFileRequest(action: FileAction, p: Record<string, unknown>): FileRequest {
  const root = parseRoot(p.root);
  switch (action) {
    case 'files.list':
      return { action, params: { root, path: parseRelPath(p.path ?? '', 'path', { allowEmpty: true }) } };
    case 'files.mkdir':
    case 'files.delete':
      return { action, params: { root, path: parseRelPath(p.path) } } as FileRequest;
    case 'files.move':
      return { action, params: { root, from: parseRelPath(p.from, 'from'), to: parseRelPath(p.to, 'to') } };
    case 'files.upload': {
      const size = p.size;
      if (typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new FileSpecError('size', 'Invalid file size.');
      const m = p.ifMtimeMs;
      if (m !== null && m !== undefined && (typeof m !== 'number' || !Number.isFinite(m))) throw new FileSpecError('ifMtimeMs', 'Invalid modification time.');
      return { action, params: { root, path: parseRelPath(p.path), size, overwrite: p.overwrite === true, ifMtimeMs: typeof m === 'number' ? m : null } };
    }
    case 'files.download': {
      const mb = p.maxBytes;
      if (mb !== null && mb !== undefined && (typeof mb !== 'number' || !Number.isSafeInteger(mb) || mb < 0)) throw new FileSpecError('maxBytes', 'Invalid size limit.');
      return { action, params: { root, path: parseRelPath(p.path), maxBytes: typeof mb === 'number' ? mb : null } };
    }
  }
}

export const isIn = (root: string, p: string): boolean => p === root || p.startsWith(root.endsWith('/') ? root : root + '/');
