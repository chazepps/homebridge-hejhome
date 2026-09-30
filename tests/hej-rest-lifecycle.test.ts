import { describe, expect, test, vi } from 'vitest';
import { HejRestClient } from '../src/hej/rest.js';
import type { HejSession } from '../src/types.js';

const session: HejSession = { identifier: 'user@example.test', autoLogin: true, accessToken: 'test',
  jsessionId: 'test', usernameCookie: 'test', expiresAt: 1 };
function pendingClient(bodyPending: boolean) {
  let signal!: AbortSignal;
  const fetch = vi.fn((_url: unknown, init: RequestInit) => {
    signal = init.signal as AbortSignal;
    const pending = new Promise<string>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    });
    return bodyPending ? Promise.resolve({ ok: true, status: 200, text: () => pending }) : pending;
  }) as unknown as typeof globalThis.fetch;
  const client = new HejRestClient(session, { fetch });
  return { client, signal: () => signal };
}

describe('REST client session replacement and shutdown', () => {
  test.each([false, true])('disposes pending requests including response bodies (body=%s)', async (bodyPending) => {
    const f = pendingClient(bodyPending);
    const request = f.client.getFamilies().catch((error) => error);
    await Promise.resolve();
    (f.client as unknown as { dispose?: () => void }).dispose?.();
    expect(f.signal().aborted).toBe(true);
    expect(await request).toBeInstanceOf(Error);
    await expect(f.client.getFamilies()).rejects.toThrow('closed');
  });
  test('the request timeout remains active while the response body is pending', async () => {
    vi.useFakeTimers();
    try {
      const f = pendingClient(true);
      const request = f.client.getFamilies().catch((error) => error);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(30_001);
      expect(f.signal().aborted).toBe(true);
      expect(await request).toBeInstanceOf(Error);
    } finally {
      vi.useRealTimers();
    }
  });
});
