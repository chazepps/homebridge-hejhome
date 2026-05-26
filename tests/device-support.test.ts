import { describe, expect, test } from 'vitest';

import { createDeviceSupportSummary, SUPPORTED_DEVICE_MODELS } from '../src/utils/deviceSupport.js';
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
            device('heater-1', 'UnknownHeater', 'Warm Box'),
          ],
        },
      ],
    };

    const summary = createDeviceSupportSummary(snapshot);

    expect(summary).toMatchObject({
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
    expect(SUPPORTED_DEVICE_MODELS.map((model) => model.deviceType)).toContain('LightRgbw5');
    expect(SUPPORTED_DEVICE_MODELS.map((model) => model.deviceType)).toContain('RelayController');
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
