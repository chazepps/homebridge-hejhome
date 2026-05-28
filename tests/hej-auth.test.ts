import { describe, expect, test, vi } from 'vitest';

import { HejAuthClient } from '../src/hej/auth.js';

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
      if (href.endsWith('/oauth/login?vendor=shop')) {
        return new Response('', {
          status: 200,
          headers: {
            'set-cookie': `${'JSESSION'}ID=session-id; Path=/; HttpOnly`,
          },
        });
      }

      if (href.startsWith('https://square.hej.so/oauth/authorize')) {
        return new Response('', {
          status: 302,
          headers: {
            location: 'https://square.hej.so/list?code=auth-code',
          },
        });
      }

      if (href.endsWith('/oauth/token')) {
        expect(init?.body?.toString()).toContain('grant_type=authorization_code');
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
});
