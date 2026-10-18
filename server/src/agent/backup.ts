import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, createReadStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { dirname, join, sep } from 'node:path';
import type { Logger } from '../logger.ts';
import { AgentError } from './pm2.ts';
import { runTool, tail } from './exec.ts';
import { S3Client, S3Error } from './s3.ts';
import {
  ARTIFACT,
  MEMBER_FILE,
  PLAN_NAME,
  SOURCE_NAME,
  artifactName,
  artifactTime,
  type ArtifactInfo,
  type ArtifactRef,
  type BackupJobSpec,
  type BackupJobStatus,
  type BackupJobView,
  type BackupStatus,
  type Manifest,
  type ManifestMember,
  type RestoreSpec,
  type Retention,
  type S3Access,
} from './backup-spec.ts';

/**
 * Backups, run by the agent because it can read every app's files. Everything is a
 * background job (one at a time) the panel polls. The agent holds no credentials:
 * database connection strings and storage keys arrive with each request.
 *
 * An artifact is one uncompressed tar holding manifest.json plus one gzip-compressed
 * member per source (files-<source>.tar.gz, mongodb-<source>[--<db>].archive.gz), named
 * <plan>-<UTC time>.ovbk.tar, with a <name>.json sidecar (the manifest plus the artifact's
 * size and SHA-256) written last, so a sidecar means the backup is complete.
 */

const HOUR = 3_600_000;
const TOOL_TIMEOUT = 12 * HOUR;
const KEEP_JOBS = 20;
const LOG_LINES = 200;

type S3Api = Pick<S3Client, 'head' | 'putText' | 'getText' | 'downloadTo' | 'delete' | 'list' | 'putFile'>;

export interface BackupOptions {
  /** Where local backups live (root only). */
  dir: string;
  /** Folders that may be backed up and restored into. */
  fileRoots: string[];
  tarBin: string | null;
  /** `nice`, to keep long compression jobs from starving the apps on a small VPS. */
  niceBin?: string | null;
  mongodumpBin: string | null;
  mongorestoreBin: string | null;
  version: string;
  hostname: string;
  log: Logger;
  /** Test hooks. */
  s3?: (access: S3Access) => S3Api;
  now?: () => Date;
}

interface JobCtx {
  id: string;
  step(text: string): void;
}

interface Job extends BackupJobView {
  _kind: 'backup' | 'restore' | 'verify';
}

interface Destinations {
  local?: { ok: boolean; error?: string };
  s3?: { ok: boolean; error?: string };
}

export function selectDoomed(names: string[], ret: Retention, now: number): string[] {
  const sorted = names
    .map((n) => ({ n, t: artifactTime(n) ?? 0 }))
    .sort((a, b) => b.t - a.t);
  return sorted
    .filter((e, i) => i >= ret.keepLast || (ret.maxAgeDays !== null && i > 0 && now - e.t > ret.maxAgeDays * 24 * HOUR))
    .map((e) => e.n);
}

export async function hashFile(path: string): Promise<{ sha256: string; sizeBytes: number }> {
  const h = createHash('sha256');
  let n = 0;
  for await (const c of createReadStream(path)) {
    h.update(c as Buffer);
    n += (c as Buffer).length;
  }
  return { sha256: h.digest('hex'), sizeBytes: n };
}

/** Remove secrets (and anything that looks like a URL password) from text shown to people. */
function scrub(text: string, secrets: string[]): string {
  let out = text;
  for (const s of secrets) if (s.length >= 4) out = out.split(s).join('***');
  return out.replace(/(mongodb(?:\+srv)?:\/\/[^:@/\s]*):[^@/\s]*@/g, '$1:***@');
}

function secretsOf(mongoUris: Record<string, string>, s3: S3Access | null): string[] {
  const out: string[] = [];
  for (const uri of Object.values(mongoUris)) {
    out.push(uri);
    const m = /^mongodb(?:\+srv)?:\/\/[^:@/]*:([^@/]*)@/.exec(uri);
    if (m?.[1]) {
      out.push(m[1]);
      try {
        out.push(decodeURIComponent(m[1]));
      } catch {
        /* not percent-encoded */
      }
    }
  }
  if (s3) out.push(s3.secrets.secretAccessKey);
  return out;
}

export class BackupManager {
  readonly o: BackupOptions;
  private readonly jobs = new Map<string, Job>();
  private active: Job | null = null;
  private swept = false;

  constructor(o: BackupOptions) {
    this.o = o;
  }

  // ---- plumbing -----------------------------------------------------------------

  private now(): Date {
    return this.o.now ? this.o.now() : new Date();
  }

  private s3(access: S3Access): S3Api {
    return this.o.s3 ? this.o.s3(access) : new S3Client(access);
  }

  /** Run a CPU-heavy tool at low priority when `nice` is available. */
  private heavy(bin: string, args: string[], timeoutMs = TOOL_TIMEOUT) {
    return this.o.niceBin ? runTool(this.o.niceBin, ['-n', '10', bin, ...args], { timeoutMs }) : runTool(bin, args, { timeoutMs });
  }

  private requireTar(): string {
    if (!this.o.tarBin) throw new AgentError('tool_missing', 'tar was not found on this server.');
    return this.o.tarBin;
  }

  private stagingRoot(): string {
    return join(this.o.dir, '.staging');
  }

  private ensureDirs(): void {
    mkdirSync(this.o.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.stagingRoot(), { recursive: true, mode: 0o700 });
    if (!this.swept && !this.active) {
      // Leftovers from a job interrupted by a restart.
      this.swept = true;
      for (const e of readdirSync(this.stagingRoot())) rmSync(join(this.stagingRoot(), e), { recursive: true, force: true });
    }
  }

  private realRoots(): string[] {
    const out: string[] = [];
    for (const r of this.o.fileRoots) {
      try {
        out.push(realpathSync(r));
      } catch {
        /* root does not exist yet */
      }
    }
    return out;
  }

  private inside(path: string, roots: string[]): boolean {
    return roots.some((r) => path === r || path.startsWith(r.endsWith(sep) ? r : r + sep));
  }

  /** An existing folder inside the backup roots; returns its real path. */
  private checkSourcePath(path: string, field: string): string {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      throw new AgentError('invalid', `The folder ${path} does not exist.`, field);
    }
    if (!statSync(real).isDirectory()) throw new AgentError('invalid', `${path} is not a folder.`, field);
    if (!this.inside(real, this.realRoots())) {
      throw new AgentError('invalid', `Folders to back up must be inside ${this.o.fileRoots.join(' or ')}.`, field);
    }
    return real;
  }

  /** Where "restore to original location" would write, created if missing; refuses anything outside the roots. */
  private prepareOriginal(path: string): string {
    if (!path.startsWith('/') || path.split('/').includes('..') || path.includes('\0')) throw new AgentError('invalid', 'The backup records an invalid folder.');
    const roots = this.realRoots();
    // Resolve the nearest existing ancestor so a symlink cannot lead out of the roots.
    let probe = path;
    while (!existsSync(probe) && probe !== '/') probe = dirname(probe);
    const real = realpathSync(probe);
    if (!this.inside(real, roots) || (!this.inside(path, this.o.fileRoots) && !this.inside(path, roots))) {
      throw new AgentError('forbidden', `${path} is outside the folders OpenVPS may restore into (${this.o.fileRoots.join(', ')}).`);
    }
    mkdirSync(path, { recursive: true });
    if (!this.inside(realpathSync(path), roots)) throw new AgentError('forbidden', `${path} is outside the folders OpenVPS may restore into.`);
    return realpathSync(path);
  }

  private artifactDir(plan: string): string {
    return join(this.o.dir, plan);
  }

  private localPath(ref: ArtifactRef): string {
    return join(this.artifactDir(ref.plan), ref.name);
  }

  private key(access: S3Access, ref: { plan: string; name: string }): string {
    return `${access.target.prefix}${ref.plan}/${ref.name}`;
  }

  // ---- jobs -----------------------------------------------------------------------

  private start(kind: 'backup' | 'restore' | 'verify', plan: string, secrets: string[], fn: (ctx: JobCtx) => Promise<{ status?: BackupJobStatus } & Record<string, unknown>>): BackupJobView {
    if (this.active) {
      throw new AgentError('busy', `Another backup task is already running (${this.active.kind} of "${this.active.plan}"). Try again when it has finished.`);
    }
    this.ensureDirs();
    const job: Job = {
      _kind: kind,
      id: randomBytes(8).toString('hex'),
      kind,
      plan,
      status: 'running',
      startedAt: Date.now(),
      finishedAt: null,
      step: 'Starting',
      log: [],
      result: null,
      error: null,
    };
    this.jobs.set(job.id, job);
    this.active = job;
    const ctx: JobCtx = {
      id: job.id,
      step: (text) => {
        job.step = text;
        job.log.push(`${new Date().toISOString().slice(11, 19)} ${text}`);
        if (job.log.length > LOG_LINES) job.log.splice(0, job.log.length - LOG_LINES);
      },
    };
    this.o.log.info('backup job started', { id: job.id, kind, plan });
    void fn(ctx)
      .then((res) => {
        job.result = res;
        job.status = res.status ?? 'succeeded';
      })
      .catch((e: unknown) => {
        job.status = 'failed';
        if (e instanceof AgentError) job.error = { code: e.code, message: scrub(e.message, secrets) };
        else if (e instanceof S3Error) job.error = { code: 's3_failed', message: scrub(`${e.code}: ${e.message}`, secrets) };
        else {
          this.o.log.error('backup job crashed', { id: job.id, error: e as Error });
          job.error = { code: 'internal', message: 'The backup task hit an internal error. See: journalctl -u openvps-agent' };
        }
        ctx.step(`Failed: ${job.error?.message ?? 'unknown error'}`);
      })
      .finally(() => {
        job.finishedAt = Date.now();
        this.active = null;
        this.o.log.info('backup job finished', { id: job.id, kind, plan, status: job.status });
        const done = [...this.jobs.values()].filter((j) => j.finishedAt !== null).sort((a, b) => a.finishedAt! - b.finishedAt!);
        for (const j of done.slice(0, Math.max(0, done.length - KEEP_JOBS))) this.jobs.delete(j.id);
      });
    return this.view(job);
  }

  private view(j: Job): BackupJobView {
    const { _kind, ...v } = j;
    void _kind;
    return { ...v, log: [...v.log] };
  }

  job(id: string): BackupJobView {
    const j = this.jobs.get(id);
    if (!j) throw new AgentError('not_found', 'That backup task is no longer known to the agent (it may have restarted).');
    return this.view(j);
  }

  // ---- status ---------------------------------------------------------------------

  async status(): Promise<BackupStatus> {
    const version = async (bin: string | null) => {
      if (!bin) return null;
      const r = await runTool(bin, ['--version'], { timeoutMs: 5000 });
      return { path: bin, version: r.code === 0 ? (r.stdout.split('\n')[0]?.trim() ?? null) : null };
    };
    let freeBytes: number | null = null;
    try {
      let probe = this.o.dir;
      while (!existsSync(probe) && probe !== '/') probe = dirname(probe);
      const s = statfsSync(probe);
      freeBytes = Number(s.bavail) * Number(s.bsize);
    } catch {
      /* unknown */
    }
    return {
      dir: this.o.dir,
      freeBytes,
      tar: !!this.o.tarBin,
      mongodump: await version(this.o.mongodumpBin),
      mongorestore: await version(this.o.mongorestoreBin),
      fileRoots: this.o.fileRoots,
      running: this.active ? { id: this.active.id, kind: this.active.kind, plan: this.active.plan } : null,
    };
  }

  // ---- backup ---------------------------------------------------------------------

  startBackup(spec: BackupJobSpec): BackupJobView {
    this.requireTar();
    for (const [i, s] of spec.sources.entries()) {
      if (s.type === 'files') this.checkSourcePath(s.path, `sources[${i}]`);
      else if (!this.o.mongodumpBin) {
        throw new AgentError('tool_missing', 'mongodump is not installed. Install the MongoDB Database Tools (see docs/backups.md) to back up MongoDB.');
      }
    }
    return this.start('backup', spec.plan, secretsOf(spec.mongoUris, spec.s3), (ctx) => this.runBackup(spec, ctx));
  }

  private async runBackup(spec: BackupJobSpec, ctx: JobCtx): Promise<Record<string, unknown> & { status: BackupJobStatus }> {
    const tar = this.requireTar();
    const secrets = secretsOf(spec.mongoUris, spec.s3);
    const createdAt = this.now();
    const name = artifactName(spec.plan, createdAt);
    const stage = join(this.stagingRoot(), ctx.id);
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    const warnings: string[] = [];
    try {
      const members: ManifestMember[] = [];
      const addMember = async (m: Omit<ManifestMember, 'sizeBytes' | 'sha256'>) => {
        const h = await hashFile(join(stage, m.file));
        members.push({ ...m, ...h });
      };

      for (const src of spec.sources) {
        if (src.type === 'files') {
          const real = this.checkSourcePath(src.path, 'sources');
          const file = `files-${src.name}.tar.gz`;
          ctx.step(`Archiving ${src.path}`);
          const r = await this.heavy(tar, ['-czf', join(stage, file), '--numeric-owner', ...src.exclude.map((e) => `--exclude=${e}`), '-C', real, '.']);
          if (r.code === 1 && /changed as we read|file changed|differ|removed|vanished/i.test(r.stderr)) {
            warnings.push(`${src.name}: some files changed while they were being archived.`);
          } else if (r.code !== 0) {
            throw new AgentError('backup_failed', `Could not archive ${src.path}: ${tail(r.stderr, 3) || 'tar failed'}`);
          }
          await addMember({ file, kind: 'files', source: src.name, path: real, exclude: src.exclude });
        } else {
          const bin = this.o.mongodumpBin!;
          const uri = spec.mongoUris[src.name]!;
          const cfg = join(stage, `.mongo-${src.name}.yml`);
          writeFileSync(cfg, `uri: ${JSON.stringify(uri)}\n`, { mode: 0o600 });
          try {
            for (const db of src.databases.length ? src.databases : [null]) {
              const file = db ? `mongodb-${src.name}--${db}.archive.gz` : `mongodb-${src.name}.archive.gz`;
              ctx.step(`Dumping MongoDB ${db ? `database ${db}` : `"${src.name}"`}`);
              const r = await this.heavy(bin, ['--config', cfg, `--archive=${join(stage, file)}`, '--gzip', '--quiet', ...(db ? ['--db', db] : [])]);
              if (r.code !== 0) {
                throw new AgentError('backup_failed', `MongoDB dump of "${src.name}" failed: ${scrub(tail(r.stderr, 3), secrets) || 'mongodump failed'}`);
              }
              await addMember({ file, kind: 'mongodb', source: src.name, database: db });
            }
          } finally {
            rmSync(cfg, { force: true });
          }
        }
      }

      const manifest: Manifest = {
        format: 1,
        plan: spec.plan,
        artifact: name,
        createdAt: createdAt.getTime(),
        hostname: this.o.hostname,
        openvpsVersion: this.o.version,
        members,
      };
      writeFileSync(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
      ctx.step('Packing the backup');
      const packed = join(stage, 'artifact.tar');
      const pr = await runTool(tar, ['-cf', packed, '-C', stage, 'manifest.json', ...members.map((m) => m.file)], { timeoutMs: TOOL_TIMEOUT });
      if (pr.code !== 0) throw new AgentError('backup_failed', `Could not pack the backup: ${tail(pr.stderr, 3)}`);
      // Do not rely on the service's UMask: the finished file is readable by root only.
      chmodSync(packed, 0o600);
      ctx.step('Calculating checksum');
      const { sha256, sizeBytes } = await hashFile(packed);
      const sidecar = JSON.stringify({ ...manifest, artifactSizeBytes: sizeBytes, artifactSha256: sha256 }, null, 2);

      const destinations: Destinations = {};
      let source = packed;
      if (spec.local) {
        ctx.step('Saving on this server');
        try {
          const dir = this.artifactDir(spec.plan);
          mkdirSync(dir, { recursive: true, mode: 0o700 });
          const final = join(dir, name);
          renameSync(packed, final);
          source = final;
          const tmp = `${final}.json.tmp`;
          writeFileSync(tmp, sidecar, { mode: 0o600 });
          renameSync(tmp, `${final}.json`);
          destinations.local = { ok: true };
        } catch (e) {
          destinations.local = { ok: false, error: (e as Error).message };
          warnings.push(`Could not save on this server: ${(e as Error).message}`);
        }
      }
      if (spec.s3) {
        const client = this.s3(spec.s3);
        try {
          ctx.step(`Uploading to ${spec.s3.target.bucket} (${(sizeBytes / 1048576).toFixed(1)} MB)`);
          const key = this.key(spec.s3, { plan: spec.plan, name });
          await client.putFile(key, source, sha256);
          const head = await client.head(key);
          if (!head || head.size !== sizeBytes) throw new AgentError('s3_failed', 'The uploaded file is not the expected size.');
          await client.putText(`${key}.json`, sidecar);
          destinations.s3 = { ok: true };
        } catch (e) {
          const msg = scrub(e instanceof S3Error ? `${e.code}: ${e.message}` : (e as Error).message, secrets);
          destinations.s3 = { ok: false, error: msg };
          warnings.push(`Upload failed: ${msg}`);
        }
      }

      const results = Object.values(destinations);
      const okCount = results.filter((r) => r.ok).length;
      if (okCount === 0) {
        throw new AgentError('backup_failed', `The backup was created but could not be stored: ${results.map((r) => r.error).filter(Boolean).join('; ')}`);
      }

      const pruned = { local: 0, s3: 0 };
      if (destinations.local?.ok) {
        try {
          pruned.local = this.pruneLocal(spec.plan, spec.retention);
        } catch (e) {
          warnings.push(`Old backups could not be cleaned up on this server: ${(e as Error).message}`);
        }
      }
      if (destinations.s3?.ok && spec.s3) {
        try {
          pruned.s3 = await this.pruneRemote(spec.plan, spec.retention, spec.s3);
        } catch (e) {
          warnings.push(`Old backups could not be cleaned up in the bucket: ${scrub((e as Error).message, secrets)}`);
        }
      }
      ctx.step('Done');
      return {
        status: okCount === results.length ? 'succeeded' : 'partial',
        artifact: name,
        sizeBytes,
        sha256,
        createdAt: createdAt.getTime(),
        destinations,
        pruned,
        warnings,
      };
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  private pruneLocal(plan: string, ret: Retention): number {
    const dir = this.artifactDir(plan);
    if (!existsSync(dir)) return 0;
    const names = readdirSync(dir).filter((n) => ARTIFACT.exec(n)?.[1] === plan);
    const doomed = selectDoomed(names, ret, this.now().getTime());
    for (const n of doomed) {
      rmSync(join(dir, n), { force: true });
      rmSync(join(dir, `${n}.json`), { force: true });
    }
    return doomed.length;
  }

  private async pruneRemote(plan: string, ret: Retention, access: S3Access): Promise<number> {
    const client = this.s3(access);
    const prefix = `${access.target.prefix}${plan}/`;
    const names = (await client.list(prefix)).map((o) => o.key.slice(prefix.length)).filter((n) => ARTIFACT.exec(n)?.[1] === plan);
    const doomed = selectDoomed(names, ret, this.now().getTime());
    for (const n of doomed) {
      await client.delete(prefix + n);
      await client.delete(`${prefix}${n}.json`);
    }
    return doomed.length;
  }

  // ---- listing and inspection -------------------------------------------------------

  async list(plan: string | null, access: S3Access | null): Promise<{ local: ArtifactInfo[]; remote: ArtifactInfo[] | null; remoteError: string | null }> {
    if (plan !== null && !PLAN_NAME.test(plan)) throw new AgentError('invalid', 'Invalid plan name.', 'plan');
    const local: ArtifactInfo[] = [];
    if (existsSync(this.o.dir)) {
      for (const p of plan ? [plan] : readdirSync(this.o.dir).filter((n) => PLAN_NAME.test(n))) {
        const dir = this.artifactDir(p);
        if (!existsSync(dir)) continue;
        for (const n of readdirSync(dir)) {
          const m = ARTIFACT.exec(n);
          if (!m || m[1] !== p) continue;
          local.push({ where: 'local', plan: p, name: n, sizeBytes: statSync(join(dir, n)).size, createdAt: artifactTime(n)!, complete: existsSync(join(dir, `${n}.json`)) });
        }
      }
    }
    let remote: ArtifactInfo[] | null = null;
    let remoteError: string | null = null;
    if (access) {
      try {
        const prefix = access.target.prefix + (plan ? `${plan}/` : '');
        const objects = await this.s3(access).list(prefix);
        const keys = new Set(objects.map((o) => o.key));
        remote = [];
        for (const o of objects) {
          const rel = o.key.slice(access.target.prefix.length).split('/');
          const m = rel.length === 2 ? ARTIFACT.exec(rel[1]!) : null;
          if (!m || m[1] !== rel[0]) continue;
          remote.push({ where: 's3', plan: m[1]!, name: rel[1]!, sizeBytes: o.size, createdAt: artifactTime(rel[1]!)!, complete: keys.has(`${o.key}.json`) });
        }
        remote.sort((a, b) => b.createdAt - a.createdAt);
      } catch (e) {
        remoteError = scrub(e instanceof S3Error ? `${e.code}: ${e.message}` : (e as Error).message, access ? [access.secrets.secretAccessKey] : []);
      }
    }
    local.sort((a, b) => b.createdAt - a.createdAt);
    return { local, remote, remoteError };
  }

  private async readManifest(ref: ArtifactRef, access: S3Access | null): Promise<Manifest> {
    let text: string;
    if (ref.where === 'local') {
      const file = `${this.localPath(ref)}.json`;
      if (!existsSync(file)) throw new AgentError('not_found', 'That backup is not on this server, or it was not completed.');
      text = readFileSync(file, 'utf8');
    } else {
      if (!access) throw new AgentError('invalid', 'Missing storage settings.');
      try {
        text = await this.s3(access).getText(`${this.key(access, ref)}.json`);
      } catch (e) {
        if (e instanceof S3Error && e.status === 404) throw new AgentError('not_found', 'That backup is not in the bucket, or it was not completed.');
        throw e;
      }
    }
    let m: Manifest;
    try {
      m = JSON.parse(text) as Manifest;
    } catch {
      throw new AgentError('bad_manifest', 'The backup description is unreadable.');
    }
    const ok =
      m.format === 1 &&
      m.plan === ref.plan &&
      m.artifact === ref.name &&
      Array.isArray(m.members) &&
      m.members.length > 0 &&
      m.members.every(
        (x) =>
          typeof x.file === 'string' &&
          MEMBER_FILE.test(x.file) &&
          (x.kind === 'files' || x.kind === 'mongodb') &&
          typeof x.source === 'string' &&
          SOURCE_NAME.test(x.source) &&
          typeof x.sha256 === 'string' &&
          /^[0-9a-f]{64}$/.test(x.sha256) &&
          (x.kind === 'mongodb' || (typeof x.path === 'string' && x.path.startsWith('/') && !x.path.split('/').includes('..'))),
      );
    if (!ok) throw new AgentError('bad_manifest', 'The backup description is not valid.');
    return m;
  }

  /** The manifest plus, for each folder, what is at its original location now (for overwrite warnings). */
  async inspect(ref: ArtifactRef, access: S3Access | null) {
    const manifest = await this.readManifest(ref, access);
    const roots = this.realRoots();
    const members = manifest.members.map((m) => {
      if (m.kind !== 'files' || !m.path) return { ...m, current: null };
      // The path comes from the backup's description: only look at it when it is inside the roots.
      const allowed = this.inside(m.path, this.o.fileRoots) || this.inside(m.path, roots);
      let exists = false;
      let entries = 0;
      if (allowed) {
        try {
          exists = statSync(m.path).isDirectory();
          if (exists) entries = readdirSync(m.path).length;
        } catch {
          /* missing */
        }
      }
      return { ...m, current: { exists, entries, allowed } };
    });
    return { manifest, members };
  }

  // ---- restore ----------------------------------------------------------------------

  startRestore(spec: RestoreSpec): BackupJobView {
    this.requireTar();
    return this.start('restore', spec.ref.plan, secretsOf(spec.mongoUris, spec.s3), (ctx) => this.runRestore(spec, ctx));
  }

  private async runRestore(spec: RestoreSpec, ctx: JobCtx): Promise<Record<string, unknown>> {
    const tar = this.requireTar();
    const secrets = secretsOf(spec.mongoUris, spec.s3);
    ctx.step('Reading the backup description');
    const manifest = await this.readManifest(spec.ref, spec.s3);
    const chosen = spec.items.map((it) => {
      const member = manifest.members.find((m) => m.file === it.file);
      if (!member) throw new AgentError('invalid', `This backup does not contain ${it.file}.`, 'items');
      if (member.kind === 'mongodb') {
        if (!this.o.mongorestoreBin) throw new AgentError('tool_missing', 'mongorestore is not installed. Install the MongoDB Database Tools (see docs/backups.md).');
        if (!spec.mongoUris[member.source]) throw new AgentError('invalid', `No MongoDB connection is configured for "${member.source}".`, 'items');
      }
      return { member, item: it };
    });

    const stage = join(this.stagingRoot(), ctx.id);
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    try {
      let artifact = this.localPath(spec.ref);
      if (spec.ref.where === 's3') {
        ctx.step('Downloading the backup');
        artifact = join(stage, 'artifact.tar');
        await this.s3(spec.s3!).downloadTo(this.key(spec.s3!, spec.ref), artifact);
      } else if (!existsSync(artifact)) {
        throw new AgentError('not_found', 'That backup is not on this server.');
      }
      if (manifest.artifactSha256) {
        ctx.step('Checking the backup is intact');
        const h = await hashFile(artifact);
        if (h.sha256 !== manifest.artifactSha256) {
          throw new AgentError('integrity', 'The backup file does not match its checksum. It is damaged or was changed; nothing was restored.');
        }
      }

      const restored: Array<{ file: string; source: string; kind: string; target: string }> = [];
      const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
      for (const { member, item } of chosen) {
        ctx.step(`Restoring ${member.kind === 'files' ? member.path : `MongoDB "${member.source}"`}`);
        const x = await runTool(tar, ['-xf', artifact, '-C', stage, member.file], { timeoutMs: TOOL_TIMEOUT });
        if (x.code !== 0) throw new AgentError('restore_failed', `Could not read ${member.file} from the backup: ${tail(x.stderr, 3)}`);
        const file = join(stage, member.file);
        if ((await hashFile(file)).sha256 !== member.sha256) {
          throw new AgentError('integrity', `${member.file} does not match its checksum; it was not restored.`);
        }
        if (member.kind === 'files') {
          const dest =
            item.target === 'original'
              ? this.prepareOriginal(member.path!)
              : (() => {
                  const d = join(this.o.dir, '.restores', `${spec.ref.plan}-${stamp}`, member.source);
                  mkdirSync(d, { recursive: true, mode: 0o700 });
                  return d;
                })();
          const r = await runTool(tar, ['-xzf', file, '-C', dest, '--numeric-owner', '-p'], { timeoutMs: TOOL_TIMEOUT });
          if (r.code !== 0) throw new AgentError('restore_failed', `Could not restore ${member.path}: ${tail(r.stderr, 3)}`);
          restored.push({ file: member.file, source: member.source, kind: 'files', target: dest });
        } else {
          const cfg = join(stage, `.mongo-${member.source}.yml`);
          writeFileSync(cfg, `uri: ${JSON.stringify(spec.mongoUris[member.source])}\n`, { mode: 0o600 });
          try {
            const r = await runTool(this.o.mongorestoreBin!, ['--config', cfg, `--archive=${file}`, '--gzip', '--quiet', ...(spec.drop ? ['--drop'] : [])], { timeoutMs: TOOL_TIMEOUT });
            if (r.code !== 0) throw new AgentError('restore_failed', `MongoDB restore of "${member.source}" failed: ${scrub(tail(r.stderr, 3), secrets) || 'mongorestore failed'}`);
          } finally {
            rmSync(cfg, { force: true });
          }
          restored.push({ file: member.file, source: member.source, kind: 'mongodb', target: member.database ?? 'as selected by the connection string' });
        }
        rmSync(file, { force: true });
      }
      ctx.step('Done');
      return { restored };
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
  }

  // ---- verify, delete, test -----------------------------------------------------------

  startVerify(ref: ArtifactRef, access: S3Access | null, deep: boolean): BackupJobView {
    this.requireTar();
    return this.start('verify', ref.plan, access ? [access.secrets.secretAccessKey] : [], (ctx) => this.runVerify(ref, access, deep, ctx));
  }

  private async runVerify(ref: ArtifactRef, access: S3Access | null, deep: boolean, ctx: JobCtx): Promise<Record<string, unknown>> {
    const tar = this.requireTar();
    ctx.step('Reading the backup description');
    const manifest = await this.readManifest(ref, access);
    if (!manifest.artifactSha256 || manifest.artifactSizeBytes === undefined) throw new AgentError('verify_failed', 'The backup description has no checksum.');
    const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

    let path: string | null = null;
    const stage = join(this.stagingRoot(), ctx.id);
    mkdirSync(stage, { recursive: true, mode: 0o700 });
    try {
      if (ref.where === 'local') {
        path = this.localPath(ref);
        if (!existsSync(path)) throw new AgentError('not_found', 'That backup is not on this server.');
      } else {
        const client = this.s3(access!);
        const key = this.key(access!, ref);
        ctx.step('Asking the storage service');
        const head = await client.head(key);
        if (!head) throw new AgentError('not_found', 'The backup file is missing from the bucket.');
        checks.push({ name: 'Size in the bucket', ok: head.size === manifest.artifactSizeBytes, detail: `${head.size} bytes (expected ${manifest.artifactSizeBytes})` });
        if (head.sha256) checks.push({ name: 'Checksum recorded at upload', ok: head.sha256 === manifest.artifactSha256, detail: head.sha256.slice(0, 16) + '…' });
        if (deep) {
          ctx.step('Downloading to check the contents');
          path = join(stage, 'artifact.tar');
          await client.downloadTo(key, path);
        }
      }
      if (path) {
        ctx.step('Calculating checksum');
        const h = await hashFile(path);
        checks.push({ name: 'Checksum', ok: h.sha256 === manifest.artifactSha256, detail: h.sha256 === manifest.artifactSha256 ? 'matches' : 'does not match the recorded checksum' });
        checks.push({ name: 'Size', ok: h.sizeBytes === manifest.artifactSizeBytes, detail: `${h.sizeBytes} bytes` });
        const t = await runTool(tar, ['-tf', path], { timeoutMs: TOOL_TIMEOUT });
        const listed = new Set(t.stdout.split('\n').map((l) => l.trim().replace(/^\.\//, '')));
        const missing = manifest.members.filter((m) => !listed.has(m.file));
        checks.push({ name: 'Contents', ok: t.code === 0 && missing.length === 0, detail: t.code !== 0 ? 'the archive cannot be read' : missing.length ? `missing: ${missing.map((m) => m.file).join(', ')}` : `${manifest.members.length} item(s) present` });
      }
    } finally {
      rmSync(stage, { recursive: true, force: true });
    }
    const failed = checks.filter((c) => !c.ok);
    if (failed.length) throw new AgentError('verify_failed', `The backup failed the check: ${failed.map((c) => `${c.name} ${c.detail}`).join('; ')}`);
    ctx.step('The backup is intact');
    return { ok: true, checks, deep: ref.where === 'local' || deep };
  }

  async delete(ref: ArtifactRef, access: S3Access | null): Promise<{ deleted: true }> {
    if (ref.where === 'local') {
      const p = this.localPath(ref);
      if (!existsSync(p) && !existsSync(`${p}.json`)) throw new AgentError('not_found', 'That backup is not on this server.');
      rmSync(p, { force: true });
      rmSync(`${p}.json`, { force: true });
    } else {
      if (!access) throw new AgentError('invalid', 'Missing storage settings.');
      const client = this.s3(access);
      const key = this.key(access, ref);
      await client.delete(key);
      await client.delete(`${key}.json`);
    }
    return { deleted: true };
  }

  /** Write, read and delete a small object to prove the credentials and bucket work. */
  async testS3(access: S3Access): Promise<{ ok: true; ms: number }> {
    const client = this.s3(access);
    const key = `${access.target.prefix}.openvps-test-${randomBytes(6).toString('hex')}`;
    const started = Date.now();
    try {
      await client.putText(key, 'OpenVPS connection test', 'text/plain');
      if ((await client.getText(key)) !== 'OpenVPS connection test') throw new AgentError('s3_failed', 'The bucket returned different data than was written.');
      await client.delete(key);
    } catch (e) {
      if (e instanceof S3Error) throw new AgentError('s3_failed', scrub(`${e.code}: ${e.message}`, [access.secrets.secretAccessKey]));
      throw e;
    }
    return { ok: true, ms: Date.now() - started };
  }
}
