import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

const root = path.resolve(import.meta.dirname, '..');
const scriptPath = path.join(root, 'tools/homebridge/verify-pi-runtime.mjs');

describe('Pi runtime verification script', () => {
  test('summarizes a redacted Pi runtime check from remote JSON', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HEJHOME_PI_VERIFY_REMOTE_JSON: JSON.stringify({
          nodeVersion: 'v22.14.0',
          serviceActive: 'active',
          linkedPluginPath: '/var/lib/homebridge/node_modules/@chazepps/homebridge-hejhome',
          packageVersion: '2.0.0',
          logTail: [
            '[Hejhome] platform.session.loaded',
            '[Hejhome] platform.accessory-load.start',
            '[Hejhome] platform.snapshot.saved',
            '[Hejhome] platform.realtime.subscribe.success',
          ].join('\n'),
          snapshot: {
            generatedAt: '2026-05-28T05:00:00.000Z',
            familyCount: 1,
            deviceCount: 5,
            families: [
              {
                family: { familyId: 1, name: 'Home' },
                devices: [
                  { id: 'light-rgbw', name: 'RGBW', deviceType: 'LightRgbw5', modelName: 'GKW-MD081', deviceState: {} },
                  { id: 'motion', name: 'Motion', deviceType: 'SensorMo', modelName: 'GKZ-MO021', deviceState: {} },
                  { id: 'light-ww', name: 'White', deviceType: 'LightWw3', modelName: 'GKW-LB031-WW', deviceState: {} },
                  { id: 'switch', name: 'Switch', deviceType: 'ZigbeeSwitch2', modelName: '2구 스위치', deviceState: {} },
                  { id: 'relay', name: 'Relay', deviceType: 'RelayController', modelName: '릴레이 컨트롤러', deviceState: {} },
                ],
              },
            ],
          },
        }),
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Pi runtime verification passed');
    expect(result.stdout).toContain('Node: v22.14.0');
    expect(result.stdout).toContain('Families: 1, devices: 5');
    expect(result.stdout).toContain('Core types: LightRgbw5, SensorMo, LightWw3, ZigbeeSwitch2, RelayController');
    expect(result.stdout).not.toMatch(/\bBearer\b|JSESSIONID=|accessToken=|password/i);
  });

  test('accepts an intentionally empty custom scope with no devices', () => {
    const result = spawnSync(process.execPath, [scriptPath], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        HEJHOME_PI_VERIFY_REMOTE_JSON: JSON.stringify({
          nodeVersion: 'v22.14.0',
          serviceActive: 'active',
          linkedPluginPath: '/var/lib/homebridge/node_modules/@chazepps/homebridge-hejhome',
          packageVersion: '2.0.0',
          scope: {
            mode: 'custom',
            includedFamilyIds: [],
            includedRoomsByFamilyId: {},
          },
          logTail: [
            '[Hejhome] platform.session.loaded',
            '[Hejhome] platform.accessory-load.start',
            '[Hejhome] platform.snapshot.saved',
            '[Hejhome] platform.realtime.subscribe.success',
          ].join('\n'),
          snapshot: {
            generatedAt: '2026-05-28T05:00:00.000Z',
            familyCount: 0,
            deviceCount: 0,
            families: [],
          },
        }),
      },
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('Pi runtime verification passed');
    expect(result.stdout).toContain('Families: 0, devices: 0');
    expect(result.stdout).toContain('Device scope: intentionally empty');
    expect(result.stdout).not.toMatch(/\bBearer\b|JSESSIONID=|accessToken=|password/i);
  });
});
