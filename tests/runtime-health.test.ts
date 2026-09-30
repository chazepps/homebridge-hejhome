import { expect, test } from 'vitest';
import { RuntimeHealth } from '../src/runtime/health.js';

test('periodic measurements expire independently while quiet event sensors stay reachable', () => {
  let now = 1_000;
  const health = new RuntimeHealth(() => now);
  health.observe({ id: 'th', name: 'TH', deviceType: 'SensorTh', online: true, deviceState: { temperature: 20, humidity: 40 } }, 'realtime');
  health.observe({ id: 'door', name: 'Door', deviceType: 'SensorDo', online: true, deviceState: { doorOpened: false } }, 'realtime');
  now += 23 * 3600000;
  health.observe({ id: 'th', name: 'TH', deviceType: 'SensorTh', deviceState: { humidity: 41 } }, 'realtime');
  now += 2 * 3600000;
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
  health.observe(device, 'realtime'); now += 25 * 3600000;
  health.observe(device, 'snapshot');
  expect(health.measurement('th', 'temperature').reason).toBe('measurement-stale');
});
