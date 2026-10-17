/**
 * Secret redaction used by both the logger and the audit log (FR-10: sensitive
 * values such as passwords, tokens and private keys must never be written).
 */
const SENSITIVE_KEY = /pass(word)?|secret|token|api[-_]?key|private[-_]?key|authorization|cookie|credential|^sid$/i;

export const REDACTED = '[REDACTED]';

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY.test(key);
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[TRUNCATED]';
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    if (value instanceof Error) {
      return { name: value.name, message: value.message };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSensitiveKey(k) ? REDACTED : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && /-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(value)) {
    return REDACTED;
  }
  return value;
}
