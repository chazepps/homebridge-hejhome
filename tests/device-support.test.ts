import { describe, expect, test } from 'vitest';

import {
  createDeviceSupportSummary,
  createUnsupportedDeviceIssueTemplate,
  SUPPORTED_DEVICE_MODELS,
} from '../src/utils/deviceSupport.js';
import type { HejDeviceSnapshot } from '../src/storage/deviceSnapshotStore.js';

describe('device support summary', () => {
  test('counts supported and unsupported products from the latest discovery snapshot', () => {
    const snapshot: HejDeviceSnapshot = {
      generatedAt: '2026-05-26T01:00:00.000Z',
      familyCount: 1,
      deviceCount: 3,
      families: [
        {
          family: { familyId: 1, name: 'Home' },
          devices: [
            device('light-1', 'LightRgbw5', 'Pendant'),
            device('relay-1', 'RelayController', 'Relay'),
            device('motion-1', 'SensorMo', 'GKZ-MO021'),
            device('heater-1', 'UnknownHeater', 'Warm Box'),
          ],
        },
      ],
    };

    const summary = createDeviceSupportSummary(snapshot);

    expect(summary).toMatchObject({
      generatedAt: '2026-05-26T01:00:00.000Z',
      registeredCount: 4,
      supportedCount: 3,
      unsupportedCount: 1,
      unsupportedProducts: [
        {
          deviceType: 'UnknownHeater',
          modelName: 'Warm Box',
          count: 1,
        },
      ],
    });
    expect(SUPPORTED_DEVICE_MODELS.map((model) => model.deviceType)).toContain('LightRgbw5');
    expect(SUPPORTED_DEVICE_MODELS.map((model) => model.deviceType)).toContain('RelayController');
    expect(SUPPORTED_DEVICE_MODELS.map((model) => model.deviceType)).toContain('SensorMo');
  });

  test('counts zero devices for an explicitly empty room selection', () => {
    const snapshot: HejDeviceSnapshot = {
      generatedAt: '2026-05-26T01:00:00.000Z',
      familyCount: 1,
      deviceCount: 2,
      families: [
        {
          family: { familyId: 101, name: '1203' },
          devices: [
            { ...device('light-1', 'LightRgbw5', 'Pendant'), familyId: 101, roomId: 1 },
            { ...device('motion-1', 'SensorMo', 'GKZ-MO021'), familyId: 101, roomId: 2 },
          ],
        },
      ],
    };

    const summary = createDeviceSupportSummary(snapshot, {
      mode: 'custom',
      includedFamilyIds: [101],
      includedRoomsByFamilyId: {
        '101': [],
      },
    });

    expect(summary).toMatchObject({
      generatedAt: '2026-05-26T01:00:00.000Z',
      registeredCount: 0,
      supportedCount: 0,
      partialCount: 0,
      deferredCount: 0,
      unsupportedCount: 0,
      unsupportedProducts: [],
    });
  });

  test('filters device support summary by selected room', () => {
    const snapshot: HejDeviceSnapshot = {
      generatedAt: '2026-05-26T01:00:00.000Z',
      familyCount: 1,
      deviceCount: 2,
      families: [
        {
          family: { familyId: 101, name: '1203' },
          devices: [
            { ...device('light-1', 'LightRgbw5', 'Pendant'), familyId: 101, roomId: 1 },
            { ...device('heater-1', 'UnknownHeater', 'Warm Box'), familyId: 101, roomId: 2 },
          ],
        },
      ],
    };

    const summary = createDeviceSupportSummary(snapshot, {
      mode: 'custom',
      includedFamilyIds: [101],
      includedRoomsByFamilyId: {
        '101': [2],
      },
    });

    expect(summary).toMatchObject({
      registeredCount: 1,
      supportedCount: 0,
      unsupportedCount: 1,
      unsupportedProducts: [
        {
          deviceType: 'UnknownHeater',
          modelName: 'Warm Box',
          count: 1,
        },
      ],
    });
  });

  test('builds a readable Korean support request template with KST dates', () => {
    const template = createUnsupportedDeviceIssueTemplate({
      generatedAt: '2026-05-26T01:00:00.000Z',
      registeredCount: 3,
      supportedCount: 2,
      unsupportedCount: 1,
      unsupportedProducts: [
        {
          deviceType: 'UnknownHeater',
          modelName: 'Warm Box',
          count: 1,
        },
      ],
    });

    expect(template.title).toBe('[Unsupported Device] UnknownHeater / Warm Box');
    expect(template.body).toContain('## 아직 지원하지 않는 Hejhome 제품');
    expect(template.body).toContain('## Home 앱에서 기대하는 동작');
    expect(template.body).toContain('- 등록된 장비 수: 3');
    expect(template.body).toContain('- 장비 목록 생성 시각: 2026-05-26 10:00:00 (KST)');
    expect(template.body).not.toContain('2026-05-26T01:00:00.000Z');
  });
});

function device(id: string, deviceType: string, modelName: string) {
  return {
    id,
    name: modelName,
    deviceType,
    modelName,
    deviceState: {
      power: false,
    },
  };
}
