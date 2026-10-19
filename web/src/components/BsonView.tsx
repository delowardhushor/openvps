import { useState, type ReactNode } from 'react';

/** Rendering of documents delivered as canonical Extended JSON (see server/src/mongo/bson.ts). */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

export interface Scalar {
  type: string;
  text: string;
  /** CSS class suffix for colouring. */
  tone: 'str' | 'num' | 'id' | 'date' | 'bool' | 'null' | 'misc';
}

/** If `v` is a BSON scalar, describe it; otherwise null (arrays and plain documents). */
export function scalar(v: unknown): Scalar | null {
  if (v === null || v === undefined) return { type: 'Null', text: 'null', tone: 'null' };
  if (typeof v === 'string') return { type: 'String', text: JSON.stringify(v), tone: 'str' };
  if (typeof v === 'boolean') return { type: 'Boolean', text: String(v), tone: 'bool' };
  if (typeof v === 'number') return { type: 'Number', text: String(v), tone: 'num' };
  if (Array.isArray(v) || !isObj(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1 || !keys[0]!.startsWith('$')) return null;
  const k = keys[0]!;
  const x = v[k];
  switch (k) {
    case '$oid': return { type: 'ObjectId', text: `ObjectId("${String(x)}")`, tone: 'id' };
    case '$date': return { type: 'Date', text: typeof x === 'string' ? x : `${isObj(x) ? String(x.$numberLong) : '?'} ms`, tone: 'date' };
    case '$numberInt': return { type: 'Int32', text: String(x), tone: 'num' };
    case '$numberLong': return { type: 'Int64', text: String(x), tone: 'num' };
    case '$numberDouble': return { type: 'Double', text: String(x), tone: 'num' };
    case '$numberDecimal': return { type: 'Decimal128', text: String(x), tone: 'num' };
    case '$uuid': return { type: 'UUID', text: `UUID("${String(x)}")`, tone: 'id' };
    case '$binary': {
      const b = isObj(x) ? x : {};
      const b64 = String(b.base64 ?? '');
      return { type: 'Binary', text: `Binary(${b.subType ?? '00'}, ${b64.length > 48 ? b64.slice(0, 48) + '…' : b64})`, tone: 'misc' };
    }
    case '$regularExpression': {
      const r = isObj(x) ? x : {};
      return { type: 'RegExp', text: `/${String(r.pattern ?? '')}/${String(r.options ?? '')}`, tone: 'misc' };
    }
    case '$timestamp': {
      const t = isObj(x) ? x : {};
      return { type: 'Timestamp', text: `Timestamp(${String(t.t)}, ${String(t.i)})`, tone: 'misc' };
    }
    case '$minKey': return { type: 'MinKey', text: 'MinKey', tone: 'misc' };
    case '$maxKey': return { type: 'MaxKey', text: 'MaxKey', tone: 'misc' };
    case '$undefined': return { type: 'Undefined', text: 'undefined', tone: 'null' };
    case '$symbol': return { type: 'Symbol', text: JSON.stringify(String(x)), tone: 'str' };
    case '$code': return { type: 'Code', text: String(x), tone: 'misc' };
    case '$truncated': {
      const t = isObj(x) ? x : {};
      const preview = t.type === 'string' ? ` ${JSON.stringify(String(t.preview ?? ''))}…` : '';
      return { type: t.type === 'binary' ? 'Binary' : 'String', text: `(${String(t.type)}, ${Number(t.length).toLocaleString()} ${t.type === 'binary' ? 'bytes' : 'characters'}, too large to show)${preview}`, tone: 'misc' };
    }
    default:
      return null;
  }
}

/** Canonical -> relaxed Extended JSON text, for copying. */
export function relaxedJson(doc: unknown): string {
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(walk);
    if (!isObj(v)) return v;
    const keys = Object.keys(v);
    if (keys.length === 1) {
      const k = keys[0]!;
      const x = v[k];
      if (k === '$numberInt') return Number(x);
      if (k === '$numberDouble') {
        const n = Number(x);
        return Number.isFinite(n) ? n : v;
      }
      if (k === '$numberLong') {
        const n = Number(x);
        return Number.isSafeInteger(n) ? n : v;
      }
    }
    return Object.fromEntries(Object.entries(v).map(([a, b]) => [a, walk(b)]));
  };
  return JSON.stringify(walk(doc), null, 2);
}

/** Short text for a table cell or a collapsed value. */
export function brief(v: unknown): string {
  const s = scalar(v);
  if (s) return s.text;
  if (Array.isArray(v)) return `Array(${v.length})`;
  if (isObj(v)) return `{ ${Object.keys(v).length} field${Object.keys(v).length === 1 ? '' : 's'} }`;
  return String(v);
}

function Row({ k, v, depth, open }: { k: string | number; v: unknown; depth: number; open: boolean }) {
  const [expanded, setExpanded] = useState(open);
  const s = scalar(v);
  const isArr = Array.isArray(v);
  const keyEl = <span className="bson-key">{k}</span>;
  if (s) {
    return (
      <div className="bson-row" style={{ paddingLeft: depth * 16 + 16 }}>
        {keyEl}
        <span className="bson-colon">:</span>
        <span className={`bson-val bson-${s.tone}`} title={s.type}>{s.text}</span>
        <span className="bson-type">{s.type}</span>
      </div>
    );
  }
  const entries: [string | number, unknown][] = isArr ? (v as unknown[]).map((x, i) => [i, x]) : Object.entries(v as Obj);
  return (
    <>
      <div className="bson-row bson-branch" style={{ paddingLeft: depth * 16 }} onClick={() => setExpanded(!expanded)}>
        <span className="bson-caret" aria-hidden="true">{expanded ? '▾' : '▸'}</span>
        {keyEl}
        <span className="bson-colon">:</span>
        <span className="bson-sum">{isArr ? `Array (${entries.length})` : `Object (${entries.length})`}</span>
      </div>
      {expanded && entries.map(([ck, cv]) => <Row key={String(ck)} k={ck} v={cv} depth={depth + 1} open={false} />)}
    </>
  );
}

/** One document as a collapsible tree; top-level fields are shown, nested ones fold. */
export function DocTree({ doc }: { doc: unknown }): ReactNode {
  if (!isObj(doc)) return <div className="bson-tree"><Row k="value" v={doc} depth={0} open={false} /></div>;
  return (
    <div className="bson-tree">
      {Object.entries(doc).map(([k, v]) => (
        <Row key={k} k={k} v={v} depth={0} open={false} />
      ))}
    </div>
  );
}
