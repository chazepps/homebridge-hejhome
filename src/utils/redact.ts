const SENSITIVE_NAMES = [
  'access[_-]?token', 'auth[_-]?code', 'authorization(?:[_-]?code)?', 'client[_-]?secret',
  'jsessionId', 'password', 'refresh[_-]?token', 'token', 'topic', 'usernameCookie',
].join('|');
const SENSITIVE_KEY_PATTERN = new RegExp(`^(${SENSITIVE_NAMES}|cookie)$`, 'i');
const ASSIGNMENT_PATTERN = new RegExp(
  String.raw`(["']?\b(?:${SENSITIVE_NAMES}|username)\b["']?\s*[:=]\s*)` +
  String.raw`("(?:\\.|[^"\\])*(?:"|$)|'(?:\\.|[^'\\])*(?:'|$)|[^\s;,&}"']+)`, 'gi');
const REDACTED = '<REDACTED>';
const MAX_DEPTH = 16;
const MAX_STRING_LENGTH = 16_384;
const MAX_VALUES = 4096;
interface RedactionContext { remaining: number; ancestors: WeakSet<object> }

export function redactSensitive(value: string): string {
  return sanitizeForLog(value);
}

export function sanitizeForLog<T>(value: T): T {
  try {
    return sanitizeValue(value, 0, { remaining: MAX_VALUES, ancestors: new WeakSet() }) as T;
  } catch {
    // Untrusted diagnostics (including getters) must never escape through a raw fallback.
    return REDACTED as T;
  }
}

function sanitizeValue(value: unknown, depth: number, context: RedactionContext): unknown {
  if (depth >= MAX_DEPTH || context.remaining-- <= 0) {
    return REDACTED;
  }
  if (typeof value === 'string') {
    return sanitizeString(value, depth, context);
  }
  if (value && typeof value === 'object') {
    if (context.ancestors.has(value)) {
      return REDACTED;
    }
    context.ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        if (value.length > context.remaining) {
          return REDACTED;
        }
        return value.map((item) => sanitizeValue(item, depth + 1, context));
      }
      const entries = Object.entries(value);
      if (entries.length > context.remaining) {
        return REDACTED;
      }
      return Object.fromEntries(entries.map(([key, nested]) => [key,
        SENSITIVE_KEY_PATTERN.test(key) ? redactSensitiveValue(key, nested) : sanitizeValue(nested, depth + 1, context),
      ]));
    } finally {
      context.ancestors.delete(value);
    }
  }
  return value;
}

function sanitizeString(value: string, depth: number, context: RedactionContext): string {
  if (value.length > MAX_STRING_LENGTH) {
    return REDACTED;
  }

  // Interpret complete JSON before text matching so nested serialized values are visited too.
  if (/^\s*[[{"]/.test(value)) {
    try {
      const parsed: unknown = JSON.parse(value);
      const sanitized = sanitizeValue(parsed, depth + 1, context);
      return JSON.stringify(parsed) === JSON.stringify(sanitized) ? value : JSON.stringify(sanitized);
    } catch {
      // A partial response can still contain complete JSON strings and plain assignments below.
    }
  }

  // Only change URL encoding when decoding reveals data that actually needs masking.
  // Decode valid runs independently so a malformed percent elsewhere cannot bypass masking.
  let decodeFailed = false;
  const decoded = value.replace(/(?:%[a-f\d]{2})+/gi, (encoded) => {
    try {
      return decodeURIComponent(encoded);
    } catch {
      decodeFailed = true;
      return REDACTED;
    }
  });
  if (decodeFailed) {
    return REDACTED;
  }
  if (decoded !== value) {
    const sanitized = sanitizeValue(decoded, depth + 1, context) as string;
    if (sanitized !== decoded) {
      return sanitized;
    }
  }

  // Embedded JSON (e.g. after "HTTP 401") is handled at its quoted-string boundaries.
  const strings = value.replace(/"(?:\\.|[^"\\])*(?:"|$)/g, (quoted) => {
    try {
      const parsed = JSON.parse(quoted) as string;
      const sanitized = sanitizeValue(parsed, depth + 1, context);
      return sanitized === parsed ? quoted : JSON.stringify(sanitized);
    } catch {
      return REDACTED;
    }
  });
  return redactPlainText(strings);
}

function redactPlainText(value: string): string {
  return value
    .replace(/(authorization\s*:\s*)Basic\s+[^\s;,"']+/gi, '$1Basic <REDACTED_BASIC>')
    .replace(/(authorization\s*:\s*)Bearer\s+[^\s;,"']+/gi, '$1Bearer <REDACTED_BEARER>')
    .replace(/\bBasic\s+[A-Za-z0-9+/=._-]+/g, 'Basic <REDACTED_BASIC>')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/g, 'Bearer <REDACTED_BEARER>')
    .replace(/([?&]code=)[^&#\s;"']+/gi, '$1<REDACTED>')
    .replace(
      ASSIGNMENT_PATTERN,
      (_match, prefix: string, secret: string, offset: number, input: string) => {
        if (/\bauthorization["']?\s*[:=]\s*$/i.test(prefix) && /^(Basic|Bearer)$/i.test(secret)
          && /^ <REDACTED_(BASIC|BEARER)>/.test(input.slice(offset + _match.length))) {
          return _match;
        }
        const quote = secret.startsWith('"') ? '"' : secret.startsWith('\'') ? '\'' : '';
        return `${prefix}${quote}${REDACTED}${quote}`;
      })
    // Cookie headers were masked field by field above; opaque cookie assignments still need masking.
    .replace(/(\bcookie\s*[:=]\s*)("[^"\n]*"|'[^'\n]*'|[^\s;,"']+)/gi,
      (match, prefix: string, cookie: string) => /^(username|JSESSIONID|accessToken)=/i.test(cookie) ? match : `${prefix}${REDACTED}`)
    // Match each candidate once, avoiding quadratic retries on long non-email tokens.
    .replace(/[A-Z0-9._%+@-]+/gi, (candidate) => {
      const at = candidate.indexOf('@');
      return at > 0 && /\.[A-Z]{2,}/i.test(candidate.slice(at + 1)) ? '<REDACTED_EMAIL>' : candidate;
    });
}

function redactSensitiveValue(key: string, value: unknown): string {
  if (typeof value === 'string' && /^<REDACTED(?:_BASIC|_BEARER)?>$/.test(value)) {
    return value;
  }
  if (key.toLowerCase() === 'authorization' && typeof value === 'string') {
    if (/\bBasic\s+/i.test(value)) {
      return '<REDACTED_BASIC>';
    }
    if (/\bBearer\s+/i.test(value)) {
      return '<REDACTED_BEARER>';
    }
  }
  return REDACTED;
}
