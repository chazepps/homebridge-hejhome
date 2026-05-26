import { describe, expect, test } from 'vitest';

import { createSessionLogContext } from '../src/utils/sessionDiagnostics.js';

describe('session diagnostics', () => {
  test('summarizes session expiry and secret previews without leaking raw values', () => {
    const context = createSessionLogContext({
      identifier: 'user@example.test',
      autoLogin: true,
      accessToken: 'access-token-secret',
      jsessionId: 'session-cookie-secret',
      usernameCookie: 'username-cookie-secret',
      expiresAt: Date.UTC(2026, 5, 2, 12, 0, 0),
    }, Date.UTC(2026, 5, 1, 12, 0, 0));

    expect(context).toMatchObject({
      identifierType: 'email',
      identifierLength: 17,
      expiresAt: Date.UTC(2026, 5, 2, 12, 0, 0),
      expiresAtIso: '2026-06-02T12:00:00.000Z',
      refreshRecommendedAtIso: '2026-06-01T12:00:00.000Z',
      accessTokenPreview: {
        prefix4: 'acce',
        length: 19,
      },
      sessionCookiePreview: {
        prefix4: 'sess',
        length: 21,
      },
    });
    expect(JSON.stringify(context)).not.toContain('access-token-secret');
    expect(JSON.stringify(context)).not.toContain('session-cookie-secret');
    expect(JSON.stringify(context)).not.toContain('user@example.test');
  });
});
