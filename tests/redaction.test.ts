import { describe, expect, test } from 'vitest';

import { redactSensitive, sanitizeForLog } from '../src/utils/redact.js';

describe('sensitive value redaction', () => {
  test.each([
    ['nested JSON', JSON.stringify({ error_description: JSON.stringify({ authCode: '654321', access_token: 'synthetic-access' }) })],
    ['encoded form', 'error_description=authCode%3D654321%26access_token%3Dsynthetic-access'],
    ['quoted cookie', 'Set-Cookie: JSESSIONID="synthetic-session"; Path=/'],
    ['truncated nested JSON', '{"error_description":"{\\"authCode\\":\\"654321\\",\\"access_token\\":\\"synthetic-access'],
    ['malformed encoding', 'error_description=authCode%3D654321%26access_token%3Dsynthetic-access%ZZ'],
    ['invalid UTF-8 encoded key', '%61%75%74%68%43%6f%64%65%3d%ff654321'],
  ])('redacts %s without restoring credentials on repeated sanitization', (_name, raw) => {
    const redacted = redactSensitive(raw);

    for (const secret of ['654321', 'synthetic-access', 'synthetic-session']) {
      expect(redacted).not.toContain(secret);
    }
    expect(redactSensitive(redacted)).toBe(redacted);
  });

  test('preserves ordinary error codes, statuses, URLs, and immutable nested diagnostics', () => {
    const payload = {
      code: 401,
      status: 'failed',
      url: 'https://example.test/diagnostics?status=failed',
      detail: [{ error_description: JSON.stringify({ access_token: 'synthetic-access', code: 401 }) }],
    };
    const original = structuredClone(payload);
    const redacted = sanitizeForLog(payload);

    expect(redacted).toMatchObject({ code: 401, status: 'failed', url: payload.url });
    expect(JSON.stringify(redacted)).not.toContain('synthetic-access');
    expect(sanitizeForLog(redacted)).toEqual(redacted);
    expect(payload).toEqual(original);
    expect(redactSensitive('request failed code=401 status=failed https://example.test/diagnostics'))
      .toBe('request failed code=401 status=failed https://example.test/diagnostics');
  });

  test('does not return credentials when nested string decoding reaches its limit', () => {
    let raw = 'authCode=654321&access_token=synthetic-access';
    for (let depth = 0; depth < 20; depth += 1) {
      raw = encodeURIComponent(raw);
    }

    const redacted = redactSensitive(raw);

    expect(redacted).not.toContain('654321');
    expect(redacted).not.toContain('synthetic-access');
    expect(redactSensitive(redacted)).toBe(redacted);
  });

  test.each([
    ['redirect https://square.hej.so/list?code=private-oauth-code&state=ready', 'private-oauth-code'],
    ['authCode=654321&status=failed', '654321'],
    ['response: {"access_token":"private-access-token","status":401}', 'private-access-token'],
    ['response: {"authCode":654321,"status":401}', '654321'],
    ['refresh_token: private-refresh-token', 'private-refresh-token'],
    ['password="private password with spaces" status=failed', 'private password with spaces'],
    ['authorization=synthetic-opaque', 'synthetic-opaque'],
    ['cookie=synthetic-cookie', 'synthetic-cookie'],
    ['password=Basic', 'Basic'],
    ['access_token=Bearer', 'Bearer'],
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
