import { connect } from 'node:net';
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
}
