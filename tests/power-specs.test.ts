import { expect, test } from 'vitest';
import { normalizeFeatures } from '../src/features.js';
import { meterClusters } from '../src/matter/metering.js';

test('manual power specs preserve zero, decimals, and independently absent fields by device ID', () => {
  expect(normalizeFeatures({ devices: {
    first: { name: 'First', powerSpec: { activeWatts: 0, standbyWatts: 0.125 } },
    second: { powerSpec: { activeWatts: 45.5 } },
    third: { powerSpec: { standbyWatts: 0 } },
    empty: { powerSpec: {} },
  } }).devices).toEqual({
    first: { name: 'First', powerSpec: { activeWatts: 0, standbyWatts: 0.125 } },
    second: { powerSpec: { activeWatts: 45.5 } },
    third: { powerSpec: { standbyWatts: 0 } },
    empty: {},
  });
});

test.each([-1, NaN, Infinity, -Infinity, '20', '', true, null, [], {}])(
  'manual power specs reject non-finite, negative, or nonnumeric watts: %j', (value) => {
    for (const field of ['activeWatts', 'standbyWatts']) {
      expect(() => normalizeFeatures({ devices: { plug: { powerSpec: { [field]: value } } } })).toThrow();
    }
  },
);

test('manual power specs reject unknown keys and nonobjects without altering measured profiles', () => {
  for (const powerSpec of [{ activeWatts: 10, voltage: 220 }, [], null, 10, '10']) {
    expect(() => normalizeFeatures({ devices: { plug: { powerSpec } } })).toThrow();
  }
  const features = normalizeFeatures({ devices: { plug: { powerSpec: { activeWatts: 100, standbyWatts: 1 } } },
    meters: [{ model: 'Meter', power: { field: 'curPower', multiplier: 0.1 } }] });
  expect(features.meters).toEqual([{ model: 'Meter', power: { field: 'curPower', multiplier: 0.1 } }]);
  expect(meterClusters({ id: 'plug', name: 'Plug', deviceType: 'Plug', modelName: 'Meter',
    deviceState: { curPower: 123 } }, features.meters)).toEqual({ electricalPowerMeasurement: { activePower: 12300 } });
  expect(meterClusters({ id: 'plug', name: 'Plug', deviceType: 'Plug', modelName: 'Other' }, features.meters)).toEqual({});
});
