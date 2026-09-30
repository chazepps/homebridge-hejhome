import { describe, expect, test } from 'vitest';

import { HejRealtimeClient } from '../src/hej/realtime.js';
import type { HejDevice, HejSession } from '../src/types.js';

const session: HejSession = {
  identifier: 'user@example.test',
  autoLogin: true,
  accessToken: 'access-token',
  jsessionId: 'session-id',
  usernameCookie: 'user%40example.test',
  expiresAt: 1,
};

describe('HejRealtimeClient message mapping', () => {
  test('maps RGBW realtime light payloads into HomeKit color state', () => {
    const updates: Array<Partial<HejDevice> & { id: string }> = [];
    const client = new HejRealtimeClient(session, {
      onDeviceUpdate: (device) => updates.push(device),
      onError: () => undefined,
    });

    dispatchMessage(client, {
      deviceDataReport: {
        devId: 'light-1',
        status: [
          { code: 'work_mode', value: 'colour' },
          { code: 'colour_data', value: '{"h":261.0,"s":255.0,"v":192.0}' },
        ],
      },
    });

    expect(updates).toEqual([
      {
        id: 'light-1',
        deviceState: {
          lightMode: 'COLOR',
          hsvColor: {
            hue: 261,
            saturation: 100,
            brightness: 73,
          },
        },
      },
    ]);
  });

  test('does not leak raw realtime status codes into HomeKit-facing state', () => {
    const updates: Array<Partial<HejDevice> & { id: string }> = [];
    const client = new HejRealtimeClient(session, {
      onDeviceUpdate: (device) => updates.push(device),
      onError: () => undefined,
    });

    dispatchMessage(client, {
      deviceDataReport: {
        devId: 'mixed-1',
        status: [
          { code: 'work_mode', value: 'white' },
          { code: 'colour_data', value: '{"h":120,"s":255,"v":127}' },
          { code: 'pir', value: 'pir' },
        ],
      },
    });

    expect(updates).toHaveLength(1);
    expect(updates[0].deviceState).toMatchObject({
      lightMode: 'WHITE',
      hsvColor: {
        hue: 120,
        saturation: 100,
        brightness: 44,
      },
      motionDetected: true,
    });
    expect(Object.keys(updates[0].deviceState ?? {})).not.toEqual(expect.arrayContaining([
      'work_mode',
      'colour_data',
      'pir',
    ]));
  });

  test('maps motion sensor pir realtime payloads into MotionDetected state', () => {
    const updates: Array<Partial<HejDevice> & { id: string }> = [];
    const client = new HejRealtimeClient(session, {
      onDeviceUpdate: (device) => updates.push(device),
      onError: () => undefined,
    });

    dispatchMessage(client, {
      deviceDataReport: {
        devId: 'motion-1',
        status: [
          { code: 'pir', value: 'pir' },
        ],
      },
    });

    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({
      id: 'motion-1',
      deviceState: {
        motionDetected: true,
      },
    });
    expect(updates[0].deviceState?.lastMotionAt).toEqual(expect.any(Number));

    dispatchMessage(client, {
      deviceDataReport: {
        devId: 'motion-1',
        status: [
          { code: 'pir', value: 'none' },
        ],
      },
    });

    expect(updates[1]).toEqual({
      id: 'motion-1',
      deviceState: {
        motionDetected: false,
      },
    });
  });

  test('maps switch, curtain, plug, and sensor realtime datapoints into normalized state', () => {
    const updates: Array<Partial<HejDevice> & { id: string }> = [];
    const client = new HejRealtimeClient(session, {
      onDeviceUpdate: (device) => updates.push(device),
      onError: () => undefined,
    });

    dispatchMessage(client, {
      deviceDataReport: {
        devId: 'switch-1',
        status: [
          { code: 'switch_1', value: true },
          { code: 'switch_3', value: false },
        ],
      },
    });
    dispatchMessage(client, {
      deviceDataReport: {
        devId: 'curtain-1',
        status: [
          { code: 'percent_state', value: 45 },
          { code: 'percent_control', value: 60 },
          { code: 'control', value: 'open' },
        ],
      },
    });
    dispatchMessage(client, {
      deviceDataReport: {
        devId: 'plug-1',
        status: [
          { code: 'cur_power', value: 12 },
          { code: 'cur_current', value: 34 },
          { code: 'cur_voltage', value: 220 },
        ],
      },
    });
    dispatchMessage(client, {
      deviceDataReport: {
        devId: 'sensor-1',
        status: [
          { code: 'va_temperature', value: 235 },
          { code: 'va_humidity', value: 551 },
          { code: 'battery', value: 88 },
        ],
      },
    });

    expect(updates).toEqual([
      {
        id: 'switch-1',
        deviceState: {
          power1: true,
          power3: false,
        },
      },
      {
        id: 'curtain-1',
        deviceState: {
          percentState: 45,
          percentControl: 60,
          control: 'open',
        },
      },
      {
        id: 'plug-1',
        deviceState: {
          curPower: 12,
          curCurrent: 34,
          curVoltage: 220,
        },
      },
      {
        id: 'sensor-1',
        deviceState: {
          temperature: 23.5,
          humidity: 55,
          battery: 88,
        },
      },
    ]);
  });
});

function dispatchMessage(client: HejRealtimeClient, payload: unknown): void {
  (client as unknown as { handleMessage(payload: string): void })
    .handleMessage(JSON.stringify(payload));
}

test('invalid meter reports remain unknown instead of appearing as zero power', () => {
  const updates: Array<Partial<HejDevice> & { id: string }> = [];
  const client = new HejRealtimeClient(session, { onDeviceUpdate: (d) => updates.push(d), onError: () => undefined });
  dispatchMessage(client, { deviceDataReport: { devId: 'plug', status: [
    { code: 'cur_power', value: 'invalid' }, { code: 'cur_voltage', value: null }, { code: 'cur_current', value: 0 },
  ] } });
  expect(updates[0]?.deviceState).toEqual({ curPower: null, curVoltage: null, curCurrent: 0 });
});

test('uses the vendor light report scale and leaves malformed values unknown', () => {
  const updates: Array<Partial<HejDevice> & { id: string }> = [];
  const client = new HejRealtimeClient(session, { onDeviceUpdate: (d) => updates.push(d), onError: () => undefined });
  for (const raw of [25, 127, 255, 0, null, 'invalid']) {
    dispatchMessage(client, { deviceDataReport: { devId: 'light', status: [
      { code: 'bright_value', value: raw }, { code: 'colour_data', value: { h: 120, s: raw, v: raw } },
    ] } });
  }
  expect(updates.map((update) => update.deviceState?.brightness)).toEqual([0, 44, 100, undefined, undefined, undefined]);
  expect(updates.map((update) => update.deviceState?.hsvColor?.brightness)).toEqual([0, 44, 100, undefined, undefined, undefined]);
  for (const raw of [0, 115, 230, 255, null]) {
    dispatchMessage(client, { deviceDataReport: { devId: 'white', status: [{ code: 'temp_value', value: raw }] } });
  }
  expect(updates.slice(6).map((update) => update.deviceState?.temperature)).toEqual([0, 50, 100, undefined, undefined]);
});

test('does not turn malformed sensor reports into normal measurements or no motion', () => {
  const updates: Array<Partial<HejDevice> & { id: string }> = [];
  const client = new HejRealtimeClient(session, { onDeviceUpdate: (d) => updates.push(d), onError: () => undefined });
  dispatchMessage(client, { deviceDataReport: { devId: 'sensor', status: [
    { code: 'va_temperature', value: 'invalid' }, { code: 'va_humidity', value: null }, { code: 'pir', value: 'unexpected' },
  ] } });
  expect(updates[0]?.deviceState).toEqual({ temperature: null, humidity: null });
});

test('invalid alarm reports cannot erase a previous alarm with a normal state', () => {
  const updates: Array<Partial<HejDevice> & { id: string }> = [];
  const client = new HejRealtimeClient(session, { onDeviceUpdate: (d) => updates.push(d), onError: () => undefined });
  for (const value of ['alarm', null, 'unexpected']) {
    dispatchMessage(client, { deviceDataReport: { devId: 'smoke', status: [{ code: 'alarm_state', value }] } });
  }
  expect(updates.map((device) => device.deviceState?.alarm)).toEqual([true, null, null]);
  dispatchMessage(client, { deviceDataReport: { devId: 'smoke', status: [{ code: 'alarm_switch', value: 'false' }] } });
  expect(updates.at(-1)?.deviceState?.alarmSwitch).toBe(false);
});

test('rejects malformed message envelopes atomically and handles the next valid report', () => {
  const updates: Array<Partial<HejDevice> & { id: string }> = [];
  const statuses: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const client = new HejRealtimeClient(session, {
    onDeviceUpdate: (device) => updates.push(device), onError: () => undefined,
    onStatus: (event, data) => statuses.push({ event, data }),
  });
  const raw = (payload: string) => (client as unknown as { handleMessage(value: string): void }).handleMessage(payload);
  const invalid: unknown[] = [null, [], 1, { deviceDataReport: null },
    ...[null, {}, '', '  ', 3].map((devId) => ({ deviceDataReport: { devId, status: [] } })),
    ...[null, {}, 'bad', [null], [3], [{ code: 1, value: true }], [{ code: 'power' }],
      [{ code: 'switch_power', value: true }, { code: '__proto__', value: { bad: true } }],
      [{ code: 'constructor', value: {} }], [{ code: 'toString', value: {} }],
    ].map((status) => ({ deviceDataReport: { devId: 'redacted-device', status } })),
  ];
  for (const payload of ['not-json-with-sensitive-data', ...invalid.map((value) => JSON.stringify(value))]) {
    expect(() => raw(payload)).not.toThrow();
    expect(updates).toEqual([]);
  }
  expect(statuses.every((entry) => entry.event === 'message.ignored')).toBe(true);
  expect(JSON.stringify(statuses)).not.toContain('sensitive-data');
  expect(JSON.stringify(statuses)).not.toContain('redacted-device');
  dispatchMessage(client, { deviceDataReport: { devId: 'valid', status: [{ code: 'switch_power', value: true }] } });
  expect(updates).toEqual([{ id: 'valid', deviceState: { power: true } }]);
});

test('bounds realtime work and rejects values that cannot be normalized without breaking later messages', () => {
  const updates: Array<Partial<HejDevice> & { id: string }> = [];
  const client = new HejRealtimeClient(session, { onDeviceUpdate: (device) => updates.push(device), onError: () => undefined });
  const raw = (payload: string) => (client as unknown as { handleMessage(value: string): void }).handleMessage(payload);
  for (const payload of [
    JSON.stringify({ deviceDataReport: { devId: 'test', status: Array.from({ length: 257 }, () => ({ code: 'power', value: true })) } }),
    JSON.stringify({ deviceDataReport: { devId: 'test', status: [{ code: 'scene_data', value: 'x'.repeat(262144) }] } }),
    JSON.stringify({ deviceDataReport: { devId: 'test', status: [{ code: 'temp', value: { toString: 1, valueOf: 2 } }] } }),
  ]) {
    expect(() => raw(payload)).not.toThrow();
    expect(updates).toEqual([]);
  }
  dispatchMessage(client, { deviceDataReport: { devId: 'valid', status: [{ code: 'switch_power', value: false }] } });
  expect(updates).toEqual([{ id: 'valid', deviceState: { power: false } }]);
});
