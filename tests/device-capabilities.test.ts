import { describe, expect, test } from 'vitest';

import {
  EXAMPLE_DEVICE_TYPES,
  getDeviceCapability,
  getSupportedDeviceModels,
} from '../src/devices/capabilities.js';

describe('device capability registry', () => {
  test('classifies every example device type without exposing unknown behavior as supported', () => {
    const unclassified = EXAMPLE_DEVICE_TYPES.filter((deviceType) => !getDeviceCapability(deviceType));

    expect(unclassified).toEqual([]);
    expect(getDeviceCapability('IrDvd')?.supportStatus).toBe('partial');
    expect(getDeviceCapability('SensorGas2')?.supportStatus).toBe('partial');
    expect(getDeviceCapability('HomeCameraPro')?.supportStatus).toBe('deferred');
  });

  test('describes HomeKit services and Korean labels for supported device families', () => {
    expect(getDeviceCapability('LightWw3')).toMatchObject({
      label: '색온도 조명',
      serviceKind: 'white-light',
      supportStatus: 'supported',
      homeKitServices: ['Lightbulb'],
    });
    expect(getDeviceCapability('Switch4')).toMatchObject({
      serviceKind: 'multi-switch',
      supportStatus: 'supported',
    });
    expect(getDeviceCapability('SensorTh2')).toMatchObject({
      serviceKind: 'temperature-humidity-sensor',
      supportStatus: 'supported',
      homeKitServices: ['TemperatureSensor', 'HumiditySensor', 'BatteryService'],
    });
    expect(getDeviceCapability('Curtain')).toMatchObject({
      serviceKind: 'window-covering',
      supportStatus: 'supported',
      homeKitServices: ['WindowCovering'],
    });
  });

  test('returns UI models with support statuses for supported, partial, and deferred devices', () => {
    const models = getSupportedDeviceModels();

    expect(models).toEqual(expect.arrayContaining([
      expect.objectContaining({ deviceType: 'LightRgbw5', supportStatus: 'supported' }),
      expect.objectContaining({ deviceType: 'IrTv', supportStatus: 'partial' }),
      expect.objectContaining({ deviceType: 'HomeCamera', supportStatus: 'deferred' }),
    ]));
  });
});
