// ─────────────────────────────────────────────────────────────────────────────
// Aura OP One — secret redaction
// ─────────────────────────────────────────────────────────────────────────────
//
// Everything that leaves the process toward a log, a store, or the UI passes
// through here (architecture §8). Aura OP One stores no credentials of its own —
// they are read through aura-code's resolution — but it does handle text that
// may quote them, so redaction is applied on the way out, not on the way in.

const REDACTED = '[redacted]';

/**
 * Patterns for values that must never be persisted or displayed.
 *
 * Ordered longest-context-first: `KEY=value` forms are matched before bare
 * token shapes so the assignment keeps its variable name in the output, which
 * is what makes a redacted log still useful for debugging.
 */
const PATTERNS: Array<{ re: RegExp; replace: (m: string, ...g: string[]) => string }> = [
  // KEY=..., KEY: ..., "KEY": "..." for anything key/token/secret/password-shaped
  {
    re: /\b([A-Z0-9_]*(?:API[_-]?KEY|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*)\b(\s*[:=]\s*)(["']?)([^\s"',}]+)\3/gi,
    replace: (_m, name, sep, quote) => `${name}${sep}${quote}${REDACTED}${quote}`,
  },
  // Authorization: Bearer <token>
  {
    re: /\b(Authorization\s*:\s*Bearer\s+)([A-Za-z0-9._\-]+)/gi,
    replace: (_m, prefix) => `${prefix}${REDACTED}`,
  },
  // Vendor key shapes: sk-..., sk-ant-..., ghp_..., gsk_..., xai-..., AIza...
  { re: /\bsk-ant-[A-Za-z0-9._\-]{8,}/g, replace: () => REDACTED },
  { re: /\bsk-[A-Za-z0-9._\-]{16,}/g, replace: () => REDACTED },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: () => REDACTED },
  { re: /\bAIza[A-Za-z0-9_\-]{20,}/g, replace: () => REDACTED },
  { re: /\bxai-[A-Za-z0-9]{16,}/g, replace: () => REDACTED },
];

/** Replaces credential-shaped substrings with `[redacted]`. */
export function redactSecrets(text: string): string {
  if (!text) return text;
  let out = text;
  for (const { re, replace } of PATTERNS) {
    out = out.replace(re, replace as (substring: string, ...args: unknown[]) => string);
  }
  return out;
}

/**
 * Deep-redacts an arbitrary value: strings are scrubbed, and any object key that
 * looks credential-shaped has its value replaced outright regardless of shape.
 *
 * Used on tool-call inputs before they are stored as verification evidence — a
 * `run_shell` input can easily carry `FOO_API_KEY=... npm test`.
 */
export function redactValue<T>(value: T): T {
  return redactInner(value, 0) as T;
}

const SENSITIVE_KEY = /(api[_-]?key|secret|token|password|passwd|credential|authorization)/i;
const MAX_DEPTH = 12;

function redactInner(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return value;
  if (typeof value === 'string') return redactSecrets(value);
  if (Array.isArray(value)) return value.map(v => redactInner(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SENSITIVE_KEY.test(k) ? REDACTED : redactInner(v, depth + 1);
    }
    return out;
  }
  return value;
}
