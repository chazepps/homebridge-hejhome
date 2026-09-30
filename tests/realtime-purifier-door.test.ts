import { expect, test } from 'vitest';
import { HejRealtimeClient } from '../src/hej/realtime.js';
import type { HejDevice, HejSession } from '../src/types.js';

const session: HejSession = { identifier: 'user@example.test', autoLogin: true,
  accessToken: 'test', jsessionId: 'test', usernameCookie: 'test', expiresAt: 1 };

function collectReports(values: Array<{ code: string; value: unknown }>): Record<string, unknown>[] {
  const updates: Array<Partial<HejDevice> & { id: string }> = [];
  const client = new HejRealtimeClient(session, { onDeviceUpdate: (device) => updates.push(device), onError: () => undefined });
  for (const status of values) {
    (client as unknown as { handleMessage(payload: string): void }).handleMessage(JSON.stringify({
      deviceDataReport: { devId: 'test-device', status: [status] },
    }));
  }
  return updates.map((device) => device.deviceState ?? {});
}

test('normalizes purifier switch reports without treating string false as on', () => {
  const reports = collectReports([
    { code: 'switch', value: true }, { code: 'switch', value: false },
    { code: 'switch', value: 'true' }, { code: 'switch', value: 'false' },
    { code: 'switch', value: 1 }, { code: 'switch', value: 0 },
    { code: 'switch', value: 'unknown' },
  ]);
  expect(reports.map((state) => state.power)).toEqual([true, false, true, false, true, false, null]);
  expect(reports.at(-1)?.state).toBeUndefined();
});

test('maps door_opened only when its value is a boolean', () => {
  const reports = collectReports([
    { code: 'door_opened', value: true }, { code: 'door_opened', value: false },
    { code: 'door_opened', value: null }, { code: 'door_opened', value: 'false' },
    { code: 'door_opened', value: 0 },
  ]);
  expect(reports.map((state) => state.doorOpened)).toEqual([true, false, null, null, null]);
  expect(reports.some((state) => 'door_opened' in state)).toBe(false);
});
