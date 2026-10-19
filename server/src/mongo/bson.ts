import { randomBytes } from 'node:crypto';

/**
 * A small BSON codec (https://bsonspec.org) for the MongoDB browser. Documents decode into
 * "typed" values so that the display can tell Int32 from Double from Int64, and encode back
 * from the same values (or from plain JS values). Only what the browser needs: no streaming,
 * no JavaScript execution, no mutation helpers.
 *
 * Limitation: documents become plain JS objects, so integer-like keys ("1", "2") are listed
 * in numeric order rather than stored order.
 */

export class ObjectId {
  readonly bytes: Buffer;
  constructor(bytes: Buffer) {
    if (bytes.length !== 12) throw new Error('An ObjectId is 12 bytes (24 hex characters).');
    this.bytes = bytes;
  }
  static fromHex(hex: string): ObjectId {
    if (!/^[0-9a-fA-F]{24}$/.test(hex)) throw new Error('An ObjectId is 24 hex characters.');
    return new ObjectId(Buffer.from(hex, 'hex'));
  }
  static generate(): ObjectId {
    return new ObjectId(randomBytes(12));
  }
  toHex(): string {
    return this.bytes.toString('hex');
  }
}
export class Int32 {
  readonly value: number;
  constructor(value: number) {
    this.value = value | 0;
  }
}
export class Double {
  readonly value: number;
  constructor(value: number) {
    this.value = value;
  }
}
export class Int64 {
  readonly value: bigint;
  constructor(value: bigint) {
    if (value < -(2n ** 63n) || value >= 2n ** 63n) throw new Error('The number does not fit in 64 bits.');
    this.value = value;
  }
}
export class BsonDate {
  /** Milliseconds since the epoch. */
  readonly ms: bigint;
  constructor(ms: bigint) {
    this.ms = ms;
  }
}
export class Binary {
  readonly subType: number;
  readonly data: Buffer;
  constructor(subType: number, data: Buffer) {
    this.subType = subType;
    this.data = data;
  }
}
export class BsonRegExp {
  readonly pattern: string;
  readonly flags: string;
  constructor(pattern: string, flags: string) {
    this.pattern = pattern;
    this.flags = [...new Set(flags.split(''))].sort().join('');
  }
}
export class Timestamp {
  readonly t: number;
  readonly i: number;
  constructor(t: number, i: number) {
    this.t = t >>> 0;
    this.i = i >>> 0;
  }
}
export class MinKey {}
export class MaxKey {}
export class BsonUndefined {}
export class Decimal128 {
  readonly bytes: Buffer;
  constructor(bytes: Buffer) {
    this.bytes = bytes;
  }
  /** Decimal string as defined by the BSON Decimal128 specification. */
  toString(): string {
    const lo = this.bytes.readBigUInt64LE(0);
    const hi = this.bytes.readBigUInt64LE(8);
    const neg = hi >> 63n === 1n;
    const sign = neg ? '-' : '';
    const comb = Number((hi >> 58n) & 0x1fn);
    if (comb === 0x1e) return sign + 'Infinity';
    if (comb === 0x1f) return 'NaN';
    let exp: number;
    let sig: bigint;
    if (((hi >> 61n) & 3n) === 3n) {
      exp = Number((hi >> 47n) & 0x3fffn);
      sig = 0n; // non-canonical encodings read as zero
    } else {
      exp = Number((hi >> 49n) & 0x3fffn);
      sig = ((hi & 0x1ffffffffffffn) << 64n) | lo;
      if (sig >= 10n ** 34n) sig = 0n;
    }
    const e = exp - 6176;
    const digits = sig.toString();
    const adjusted = e + digits.length - 1;
    if (e > 0 || adjusted < -6) {
      const coeff = digits.length > 1 ? `${digits[0]}.${digits.slice(1)}` : digits;
      return `${sign}${coeff}E${adjusted >= 0 ? '+' : ''}${adjusted}`;
    }
    if (e === 0) return sign + digits;
    const point = digits.length + e;
    if (point > 0) return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
    return `${sign}0.${'0'.repeat(-point)}${digits}`;
  }
}
/** Rarely used types, kept only so that documents containing them still display. */
export class BsonLegacy {
  readonly ejson: unknown;
  constructor(ejson: unknown) {
    this.ejson = ejson;
  }
}

export type BsonDoc = { [key: string]: unknown };

// ---- decoding ---------------------------------------------------------------------------

export class BsonError extends Error {}

const MAX_DEPTH = 120;

class Reader {
  readonly buf: Buffer;
  constructor(buf: Buffer) {
    this.buf = buf;
  }

  need(off: number, n: number): void {
    if (off < 0 || n < 0 || off + n > this.buf.length) throw new BsonError('Malformed BSON: unexpected end of data.');
  }

  cstring(off: number): [string, number] {
    const end = this.buf.indexOf(0, off);
    if (end < 0) throw new BsonError('Malformed BSON: unterminated string.');
    return [this.buf.toString('utf8', off, end), end + 1];
  }

  string(off: number): [string, number] {
    this.need(off, 4);
    const len = this.buf.readInt32LE(off);
    if (len < 1) throw new BsonError('Malformed BSON: bad string length.');
    this.need(off + 4, len);
    if (this.buf[off + 4 + len - 1] !== 0) throw new BsonError('Malformed BSON: string is not terminated.');
    return [this.buf.toString('utf8', off + 4, off + 4 + len - 1), off + 4 + len];
  }

  doc(off: number, isArray: boolean, depth: number): [BsonDoc | unknown[], number] {
    if (depth > MAX_DEPTH) throw new BsonError('Malformed BSON: nested too deeply.');
    this.need(off, 5);
    const size = this.buf.readInt32LE(off);
    if (size < 5) throw new BsonError('Malformed BSON: bad document size.');
    this.need(off, size);
    const end = off + size;
    if (this.buf[end - 1] !== 0) throw new BsonError('Malformed BSON: document is not terminated.');
    const out: BsonDoc | unknown[] = isArray ? [] : (Object.create(null) as BsonDoc);
    let p = off + 4;
    while (p < end - 1) {
      const type = this.buf[p]!;
      const [key, afterKey] = this.cstring(p + 1);
      const [value, next] = this.value(type, afterKey, depth);
      if (isArray) (out as unknown[]).push(value);
      else (out as BsonDoc)[key] = value;
      p = next;
    }
    if (p !== end - 1) throw new BsonError('Malformed BSON: element overruns its document.');
    return [out, end];
  }

  value(type: number, off: number, depth: number): [unknown, number] {
    const b = this.buf;
    switch (type) {
      case 0x01:
        this.need(off, 8);
        return [new Double(b.readDoubleLE(off)), off + 8];
      case 0x02:
        return this.string(off);
      case 0x03:
        return this.doc(off, false, depth + 1);
      case 0x04:
        return this.doc(off, true, depth + 1);
      case 0x05: {
        this.need(off, 5);
        let len = b.readInt32LE(off);
        const subType = b[off + 4]!;
        let start = off + 5;
        if (len < 0) throw new BsonError('Malformed BSON: bad binary length.');
        this.need(start, len);
        const end = start + len;
        if (subType === 2 && len >= 4) {
          // The obsolete "binary (old)" layout repeats the length.
          len = b.readInt32LE(start);
          start += 4;
          if (len < 0 || start + len > end) throw new BsonError('Malformed BSON: bad binary length.');
        }
        return [new Binary(subType, Buffer.from(b.subarray(start, start + (subType === 2 ? len : end - start)))), end];
      }
      case 0x06:
        return [new BsonUndefined(), off];
      case 0x07:
        this.need(off, 12);
        return [new ObjectId(Buffer.from(b.subarray(off, off + 12))), off + 12];
      case 0x08:
        this.need(off, 1);
        return [b[off] === 1, off + 1];
      case 0x09:
        this.need(off, 8);
        return [new BsonDate(b.readBigInt64LE(off)), off + 8];
      case 0x0a:
        return [null, off];
      case 0x0b: {
        const [pattern, a] = this.cstring(off);
        const [flags, c] = this.cstring(a);
        return [new BsonRegExp(pattern, flags), c];
      }
      case 0x0c: {
        const [ns, a] = this.string(off);
        this.need(a, 12);
        return [new BsonLegacy({ $dbPointer: { $ref: ns, $id: { $oid: b.toString('hex', a, a + 12) } } }), a + 12];
      }
      case 0x0d: {
        const [code, n] = this.string(off);
        return [new BsonLegacy({ $code: code }), n];
      }
      case 0x0e: {
        const [sym, n] = this.string(off);
        return [new BsonLegacy({ $symbol: sym }), n];
      }
      case 0x0f: {
        this.need(off, 4);
        const total = b.readInt32LE(off);
        this.need(off, total);
        const [code, a] = this.string(off + 4);
        const [scope] = this.doc(a, false, depth + 1);
        return [new BsonLegacy({ $code: code, $scope: toEjson(scope) }), off + total];
      }
      case 0x10:
        this.need(off, 4);
        return [new Int32(b.readInt32LE(off)), off + 4];
      case 0x11:
        this.need(off, 8);
        return [new Timestamp(b.readUInt32LE(off + 4), b.readUInt32LE(off)), off + 8];
      case 0x12:
        this.need(off, 8);
        return [new Int64(b.readBigInt64LE(off)), off + 8];
      case 0x13:
        this.need(off, 16);
        return [new Decimal128(Buffer.from(b.subarray(off, off + 16))), off + 16];
      case 0xff:
        return [new MinKey(), off];
      case 0x7f:
        return [new MaxKey(), off];
      default:
        throw new BsonError(`Unsupported BSON type 0x${type.toString(16)}.`);
    }
  }
}

/** Decode one BSON document into typed values. */
export function decode(buf: Buffer): BsonDoc {
  const [d] = new Reader(buf).doc(0, false, 0);
  return d as BsonDoc;
}

/** Typed values -> plain JS: numbers, strings, booleans, Dates, Buffers, arrays and objects. */
export function toPlain(v: unknown): unknown {
  if (v === null || typeof v !== 'object') return v;
  if (v instanceof Int32) return v.value;
  if (v instanceof Double) return v.value;
  if (v instanceof Int64) return Number(v.value);
  if (v instanceof ObjectId) return v.toHex();
  if (v instanceof BsonDate) return new Date(Number(v.ms));
  if (v instanceof Binary) return v.data;
  if (v instanceof Decimal128) return v.toString();
  if (Array.isArray(v)) return v.map(toPlain);
  if (v instanceof BsonRegExp || v instanceof Timestamp || v instanceof MinKey || v instanceof MaxKey || v instanceof BsonUndefined || v instanceof BsonLegacy) {
    return toEjson(v);
  }
  const out: BsonDoc = Object.create(null) as BsonDoc;
  for (const [k, x] of Object.entries(v)) out[k] = toPlain(x);
  return out;
}

export interface EjsonOptions {
  /** Strings longer than this are replaced by a marker with a preview. */
  maxString?: number;
  /** Binary data longer than this is replaced by a marker. */
  maxBinary?: number;
}

const MIN_ISO = -62167219200000n; // 0000-01-01
const MAX_ISO = 253402300799999n; // 9999-12-31

function doubleText(n: number): string {
  if (Number.isNaN(n)) return 'NaN';
  if (n === Infinity) return 'Infinity';
  if (n === -Infinity) return '-Infinity';
  if (Object.is(n, -0)) return '-0.0';
  const s = String(n);
  return /[.eE]/.test(s) ? s : s + '.0';
}

/**
 * Typed values -> Extended JSON (canonical for numbers, relaxed for dates), so the browser can
 * show types and no precision is lost. Oversized strings and binaries are cut, flagged with
 * `{"$truncated": {...}}`.
 */
export function toEjson(v: unknown, o: EjsonOptions = {}): unknown {
  const maxString = o.maxString ?? Infinity;
  const maxBinary = o.maxBinary ?? Infinity;
  const walk = (x: unknown): unknown => {
    if (x === null || x === undefined) return null;
    if (typeof x === 'string') {
      return x.length > maxString ? { $truncated: { type: 'string', length: x.length, preview: x.slice(0, 1000) } } : x;
    }
    if (typeof x === 'boolean') return x;
    if (typeof x === 'number') return Number.isInteger(x) && Math.abs(x) < 2 ** 31 ? { $numberInt: String(x) } : { $numberDouble: doubleText(x) };
    if (typeof x === 'bigint') return { $numberLong: x.toString() };
    if (x instanceof Int32) return { $numberInt: String(x.value) };
    if (x instanceof Double) return { $numberDouble: doubleText(x.value) };
    if (x instanceof Int64) return { $numberLong: x.value.toString() };
    if (x instanceof Decimal128) return { $numberDecimal: x.toString() };
    if (x instanceof ObjectId) return { $oid: x.toHex() };
    if (x instanceof BsonDate) {
      return x.ms >= MIN_ISO && x.ms <= MAX_ISO ? { $date: new Date(Number(x.ms)).toISOString() } : { $date: { $numberLong: x.ms.toString() } };
    }
    if (x instanceof Date) return { $date: Number.isNaN(x.getTime()) ? null : x.toISOString() };
    if (x instanceof Binary) {
      if (x.data.length > maxBinary) return { $truncated: { type: 'binary', length: x.data.length, subType: x.subType.toString(16).padStart(2, '0') } };
      if (x.subType === 4 && x.data.length === 16) {
        const h = x.data.toString('hex');
        return { $uuid: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` };
      }
      return { $binary: { base64: x.data.toString('base64'), subType: x.subType.toString(16).padStart(2, '0') } };
    }
    if (x instanceof Buffer) return { $binary: { base64: x.toString('base64'), subType: '00' } };
    if (x instanceof BsonRegExp) return { $regularExpression: { pattern: x.pattern, options: x.flags } };
    if (x instanceof Timestamp) return { $timestamp: { t: x.t, i: x.i } };
    if (x instanceof MinKey) return { $minKey: 1 };
    if (x instanceof MaxKey) return { $maxKey: 1 };
    if (x instanceof BsonUndefined) return { $undefined: true };
    if (x instanceof BsonLegacy) return x.ejson;
    if (Array.isArray(x)) return x.map(walk);
    if (typeof x === 'object') {
      const out: BsonDoc = Object.create(null) as BsonDoc;
      for (const [k, y] of Object.entries(x as BsonDoc)) out[k] = walk(y);
      return out;
    }
    return String(x);
  };
  return walk(v);
}

// ---- encoding ---------------------------------------------------------------------------

class Writer {
  private buf = Buffer.allocUnsafe(256);
  private len = 0;

  private ensure(n: number): void {
    if (this.len + n <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + n) size *= 2;
    const next = Buffer.allocUnsafe(size);
    this.buf.copy(next, 0, 0, this.len);
    this.buf = next;
  }

  byte(n: number): void {
    this.ensure(1);
    this.buf[this.len++] = n;
  }
  int32(n: number): void {
    this.ensure(4);
    this.buf.writeInt32LE(n, this.len);
    this.len += 4;
  }
  patchInt32(at: number, n: number): void {
    this.buf.writeInt32LE(n, at);
  }
  bytes(b: Buffer): void {
    this.ensure(b.length);
    b.copy(this.buf, this.len);
    this.len += b.length;
  }
  cstring(s: string, what: string): void {
    if (s.includes('\0')) throw new BsonError(`${what} must not contain a null character.`);
    const b = Buffer.from(s, 'utf8');
    this.bytes(b);
    this.byte(0);
  }
  string(s: string): void {
    const b = Buffer.from(s, 'utf8');
    this.int32(b.length + 1);
    this.bytes(b);
    this.byte(0);
  }
  pos(): number {
    return this.len;
  }
  result(): Buffer {
    return Buffer.from(this.buf.subarray(0, this.len));
  }

  doc(value: BsonDoc | unknown[], isArray: boolean, depth: number): void {
    if (depth > MAX_DEPTH) throw new BsonError('The document is nested too deeply.');
    const start = this.len;
    this.int32(0);
    if (isArray) {
      (value as unknown[]).forEach((v, i) => this.element(String(i), v, depth));
    } else {
      for (const [k, v] of Object.entries(value as BsonDoc)) {
        if (v !== undefined) this.element(k, v, depth);
      }
    }
    this.byte(0);
    this.patchInt32(start, this.len - start);
  }

  element(key: string, v: unknown, depth: number): void {
    const head = (t: number) => {
      this.byte(t);
      this.cstring(key, 'A field name');
    };
    if (v === null) return head(0x0a);
    switch (typeof v) {
      case 'string':
        head(0x02);
        return this.string(v);
      case 'boolean':
        head(0x08);
        return this.byte(v ? 1 : 0);
      case 'number':
        if (Number.isInteger(v) && v >= -(2 ** 31) && v < 2 ** 31) {
          head(0x10);
          return this.int32(v);
        }
        if (Number.isSafeInteger(v)) {
          head(0x12);
          const b = Buffer.alloc(8);
          b.writeBigInt64LE(BigInt(v));
          return this.bytes(b);
        }
        head(0x01);
        return this.double(v);
      case 'bigint': {
        head(0x12);
        const b = Buffer.alloc(8);
        b.writeBigInt64LE(new Int64(v).value);
        return this.bytes(b);
      }
      case 'object':
        break;
      default:
        throw new BsonError(`Cannot encode a value of type ${typeof v}.`);
    }
    if (v instanceof Int32) {
      head(0x10);
      return this.int32(v.value);
    }
    if (v instanceof Double) {
      head(0x01);
      return this.double(v.value);
    }
    if (v instanceof Int64) {
      head(0x12);
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(v.value);
      return this.bytes(b);
    }
    if (v instanceof ObjectId) {
      head(0x07);
      return this.bytes(v.bytes);
    }
    if (v instanceof BsonDate) {
      head(0x09);
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(v.ms);
      return this.bytes(b);
    }
    if (v instanceof Date) {
      head(0x09);
      const b = Buffer.alloc(8);
      b.writeBigInt64LE(BigInt(v.getTime()));
      return this.bytes(b);
    }
    if (v instanceof Binary || v instanceof Buffer) {
      const sub = v instanceof Binary ? v.subType : 0;
      const data = v instanceof Binary ? v.data : v;
      head(0x05);
      this.int32(data.length);
      this.byte(sub);
      return this.bytes(data);
    }
    if (v instanceof BsonRegExp) {
      head(0x0b);
      this.cstring(v.pattern, 'A regular expression');
      return this.cstring(v.flags, 'Regular expression options');
    }
    if (v instanceof Timestamp) {
      head(0x11);
      const b = Buffer.alloc(8);
      b.writeUInt32LE(v.i, 0);
      b.writeUInt32LE(v.t, 4);
      return this.bytes(b);
    }
    if (v instanceof MinKey) return head(0xff);
    if (v instanceof MaxKey) return head(0x7f);
    if (v instanceof BsonUndefined || v instanceof Decimal128 || v instanceof BsonLegacy) {
      throw new BsonError('This value type cannot be used in a query.');
    }
    if (Array.isArray(v)) {
      head(0x04);
      return this.doc(v, true, depth + 1);
    }
    head(0x03);
    this.doc(v as BsonDoc, false, depth + 1);
  }

  double(n: number): void {
    this.ensure(8);
    this.buf.writeDoubleLE(n, this.len);
    this.len += 8;
  }
}

/** Encode a document. Plain JS numbers become int32, int64 or double by value. */
export function encode(doc: BsonDoc): Buffer {
  const w = new Writer();
  w.doc(doc, false, 0);
  return w.result();
}
