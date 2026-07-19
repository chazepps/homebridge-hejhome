import { describe, expect, test } from 'vitest';

import { createSessionLogContext } from '../src/utils/sessionDiagnostics.js';

describe('session diagnostics', () => {
  test('summarizes session expiry without exposing secret previews or fingerprints', () => {
    const context = createSessionLogContext({
      identifier: 'user@example.test',
      autoLogin: true,
      accessToken: 'top-token-secret',
      jsessionId: 'jar-cookie-secret',
      usernameCookie: 'username-cookie-secret',
      expiresAt: Date.UTC(2026, 5, 2, 12, 0, 0),
    }, Date.UTC(2026, 5, 1, 12, 0, 0));

    expect(context).toMatchObject({
      identifierType: 'email',
      identifierLength: 17,
      expiresAt: Date.UTC(2026, 5, 2, 12, 0, 0),
      expiresAtIso: '2026-06-02T12:00:00.000Z',
      refreshRecommendedAtIso: '2026-06-01T12:00:00.000Z',
      accessTokenPresent: true,
      sessionCookiePresent: true,
    });
    expect(context).not.toHaveProperty('accessTokenPreview');
    expect(context).not.toHaveProperty('sessionCookiePreview');
    expect(JSON.stringify(context)).not.toContain('top-token-secret');
    expect(JSON.stringify(context)).not.toContain('jar-cookie-secret');
    expect(JSON.stringify(context)).not.toContain('top-');
    expect(JSON.stringify(context)).not.toContain('jar-');
    expect(JSON.stringify(context)).not.toContain('sha256');
    expect(JSON.stringify(context)).not.toContain('user@example.test');
  });
});
