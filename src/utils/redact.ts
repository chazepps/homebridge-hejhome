const SENSITIVE_KEY_PATTERN = /^(accessToken|authCode|authorization|cookie|jsessionId|password|refreshToken|token|topic|usernameCookie)$/i;

export function redactSensitive(value: string): string {
  return value
    .replace(/(authorization\s*:\s*)Basic\s+[^\s;,"']+/gi, '$1Basic <REDACTED_BASIC>')
    .replace(/(authorization\s*:\s*)Bearer\s+[^\s;,"']+/gi, '$1Bearer <REDACTED_BEARER>')
    .replace(/\bBasic\s+[A-Za-z0-9+/=._-]+/g, 'Basic <REDACTED_BASIC>')
    .replace(/\bBearer\s+[A-Za-z0-9._-]+/g, 'Bearer <REDACTED_BEARER>')
    .replace(/\bJSESSIONID=([^;"'\s]+)/gi, 'JSESSIONID=<REDACTED>')
    .replace(/\baccessToken=([^;"'\s]+)/gi, 'accessToken=<REDACTED>')
    .replace(/\busername=([^;"'\s]+)/gi, 'username=<REDACTED>')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '<REDACTED_EMAIL>');
}

export function sanitizeForLog<T>(value: T): T {
  return sanitizeValue(value) as T;
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === 'string') {
    return redactSensitive(value);
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item));
  }

  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERN.test(key)) {
        output[key] = redactSensitiveValue(key, nestedValue);
      } else {
        output[key] = sanitizeValue(nestedValue);
      }
    }
    return output;
  }

  return value;
}

function redactSensitiveValue(key: string, value: unknown): string {
  if (key.toLowerCase() === 'authorization' && typeof value === 'string') {
    if (/\bBasic\s+/i.test(value)) {
      return '<REDACTED_BASIC>';
    }
    if (/\bBearer\s+/i.test(value)) {
      return '<REDACTED_BEARER>';
    }
  }

  return '<REDACTED>';
}
