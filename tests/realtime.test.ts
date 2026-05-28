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
});

function dispatchMessage(client: HejRealtimeClient, payload: unknown): void {
  (client as unknown as { handleMessage(payload: string): void })
    .handleMessage(JSON.stringify(payload));
}
