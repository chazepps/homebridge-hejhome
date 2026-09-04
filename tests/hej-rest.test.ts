import { describe, expect, test, vi } from 'vitest';

import { HEJ_VIRTUAL_FAMILY_ID, HejRestClient } from '../src/hej/rest.js';
import type { HejSession } from '../src/types.js';

const session: HejSession = {
  identifier: 'user@example.test',
  autoLogin: true,
  accessToken: 'access-token',
  jsessionId: 'session-id',
  usernameCookie: 'user%40example.test',
  expiresAt: Date.now() + 86_400_000,
};

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('HejRestClient', () => {
  test('lists devices from the OpenAPI host and synthesizes a virtual home when family ids are absent', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      expect(String(url)).toBe('https://goqual.io/openapi/devices');
      return jsonResponse([
        { id: 'light-1', name: 'Living light', deviceType: 'LightRgbw5', online: true },
        { deviceId: 'plug-1', name: 'Desk plug', deviceType: 'Plug', deviceState: { power: true } },
      ]);
    });
    const client = new HejRestClient(session, { fetch: fetchMock });

    await expect(client.getFamilies()).resolves.toEqual([
      { familyId: HEJ_VIRTUAL_FAMILY_ID, name: 'Hejhome' },
    ]);
    await expect(client.getDevices(HEJ_VIRTUAL_FAMILY_ID)).resolves.toEqual([
      expect.objectContaining({
        id: 'light-1',
        name: 'Living light',
        deviceType: 'LightRgbw5',
        familyId: HEJ_VIRTUAL_FAMILY_ID,
      }),
      expect.objectContaining({
        id: 'plug-1',
        name: 'Desk plug',
        deviceType: 'Plug',
        familyId: HEJ_VIRTUAL_FAMILY_ID,
      }),
    ]);
  });

  test('groups OpenAPI devices by family and room when those fields are present', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      result: [
        { id: 'a', name: 'A', deviceType: 'Plug', familyId: 10, roomId: 2 },
        { id: 'b', name: 'B', deviceType: 'Plug', familyId: 10, roomId: 3 },
        { id: 'c', name: 'C', deviceType: 'Plug', familyId: 11, roomId: 2 },
      ],
    }));
    const client = new HejRestClient(session, { fetch: fetchMock });

    await expect(client.getFamilies()).resolves.toEqual([
      { familyId: 10, name: 'Home 10' },
      { familyId: 11, name: 'Home 11' },
    ]);
    await expect(client.getRooms(10)).resolves.toEqual([
      { room_id: 2, name: 'Room 2' },
      { room_id: 3, name: 'Room 3' },
    ]);
    await expect(client.getDevices(10, 2)).resolves.toEqual([
      expect.objectContaining({ id: 'a', familyId: 10, roomId: 2 }),
    ]);
  });

  test('sends OpenAPI control commands with the requirments payload spelling', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://goqual.io/openapi/control/light-1');
      expect(init?.method).toBe('POST');
      expect(init?.body).toBe(JSON.stringify({ requirments: { power: true } }));
      return new Response('', { status: 200 });
    });
    const client = new HejRestClient(session, { fetch: fetchMock });

    await client.controlDevice('light-1', { power: true });
    expect(fetchMock).toHaveBeenCalledOnce();
  });
});
