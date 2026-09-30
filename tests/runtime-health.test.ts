import { expect, test } from 'vitest';
import { RuntimeHealth, measurementFreshnessMs } from '../src/runtime/health.js';

test('periodic measurements expire independently while quiet event sensors stay reachable', () => {
  let now = 1_000;
  const health = new RuntimeHealth(() => now);
  health.observe({ id: 'th', name: 'TH', deviceType: 'SensorTh', online: true, deviceState: { temperature: 20, humidity: 40 } }, 'realtime');
  health.observe({ id: 'door', name: 'Door', deviceType: 'SensorDo', online: true, deviceState: { doorOpened: false } }, 'realtime');
  now += 89 * 60000;
  health.observe({ id: 'th', name: 'TH', deviceType: 'SensorTh', deviceState: { humidity: 41 } }, 'realtime');
  now += 2 * 60000;
  expect(health.measurement('th', 'temperature')).toMatchObject({ reachable: false, reason: 'measurement-stale' });
  expect(health.measurement('th', 'humidity').reachable).toBe(true);
  expect(health.device('door').reachable).toBe(true);
  expect(health.measurement('door', 'doorOpened').reachable).toBe(true);
});
test('REST snapshots do not assert a new measurement time or refresh old MQTT measurements', () => {
  let now = 1_000; const health = new RuntimeHealth(() => now);
  const device = { id: 'th', name: 'TH', deviceType: 'SensorTh', online: true, deviceState: { temperature: 20 } };
  health.observe(device, 'snapshot');
  expect(health.measurement('th', 'temperature').reason).toBe('measurement-unknown');
  health.observe(device, 'realtime'); now += 91 * 60000;
  health.observe(device, 'snapshot');
  expect(health.measurement('th', 'temperature').reason).toBe('measurement-stale');
});


test('temperature families have a 90-minute local validity window, with independent fields at the boundary', () => {
  let now = 0; const health = new RuntimeHealth(() => now);
  for (const deviceType of ['SensorTh', 'SensorTh2', 'SensorRefTh', 'SensorRefTh2']) {
    health.observe({ id: deviceType, name: deviceType, deviceType, deviceState: { temperature: 20, humidity: 45 } }, 'realtime');
  }
  now = 90 * 60000 - 1;
  expect(health.measurement('SensorTh', 'temperature').reachable).toBe(true);
  now++;
  for (const type of ['SensorTh', 'SensorTh2', 'SensorRefTh', 'SensorRefTh2']) {
    expect(health.measurement(type, 'temperature').reason).toBe('measurement-stale');
    expect(health.device(type).reachable).toBe(true);
  }
});

test('matching calibrated meter source fields expire even without cur-prefixed names', () => {
  let now = 0;
  const health = new RuntimeHealth(() => now, { meters: [{ model: 'calibrated', power: { field: 'watts', multiplier: 1 },
    energy: { field: 'totalWh', multiplier: 1 } }] });
  health.observe({ id: 'plug', name: 'Plug', deviceType: 'Plug', modelName: 'calibrated', deviceState: { watts: 5, totalWh: 42 } }, 'realtime');
  now = 300000;
  expect(health.measurement('plug', 'watts').reason).toBe('measurement-stale');
  expect(health.measurement('plug', 'totalWh').reason).toBe('measurement-stale');
});

test('a device override changes only continuous measurements, never event sensors or light setpoints', () => {
  let now = 0;
  const health = new RuntimeHealth(() => now, { meters: [], devices: {
    th: { freshnessMinutes: 120 }, door: { freshnessMinutes: 5 }, light: { freshnessMinutes: 5 },
  } });
  health.observe({ id: 'th', name: 'TH', deviceType: 'SensorTh', deviceState: { temperature: 20 } }, 'realtime');
  health.observe({ id: 'door', name: 'Door', deviceType: 'SensorDo', deviceState: { doorOpened: false, battery: 70 } }, 'realtime');
  health.observe({ id: 'light', name: 'Light', deviceType: 'LightWw1', deviceState: { temperature: 30 } }, 'snapshot');
  now = 100 * 60000;
  expect(health.measurement('th', 'temperature').reachable).toBe(true);
  expect(health.measurement('door', 'doorOpened').reachable).toBe(true);
  expect(health.measurement('door', 'battery').reachable).toBe(true);
  expect(health.measurement('light', 'temperature').reachable).toBe(true);
  now = 120 * 60000;
  expect(health.measurement('th', 'temperature').reason).toBe('measurement-stale');
});

const invalidSamples = [null, undefined, '', 'not-a-reading', false, NaN, Infinity];
test.each(invalidSamples)('invalid report %s invalidates the old timestamp so REST cannot resurrect freshness', (invalid) => {
  let now = 1000; const health = new RuntimeHealth(() => now);
  const base = { id: 'th', name: 'TH', deviceType: 'SensorTh' };
  health.observe({ ...base, deviceState: { temperature: 20 } }, 'realtime');
  now++;
  health.observe({ ...base, deviceState: { temperature: invalid } } as never, 'realtime');
  expect(health.measurement('th', 'temperature').reason).toBe('measurement-unknown');
  health.observe({ ...base, deviceState: { temperature: 25 } }, 'snapshot');
  expect(health.measurement('th', 'temperature').reason).toBe('measurement-unknown');
  health.observe({ ...base, deviceState: { temperature: 26 } }, 'realtime');
  expect(health.measurement('th', 'temperature').reachable).toBe(true);
});

test('battery-only messages do not refresh environmental samples, and event sensors do not expire through silence', () => {
  let now = 0; const health = new RuntimeHealth(() => now);
  health.observe({ id: 'th', name: 'TH', deviceType: 'SensorTh', deviceState: { temperature: 20, battery: 60 } }, 'realtime');
  for (const deviceType of ['SensorMo', 'SensorRadar', 'SensorDo', 'SensorWater2', 'SensorSmoke3']) {
    health.observe({ id: deviceType, name: deviceType, deviceType, deviceState: { motionDetected: false, doorOpened: false, alarm: false } }, 'realtime');
  }
  now = 89 * 60000;
  health.observe({ id: 'th', name: 'TH', deviceType: 'SensorTh', deviceState: { battery: 59 } }, 'realtime');
  now = 90 * 60000;
  expect(health.measurement('th', 'temperature').reason).toBe('measurement-stale');
  now = 365 * 86400000;
  for (const deviceType of ['SensorMo', 'SensorRadar', 'SensorDo', 'SensorWater2', 'SensorSmoke3']) {
    expect(health.device(deviceType).reachable).toBe(true);
    expect(health.measurement(deviceType, 'alarm').reachable).toBe(true);
  }
});

test('a backwards local clock invalidates the measurement until a new real report arrives', () => {
  let now = 1000; const health = new RuntimeHealth(() => now);
  const device = { id: 'th', name: 'TH', deviceType: 'SensorTh', deviceState: { temperature: 20 } };
  health.observe(device, 'realtime'); now = 900;
  expect(health.measurement('th', 'temperature').reason).toBe('measurement-unknown');
  now = 1100; health.observe(device, 'snapshot');
  expect(health.measurement('th', 'temperature').reason).toBe('measurement-unknown');
  health.observe(device, 'realtime');
  expect(health.measurement('th', 'temperature').reachable).toBe(true);
});


test('legacy meter bindings cannot reclassify actuator or event fields as periodic measurements', () => {
  let now = 0;
  for (const [field, value] of [['power', true], ['power1', false], ['brightness', 50], ['battery', 75], ['motionDetected', false],
    ['doorOpened', false], ['alarm', false], ['lightMode', 'WHITE'], ['fanSpeed', 2]] as const) {
    const device = { id: 'reserved', name: 'Device', deviceType: 'Plug', modelName: 'reserved-model', deviceState: { [field]: value } };
    const features = { meters: [{ model: 'reserved-model', power: { field, multiplier: 1 } }] };
    const health = new RuntimeHealth(() => now, features);
    health.observe(device, 'realtime'); now += 86400000;
    expect(measurementFreshnessMs(device, field, features)).toBeNull();
    expect(health.measurement(device.id, field).reachable).toBe(true);
  }
});

test('environmental field roles take precedence over an invalid meter profile mapping', () => {
  const device = { id: 'th', name: 'TH', deviceType: 'SensorTh', modelName: 'model' };
  const features = { meters: [{ model: 'model', power: { field: 'temperature', multiplier: 1 } }] };
  expect(measurementFreshnessMs(device, 'temperature', features)).toBe(90 * 60000);
});
