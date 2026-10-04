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
  test('redacts transport error details before delivering auth diagnostic events', async () => {
    const events: unknown[] = [];
    const client = new HejAuthClient({
      fetch: async () => {
        throw new Error('failed authCode=654321 access_token=private-access-token');
      },
      logger: (event) => events.push(event),
    });

    await expect(client.verifyCode('user@example.test', '654321')).rejects.toThrow('failed');

    expect(events).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'error' })]));
    expect(JSON.stringify(events)).not.toContain('654321');
    expect(JSON.stringify(events)).not.toContain('private-access-token');
  });

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


describe('authentication HTTP failure boundary', () => {
  test.each([
    JSON.stringify({ error_description: JSON.stringify({ authCode: '654321', access_token: 'synthetic-access' }) }),
    'error_description=authCode%3D654321%26access_token%3Dsynthetic-access',
    'Set-Cookie: JSESSIONID="synthetic-session"; Path=/',
    'unlabelled synthetic-access',
  ])('does not expose an authentication response body through errors: %s', async (body) => {
    const response = new Response(body, { status: 401 });
    const events: unknown[] = [];
    const client = new HejAuthClient({ fetch: async () => response, logger: (event) => events.push(event) });
    let error: unknown;
    try {
      await client.verifyCode('user@example.test', '654321');
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain('verify');
    expect((error as Error).message).toContain('HTTP 401');
    expect((error as Error).message).not.toContain('654321');
    expect((error as Error).message).not.toContain('synthetic-');
    expect(JSON.stringify(events)).not.toContain('synthetic-');
    expect(response.bodyUsed).toBe(true);
  });

  test('rejects promptly without reading or awaiting cancellation of an untrusted error stream', async () => {
    let cancelled = false;
    const response = new Response(new ReadableStream({
      cancel() {
        cancelled = true; return new Promise<void>(() => {});
      },
    }), { status: 401 });
    const client = new HejAuthClient({ fetch: async () => response, requestTimeoutMs: 20 });
    const outcome = await Promise.race([
      client.verifyCode('user@example.test', '654321').catch((error: Error) => error.message),
      new Promise<string>((resolve) => setTimeout(() => resolve('stalled'), 100)),
    ]);
    expect(outcome).toContain('HTTP 401');
    expect(cancelled).toBe(true);
  });
});
