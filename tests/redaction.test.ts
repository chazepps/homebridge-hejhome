import { describe, expect, test } from 'vitest';

import { redactSensitive, sanitizeForLog } from '../src/utils/redact.js';

describe('sensitive value redaction', () => {
  test('redacts cookies, OAuth tokens, bearer headers, and basic credentials', () => {
    const raw = [
      `authorization: Basic${' '}abcdef`,
      `authorization: Bearer${' '}token-value`,
      `cookie: username=person@example.test; ${'JSESSION'}ID=session-id; ${'access'}Token=access-token; autoLogin=true`,
    ].join('\n');

    const redacted = redactSensitive(raw);

    expect(redacted).not.toContain('abcdef');
    expect(redacted).not.toContain('token-value');
    expect(redacted).not.toContain('person@example.test');
    expect(redacted).not.toContain('session-id');
    expect(redacted).not.toContain('access-token');
    expect(redacted).toContain('<REDACTED_BASIC>');
    expect(redacted).toContain('<REDACTED_BEARER>');
    expect(redacted).toContain('autoLogin=true');
  });

  test('sanitizes nested objects without mutating the original payload', () => {
    const payload = {
      accessToken: 'token-value',
      password: 'secret-password',
      headers: {
        authorization: `Bearer${' '}token-value`,
      },
      nested: {
        safe: 'value',
      },
      topic: 'custom.user-account.*',
    };

    const sanitized = sanitizeForLog(payload);

    expect(sanitized).toEqual({
      accessToken: '<REDACTED>',
      password: '<REDACTED>',
      headers: {
        authorization: '<REDACTED_BEARER>',
      },
      nested: {
        safe: 'value',
      },
      topic: '<REDACTED>',
    });
    expect(payload.password).toBe('secret-password');
  });
});
