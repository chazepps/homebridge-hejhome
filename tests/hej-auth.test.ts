import { describe, expect, test, vi } from 'vitest';

import { HejAuthClient, SQUARE_ORIGIN } from '../src/hej/auth.js';

function jsonResponse(body: unknown, init: ResponseInit = {}) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', ...init.headers },
    ...init,
  });
}

describe('HejAuthClient', () => {
  test('sends email verification through the captured 2FA email endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new HejAuthClient({ fetch: fetchMock });

    await client.sendVerificationCode('user@example.test');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://2factor.goqual.com/api/2factor/send/email?vendor=web',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ email: 'user@example.test' }),
      }),
    );
  });

  test('rejects phone verification instead of calling the unreliable SMS endpoint', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new HejAuthClient({ fetch: fetchMock });

    await expect(client.sendVerificationCode('010-1234-5678')).rejects.toThrow(
      'Hejhome SMS verification is not supported',
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test('verifies a six digit code with the identifier as username', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ ok: true }));
    const client = new HejAuthClient({ fetch: fetchMock });

    await client.verifyCode('user@example.test', '123456');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://2factor.goqual.com/api/2factor/verify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ username: 'user@example.test', authCode: '123456' }),
      }),
    );
  });

  test('exchanges password login for an OAuth access token and persistent auto-login session', async () => {
    const events: unknown[] = [];
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = String(url);
      if (href.endsWith('/oauth/login?vendor=openapi')) {
        expect(init?.body).toBe('{}');
        expect(init?.headers).toEqual(expect.objectContaining({
          'content-type': 'application/json',
        }));
        return new Response('', {
          status: 200,
          headers: {
            'set-cookie': `${'JSESSION'}ID=session-id; Path=/; HttpOnly`,
          },
        });
      }

      if (href.startsWith('https://goqual.io/oauth/authorize')) {
        expect(href).toContain('scope=shop');
        expect(href).toContain(encodeURIComponent(`${SQUARE_ORIGIN}/list`));
        expect(href).not.toContain('vendor=');
        return new Response('', {
          status: 302,
          headers: {
            location: `${SQUARE_ORIGIN}/list?code=auth-code`,
          },
        });
      }

      if (href.endsWith('/oauth/token')) {
        expect(init?.body?.toString()).toContain('grant_type=authorization_code');
        expect(init?.body?.toString()).toContain(encodeURIComponent(`${SQUARE_ORIGIN}/list`));
        return jsonResponse({ access_token: 'access-token', expires_in: 86400 });
      }

      throw new Error(`Unexpected request: ${href}`);
    });
    const client = new HejAuthClient({ fetch: fetchMock, logger: (event) => events.push(event) });

    const session = await client.loginWithPassword({
      identifier: 'user@example.test',
      password: 'secret-password',
      autoLogin: true,
    });

    expect(session).toMatchObject({
      identifier: 'user@example.test',
      autoLogin: true,
      accessToken: 'access-token',
      jsessionId: 'session-id',
      usernameCookie: 'user%40example.test',
    });
    expect(JSON.stringify(session)).not.toContain('secret-password');
    expect(events).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'oauth.login', status: 'start' }),
      expect.objectContaining({ phase: 'oauth.login', status: 'success', httpStatus: 200 }),
      expect.objectContaining({ phase: 'oauth.authorize', status: 'success', httpStatus: 302 }),
      expect.objectContaining({ phase: 'oauth.token', status: 'success', httpStatus: 200 }),
    ]));
    expect(JSON.stringify(events)).not.toContain('secret-password');
    expect(JSON.stringify(events)).not.toContain('user@example.test');
  });

  test('accepts an authorization code returned in the authorize response body', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const href = String(url);
      if (href.endsWith('/oauth/login?vendor=openapi')) {
        return new Response('', {
          status: 200,
          headers: {
            'set-cookie': `${'JSESSION'}ID=session-id; Path=/; HttpOnly`,
          },
        });
      }
      if (href.startsWith('https://goqual.io/oauth/authorize')) {
        expect(href).toContain('scope=shop');
        return new Response('auth-code', { status: 200 });
      }
      if (href.endsWith('/oauth/token')) {
        return jsonResponse({ access_token: 'access-token', expires_in: 86400 });
      }
      throw new Error(`Unexpected request: ${href}`);
    });
    const client = new HejAuthClient({ fetch: fetchMock });

    const session = await client.loginWithPassword({
      identifier: 'user@example.test',
      password: 'secret-password',
    });

    expect(session.accessToken).toBe('access-token');
    expect(session.jsessionId).toBe('session-id');
  });
});
