import { connect } from 'node:net';
import type { Readable } from 'node:stream';
import type { AgentRequest, AgentResponse } from './agent/spec.ts';

export class AgentUnavailableError extends Error {}

export class AgentCallError extends Error {
  readonly code: string;
  readonly field: string | undefined;
  constructor(code: string, message: string, field?: string) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

const TIMEOUTS: Partial<Record<AgentRequest['action'], number>> = {
  'app.apply': 120_000,
  'app.remove': 60_000,
  'pm2.control': 60_000,
};

/** One request per connection: write a JSON line, read a JSON line. */
export class AgentClient {
  readonly socketPath: string;
  constructor(socketPath: string) {
    this.socketPath = socketPath;
  }

  call<T>(req: AgentRequest): Promise<T> {
    const timeout = TIMEOUTS[req.action] ?? 20_000;
    return new Promise<T>((resolve, reject) => {
      let buf = '';
      let settled = false;
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      };
      const sock = connect(this.socketPath);
      const timer = setTimeout(
        () => finish(() => reject(new AgentCallError('timeout', 'The agent did not answer in time.'))),
        timeout,
      );
      sock.setEncoding('utf8');
      sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
      sock.on('data', (d: string) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        let res: AgentResponse<T>;
        try {
          res = JSON.parse(buf.slice(0, nl)) as AgentResponse<T>;
        } catch {
          finish(() => reject(new AgentCallError('bad_response', 'The agent sent an unreadable response.')));
          return;
        }
        finish(() =>
          res.ok ? resolve(res.result) : reject(new AgentCallError(res.error.code, res.error.message, res.error.field)),
        );
      });
      sock.on('error', (e: NodeJS.ErrnoException) => {
        finish(() =>
          reject(
            ['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(e.code ?? '')
              ? new AgentUnavailableError(`The OpenVPS agent is not reachable (${e.code}).`)
              : new AgentCallError('io', e.message),
          ),
        );
      });
      sock.on('end', () => {
        if (!settled) finish(() => reject(new AgentCallError('bad_response', 'The agent closed the connection.')));
      });
    });
  }

  /**
   * Send a file: the request line, then exactly `size` bytes read from `body`. The agent answers
   * with one JSON line when it is done (or has refused), which ends the call.
   */
  upload<T>(req: Extract<AgentRequest, { action: 'files.upload' }>, body: Readable, idleMs = 120_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let buf = '';
      let settled = false;
      const sock = connect(this.socketPath);
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        body.unpipe(sock);
        sock.destroy();
        fn();
      };
      sock.setEncoding('utf8');
      sock.setTimeout(idleMs, () => finish(() => reject(new AgentCallError('timeout', 'The upload stalled.'))));
      sock.on('connect', () => {
        sock.write(JSON.stringify(req) + '\n');
        body.pipe(sock, { end: false });
      });
      body.on('error', () => finish(() => reject(new AgentCallError('aborted', 'The upload was cancelled.'))));
      body.on('close', () => {
        if (!body.readableEnded) finish(() => reject(new AgentCallError('aborted', 'The upload was cancelled.')));
      });
      sock.on('data', (d: string) => {
        buf += d;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        let res: AgentResponse<T>;
        try {
          res = JSON.parse(buf.slice(0, nl)) as AgentResponse<T>;
        } catch {
          finish(() => reject(new AgentCallError('bad_response', 'The agent sent an unreadable response.')));
          return;
        }
        finish(() => (res.ok ? resolve(res.result) : reject(new AgentCallError(res.error.code, res.error.message, res.error.field))));
      });
      sock.on('error', (e: NodeJS.ErrnoException) => {
        finish(() =>
          reject(
            ['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(e.code ?? '')
              ? new AgentUnavailableError(`The OpenVPS agent is not reachable (${e.code}).`)
              : new AgentCallError('io', e.message),
          ),
        );
      });
      sock.on('end', () => finish(() => reject(new AgentCallError('bad_response', 'The agent closed the connection.'))));
    });
  }

  /**
   * Fetch a file: resolves with the agent's header (name, size, ...) and a paused stream of
   * exactly the file's bytes. Destroy the stream to cancel.
   */
  download<T>(req: Extract<AgentRequest, { action: 'files.download' }>, idleMs = 120_000): Promise<{ result: T; stream: Readable }> {
    return new Promise((resolve, reject) => {
      let head: Buffer = Buffer.alloc(0);
      let settled = false;
      const sock = connect(this.socketPath);
      const fail = (err: Error) => {
        if (settled) return;
        settled = true;
        sock.destroy();
        reject(err);
      };
      sock.setTimeout(idleMs, () => {
        if (settled) sock.destroy(new Error('The download stalled.'));
        else fail(new AgentCallError('timeout', 'The agent did not answer in time.'));
      });
      sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
      const onData = (d: Buffer) => {
        head = head.length ? Buffer.concat([head, d]) : d;
        const nl = head.indexOf(10);
        if (nl < 0) {
          if (head.length > 64 * 1024) fail(new AgentCallError('bad_response', 'The agent sent an unreadable response.'));
          return;
        }
        let res: AgentResponse<T>;
        try {
          res = JSON.parse(head.subarray(0, nl).toString('utf8')) as AgentResponse<T>;
        } catch {
          fail(new AgentCallError('bad_response', 'The agent sent an unreadable response.'));
          return;
        }
        if (!res.ok) return fail(new AgentCallError(res.error.code, res.error.message, res.error.field));
        settled = true;
        sock.removeListener('data', onData);
        sock.pause();
        const rest = head.subarray(nl + 1);
        if (rest.length) sock.unshift(rest);
        resolve({ result: res.result, stream: sock });
      };
      sock.on('data', onData);
      sock.on('error', (e: NodeJS.ErrnoException) => {
        if (settled) return; // after the hand-off the consumer sees stream errors itself
        fail(
          ['ENOENT', 'ECONNREFUSED', 'EACCES'].includes(e.code ?? '')
            ? new AgentUnavailableError(`The OpenVPS agent is not reachable (${e.code}).`)
            : new AgentCallError('io', e.message),
        );
      });
      sock.on('end', () => fail(new AgentCallError('bad_response', 'The agent closed the connection.')));
    });
  }
}
