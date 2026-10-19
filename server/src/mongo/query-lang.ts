import { Binary, BsonDate, BsonRegExp, Double, Int32, Int64, MaxKey, MinKey, ObjectId, Timestamp, type BsonDoc } from './bson.ts';

/**
 * Parser for the filter / sort / projection boxes. Accepts what people type in MongoDB Compass
 * and the shell: unquoted keys, single quotes, trailing commas, /regex/flags, helpers such as
 * ObjectId("..."), ISODate("..."), NumberLong("..."), UUID("..."), and Extended JSON
 * ({"$oid": "..."}, {"$date": "..."}, ...). It never evaluates anything.
 */

export class QueryError extends Error {}

const MAX_TEXT = 100_000;
const MAX_DEPTH = 60;

/** Operators that run JavaScript on the server. Browsing is read-only and never needs them. */
const FORBIDDEN = new Set(['$where', '$function', '$accumulator']);

class Parser {
  private i = 0;
  private readonly s: string;
  constructor(text: string) {
    this.s = text;
  }

  fail(msg: string): never {
    throw new QueryError(`${msg} (at character ${this.i + 1})`);
  }

  private ws(): void {
    for (;;) {
      const c = this.s[this.i];
      if (c === ' ' || c === '\t' || c === '\n' || c === '\r') this.i++;
      else if (c === '/' && this.s[this.i + 1] === '/') while (this.i < this.s.length && this.s[this.i] !== '\n') this.i++;
      else break;
    }
  }

  private peek(): string | undefined {
    this.ws();
    return this.s[this.i];
  }

  private eat(c: string): void {
    if (this.peek() !== c) this.fail(`Expected "${c}"`);
    this.i++;
  }

  done(): void {
    this.ws();
    if (this.i < this.s.length) this.fail('Unexpected text after the end of the value');
  }

  value(depth = 0): unknown {
    if (depth > MAX_DEPTH) this.fail('Nested too deeply');
    const c = this.peek();
    if (c === undefined) this.fail('Unexpected end of input');
    if (c === '{') return this.object(depth);
    if (c === '[') return this.array(depth);
    if (c === '"' || c === "'") return this.string();
    if (c === '/') return this.regex();
    if (c === '-' || c === '+' || (c >= '0' && c <= '9') || c === '.') return this.number();
    if (/[A-Za-z_$]/.test(c)) return this.word(depth);
    return this.fail(`Unexpected "${c}"`);
  }

  private object(depth: number): unknown {
    this.eat('{');
    const out: BsonDoc = Object.create(null) as BsonDoc;
    if (this.peek() === '}') {
      this.i++;
      return out;
    }
    for (;;) {
      const key = this.key();
      this.eat(':');
      out[key] = this.value(depth + 1);
      const c = this.peek();
      if (c === ',') {
        this.i++;
        if (this.peek() === '}') {
          this.i++;
          break;
        }
        continue;
      }
      if (c === '}') {
        this.i++;
        break;
      }
      this.fail('Expected "," or "}"');
    }
    return fromExtendedJson(out, (m) => this.fail(m));
  }

  private key(): string {
    const c = this.peek();
    if (c === '"' || c === "'") return this.string();
    const m = /^[A-Za-z0-9_$][A-Za-z0-9_$.\-]*/.exec(this.s.slice(this.i));
    if (!m) this.fail('Expected a field name');
    this.i += m[0].length;
    return m[0];
  }

  private array(depth: number): unknown[] {
    this.eat('[');
    const out: unknown[] = [];
    if (this.peek() === ']') {
      this.i++;
      return out;
    }
    for (;;) {
      out.push(this.value(depth + 1));
      const c = this.peek();
      if (c === ',') {
        this.i++;
        if (this.peek() === ']') {
          this.i++;
          break;
        }
        continue;
      }
      if (c === ']') {
        this.i++;
        break;
      }
      this.fail('Expected "," or "]"');
    }
    return out;
  }

  private string(): string {
    const q = this.s[this.i++]!;
    let out = '';
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined) this.fail('Unterminated string');
      if (c === q) return out;
      if (c !== '\\') {
        out += c;
        continue;
      }
      const e = this.s[this.i++];
      switch (e) {
        case 'n': out += '\n'; break;
        case 't': out += '\t'; break;
        case 'r': out += '\r'; break;
        case 'b': out += '\b'; break;
        case 'f': out += '\f'; break;
        case '0': out += '\0'; break;
        case 'u': {
          const hex = this.s.slice(this.i, this.i + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) this.fail('Invalid \\u escape');
          out += String.fromCharCode(parseInt(hex, 16));
          this.i += 4;
          break;
        }
        case undefined: this.fail('Unterminated string'); break;
        default: out += e;
      }
    }
  }

  private regex(): BsonRegExp {
    this.i++;
    let pattern = '';
    for (;;) {
      const c = this.s[this.i++];
      if (c === undefined || c === '\n') this.fail('Unterminated regular expression');
      if (c === '\\') {
        const n = this.s[this.i++];
        if (n === undefined) this.fail('Unterminated regular expression');
        pattern += n === '/' ? '/' : '\\' + n;
        continue;
      }
      if (c === '/') break;
      pattern += c;
    }
    const m = /^[a-z]*/.exec(this.s.slice(this.i))!;
    this.i += m[0].length;
    if (!/^[imsxlu]*$/.test(m[0])) this.fail(`Unsupported regular expression option "${m[0]}"`);
    return new BsonRegExp(pattern, m[0]);
  }

  private number(): number {
    const m = /^[+-]?(?:\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/.exec(this.s.slice(this.i));
    if (!m) this.fail('Invalid number');
    this.i += m[0].length;
    const n = Number(m[0]);
    if (!Number.isFinite(n)) this.fail('Invalid number');
    return n;
  }

  private word(depth: number): unknown {
    const m = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.s.slice(this.i))!;
    this.i += m[0].length;
    let name = m[0];
    if (name === 'new') {
      this.ws();
      const n = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(this.s.slice(this.i));
      if (!n) this.fail('Expected a name after "new"');
      this.i += n[0].length;
      name = n[0];
    }
    switch (name) {
      case 'true': return true;
      case 'false': return false;
      case 'null': return null;
      case 'NaN': return NaN;
      case 'Infinity': return Infinity;
    }
    if (this.peek() !== '(') this.fail(`Unknown name "${name}"`);
    this.i++;
    const args: unknown[] = [];
    if (this.peek() === ')') this.i++;
    else {
      for (;;) {
        args.push(this.value(depth + 1));
        const c = this.peek();
        if (c === ',') {
          this.i++;
          continue;
        }
        if (c === ')') {
          this.i++;
          break;
        }
        this.fail('Expected "," or ")"');
      }
    }
    return this.call(name, args);
  }

  private call(name: string, a: unknown[]): unknown {
    const str = (n: number): string => {
      if (typeof a[n] !== 'string') this.fail(`${name}() expects a string`);
      return a[n] as string;
    };
    const num = (n: number): number => {
      if (typeof a[n] !== 'number') this.fail(`${name}() expects a number`);
      return a[n] as number;
    };
    try {
      switch (name) {
        case 'ObjectId':
          return a.length ? ObjectId.fromHex(str(0)) : ObjectId.generate();
        case 'ISODate':
        case 'Date': {
          if (!a.length) return new BsonDate(BigInt(Date.now()));
          if (typeof a[0] === 'number') return new BsonDate(BigInt(Math.trunc(a[0])));
          const text = str(0);
          // A date without a zone is UTC, like the shell's ISODate().
          const t = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(text) || (/T/.test(text) && !/(Z|[+-]\d{2}:?\d{2})$/.test(text)) ? text + (text.includes('T') ? 'Z' : 'T00:00:00Z') : text);
          if (Number.isNaN(t)) this.fail(`${name}("${text.slice(0, 40)}") is not a valid date`);
          return new BsonDate(BigInt(t));
        }
        case 'NumberInt':
        case 'Int32': {
          const n = typeof a[0] === 'string' ? Number(a[0]) : num(0);
          if (!Number.isInteger(n) || n < -(2 ** 31) || n >= 2 ** 31) this.fail(`${name}() needs a whole number that fits in 32 bits`);
          return new Int32(n);
        }
        case 'NumberLong':
        case 'Long':
        case 'Int64': {
          const v = a[0];
          if (typeof v === 'number' && Number.isSafeInteger(v)) return new Int64(BigInt(v));
          if (typeof v === 'string' && /^-?\d+$/.test(v)) return new Int64(BigInt(v));
          return this.fail(`${name}() needs a whole number or a string of digits`);
        }
        case 'Double':
          return new Double(typeof a[0] === 'string' ? Number(a[0]) : num(0));
        case 'NumberDecimal':
        case 'Decimal128':
          return this.fail('Decimal128 values cannot be typed here. Use a plain number: it matches decimals by value');
        case 'UUID': {
          const hex = str(0).replace(/-/g, '');
          if (!/^[0-9a-fA-F]{32}$/.test(hex)) this.fail('UUID() expects 32 hex digits');
          return new Binary(4, Buffer.from(hex, 'hex'));
        }
        case 'BinData': {
          const sub = num(0);
          if (!Number.isInteger(sub) || sub < 0 || sub > 255) this.fail('BinData() subtype must be 0-255');
          return new Binary(sub, Buffer.from(str(1), 'base64'));
        }
        case 'Timestamp':
          return new Timestamp(num(0), num(1));
        case 'MinKey':
          return new MinKey();
        case 'MaxKey':
          return new MaxKey();
        case 'RegExp':
          return new BsonRegExp(str(0), a.length > 1 ? str(1) : '');
        default:
          return this.fail(`Unknown function ${name}()`);
      }
    } catch (e) {
      if (e instanceof QueryError) throw e;
      return this.fail((e as Error).message);
    }
  }
}

function isPlain(v: unknown): v is BsonDoc {
  return typeof v === 'object' && v !== null && !Array.isArray(v) && (Object.getPrototypeOf(v) === null || Object.getPrototypeOf(v) === Object.prototype);
}

/** Turn one-key Extended JSON objects into the typed value they stand for. */
function fromExtendedJson(o: BsonDoc, fail: (m: string) => never): unknown {
  const keys = Object.keys(o);
  if (keys.length === 0 || !keys[0]!.startsWith('$')) return o;
  const k = keys[0]!;
  const v = o[k];
  const only = keys.length === 1;
  try {
    if (only) {
      switch (k) {
        case '$oid': return ObjectId.fromHex(String(v));
        case '$numberInt': return new Int32(Number(v));
        case '$numberLong': return new Int64(BigInt(String(v)));
        case '$numberDouble': return new Double(Number(v));
        case '$numberDecimal': return fail('Decimal128 values cannot be typed here. Use a plain number');
        case '$date': {
          if (typeof v === 'string') {
            const t = Date.parse(v);
            if (Number.isNaN(t)) return fail('"$date" is not a valid date');
            return new BsonDate(BigInt(t));
          }
          if (typeof v === 'number') return new BsonDate(BigInt(Math.trunc(v)));
          if (v instanceof Int64) return new BsonDate(v.value);
          return fail('"$date" is not a valid date');
        }
        case '$uuid': {
          const hex = String(v).replace(/-/g, '');
          if (!/^[0-9a-fA-F]{32}$/.test(hex)) return fail('"$uuid" must be 32 hex digits');
          return new Binary(4, Buffer.from(hex, 'hex'));
        }
        case '$minKey': return new MinKey();
        case '$maxKey': return new MaxKey();
        case '$regularExpression':
          if (isPlain(v) && typeof v.pattern === 'string') return new BsonRegExp(v.pattern, typeof v.options === 'string' ? v.options : '');
          return fail('"$regularExpression" needs pattern and options');
        case '$timestamp':
          if (isPlain(v)) return new Timestamp(Number(v.t), Number(v.i));
          return fail('"$timestamp" needs t and i');
        case '$binary':
          if (isPlain(v) && typeof v.base64 === 'string') return new Binary(parseInt(String(v.subType ?? '00'), 16) || 0, Buffer.from(v.base64, 'base64'));
          return fail('"$binary" needs base64 and subType');
      }
    }
  } catch (e) {
    if (e instanceof QueryError) throw e;
    return fail(`Invalid ${k} value: ${(e as Error).message}`);
  }
  return o;
}

/** Reject operators that execute JavaScript on the server. */
function scanForbidden(v: unknown, depth = 0): void {
  if (depth > MAX_DEPTH + 5) throw new QueryError('The query is nested too deeply.');
  if (Array.isArray(v)) {
    for (const x of v) scanForbidden(x, depth + 1);
  } else if (isPlain(v)) {
    for (const [k, x] of Object.entries(v)) {
      if (FORBIDDEN.has(k)) throw new QueryError(`${k} runs JavaScript on the server and is not allowed here.`);
      scanForbidden(x, depth + 1);
    }
  }
}

/** Parse the text of a filter, sort or projection box into a document. Empty text is {}. */
export function parseQueryDoc(text: string, what: string): BsonDoc {
  if (text.length > MAX_TEXT) throw new QueryError(`The ${what} is too long.`);
  if (!text.trim()) return Object.create(null) as BsonDoc;
  const p = new Parser(text);
  let v: unknown;
  try {
    v = p.value();
    p.done();
  } catch (e) {
    if (e instanceof QueryError) throw new QueryError(`${what[0]!.toUpperCase()}${what.slice(1)}: ${e.message}`);
    throw e;
  }
  if (!isPlain(v)) throw new QueryError(`The ${what} must be a document like { field: value }.`);
  scanForbidden(v);
  return v;
}
