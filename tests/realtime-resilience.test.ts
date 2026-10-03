import { EventEmitter } from 'node:events';

import mqtt, { type MqttClient } from 'mqtt';
import { afterEach, describe, expect, test, vi } from 'vitest';

import { HejRealtimeClient } from '../src/hej/realtime.js';

afterEach(() => vi.restoreAllMocks());

describe('Hejhome realtime network resilience', () => {
  test.each([
    '{"access_token":"private-token",',
    'null',
    '{"deviceDataReport":{"devId":"device-1","status":{}}}',
    '{"deviceDataReport":{"devId":"device-1","status":[null]}}',
  ])('survives malformed MQTT payload and processes the next message: %s', (payload) => {
    const socket = Object.assign(new EventEmitter(), { end: vi.fn() });
    vi.spyOn(mqtt, 'connect').mockReturnValue(socket as unknown as MqttClient);
    const updates: unknown[] = [];
    const diagnostics: unknown[] = [];
    const client = new HejRealtimeClient({
      identifier: 'user@example.test',
      autoLogin: true,
      accessToken: 'access-token',
      jsessionId: 'session-id',
      usernameCookie: 'user%40example.test',
      expiresAt: 1,
    }, {
      onDeviceUpdate: (device) => updates.push(device),
      onError: (error) => diagnostics.push(error.message),
      onStatus: (event, data) => diagnostics.push({ event, data }),
    });
    client.connect();

    expect(() => socket.emit('message', 'custom.test.*', Buffer.from(payload))).not.toThrow();
    expect(updates).toHaveLength(0);
    expect(JSON.stringify(diagnostics)).not.toContain('private-token');

    socket.emit('message', 'custom.test.*', Buffer.from(JSON.stringify({
      deviceDataReport: { devId: 'device-1', status: [{ code: 'switch_power', value: true }] },
    })));
    expect(updates).toEqual([{ id: 'device-1', deviceState: { power: true } }]);
    client.disconnect();
    expect(socket.end).toHaveBeenCalledWith(true);
  });
});
