import { expect, test } from 'vitest';
import { StateObservations } from '../src/runtime/observations.js';

test('a newer nested hue observation protects hue without suppressing other requested color fields', () => {
  const observations = new StateObservations();
  const before = observations.capture('rgb');
  observations.record('rgb', { hsvColor: { hue: 80 } });
  const result = observations.commit('rgb', { id: 'rgb', name: 'RGB', deviceType: 'LightRgbw5',
    deviceState: { hsvColor: { hue: 80, saturation: 20, brightness: 50 } } },
  { hsvColor: { hue: 30, saturation: 60, brightness: 25 } }, before);
  expect(result.conflicted).toBe(true);
  expect(result.device.deviceState).toMatchObject({ hsvColor: { hue: 80, saturation: 60, brightness: 25 }, brightness: 25 });
});

test('explicit unknown observations cannot become a fabricated command value after a slow acknowledgement', () => {
  const observations = new StateObservations();
  const before = observations.capture('light');
  observations.record('light', { brightness: null });
  const result = observations.commit('light', { id: 'light', name: 'Light', deviceType: 'LightWw1', deviceState: {} },
    { brightness: 25 }, before);
  expect(result.conflicted).toBe(true);
  expect(result.device.deviceState).not.toHaveProperty('brightness');
});
