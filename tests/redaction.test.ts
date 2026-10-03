import { describe, expect, test } from 'vitest';

import { redactSensitive, sanitizeForLog } from '../src/utils/redact.js';

describe('sensitive value redaction', () => {
  test.each([
    'callback?authCode=secret-code&state=keep',
    'https://square.hej.so/callback?code=secret-code&state=keep',
    'https://square.hej.so/callback?state=keep&code=secret-code#done',
    'client_secret=secret-access&clientSecret=secret-refresh&state=keep',
    'access_token=secret-access; refresh_token=secret-refresh',
    '{"authCode":"secret-code","accessToken":"secret-access","refresh_token":"secret-refresh","status":"keep"}',
    '{\'auth_code\': \'secret-code\', \'token\': \'secret-access\', \'password\': \'secret-refresh\', \'status\': \'keep\'}',
  ])('removes credential values embedded in diagnostic strings: %s', (message) => {
    const redacted = redactSensitive(message);
    for (const secret of ['secret-code', 'secret-access', 'secret-refresh']) {
      expect(redacted).not.toContain(secret);
    }
    expect(redacted).toContain('<REDACTED>');
    if (message.includes('keep')) {
      expect(redacted).toContain('keep');
    }
  });

  test('redacts snake-case provider credentials in nested diagnostic data', () => {
    expect(sanitizeForLog({ response: { auth_code: 'secret-code', access_token: 'secret-access',
      refresh_token: 'secret-refresh', client_secret: 'secret-client', code: 401, status: 'keep' } })).toEqual({ response: {
      auth_code: '<REDACTED>', access_token: '<REDACTED>', refresh_token: '<REDACTED>', client_secret: '<REDACTED>', code: 401, status: 'keep',
    } });
  });

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
