import { describe, expect, test } from 'vitest';

import { redactSensitive, sanitizeForLog } from '../src/utils/redact.js';

describe('sensitive value redaction', () => {
  test.each([
    ['redirect https://square.hej.so/list?code=private-oauth-code&state=ready', 'private-oauth-code'],
    ['authCode=654321&status=failed', '654321'],
    ['response: {"access_token":"private-access-token","status":401}', 'private-access-token'],
    ['response: {"authCode":654321,"status":401}', '654321'],
    ['refresh_token: private-refresh-token', 'private-refresh-token'],
    ['password="private password with spaces" status=failed', 'private password with spaces'],
  ])('redacts credentials embedded in diagnostic strings: %s', (raw, secret) => {
    expect(redactSensitive(raw)).not.toContain(secret);
    expect(redactSensitive(raw)).toContain('<REDACTED>');
  });

  test('redacts OAuth snake-case fields in nested diagnostic objects', () => {
    expect(sanitizeForLog({ response: [{ access_token: 'secret', refresh_token: 'secret', auth_code: '654321' }] }))
      .toEqual({ response: [{ access_token: '<REDACTED>', refresh_token: '<REDACTED>', auth_code: '<REDACTED>' }] });
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
