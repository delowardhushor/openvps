import { MongoClient, MongoConnectionError } from './client.ts';

interface Entry {
  uri: string;
  client: Promise<MongoClient>;
  /** Requests on one connection run one after another. */
  tail: Promise<unknown>;
  timer: NodeJS.Timeout | null;
}

/**
 * Keeps one connection per saved MongoDB connection for a short while, so that moving around
 * the browser does not log in again on every click. Idle connections close after `idleMs`.
 */
export class MongoPool {
  private readonly entries = new Map<number, Entry>();
  private readonly idleMs: number;
  private readonly connectTimeoutMs: number;

  constructor(opts: { idleMs?: number; connectTimeoutMs?: number } = {}) {
    this.idleMs = opts.idleMs ?? 60_000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 10_000;
  }

  private drop(id: number): void {
    const e = this.entries.get(id);
    if (!e) return;
    this.entries.delete(id);
    if (e.timer) clearTimeout(e.timer);
    void e.client.then((c) => c.close(), () => undefined);
  }

  /** Forget the connection (after the saved connection was edited or deleted). */
  invalidate(id: number): void {
    this.drop(id);
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.drop(id);
  }

  private entry(id: number, uri: string): Entry {
    let e = this.entries.get(id);
    if (e && e.uri !== uri) {
      this.drop(id);
      e = undefined;
    }
    if (!e) {
      const client = MongoClient.connect(uri, { connectTimeoutMs: this.connectTimeoutMs });
      const fresh: Entry = { uri, client, tail: Promise.resolve(), timer: null };
      client.catch(() => {
        if (this.entries.get(id) === fresh) this.entries.delete(id);
      });
      this.entries.set(id, fresh);
      e = fresh;
    }
    return e;
  }

  /**
   * Run `fn` with a connected client. A connection that went stale while idle is replaced and
   * the operation retried once; every operation here only reads, so retrying is safe.
   */
  async use<T>(id: number, uri: string, fn: (c: MongoClient) => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const e = this.entry(id, uri);
      if (e.timer) clearTimeout(e.timer);
      const run = e.tail.then(async () => {
        const c = await e.client;
        if (c.closed) throw new MongoConnectionError('The connection was closed.');
        return fn(c);
      });
      e.tail = run.catch(() => undefined);
      try {
        return await run;
      } catch (err) {
        const c = await e.client.catch(() => null);
        if (!c || c.closed) {
          this.drop(id);
          if (attempt === 0 && c) continue;
        }
        throw err;
      } finally {
        const cur = this.entries.get(id);
        if (cur === e) {
          e.timer = setTimeout(() => this.drop(id), this.idleMs);
          e.timer.unref();
        }
      }
    }
  }
}
