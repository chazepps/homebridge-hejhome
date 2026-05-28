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
            brightness: 75,
          },
        },
      },
    ]);
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
