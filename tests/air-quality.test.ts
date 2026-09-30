import { expect, test } from 'vitest';

test('calibrates only explicitly configured PM2.5 values into micrograms per cubic metre', async () => {
  const { calibratePm25 } = await import('../src/devices/airQuality.js');
  expect(calibratePm25('12.5', 2)).toBe(25);
  expect(calibratePm25(0, 1)).toBe(0);
  expect(calibratePm25(1000, 1)).toBe(1000);
});

test('leaves missing, invalid, and out-of-range PM2.5 unknown', async () => {
  const { calibratePm25 } = await import('../src/devices/airQuality.js');
  for (const [raw, multiplier] of [[12, undefined], [12, 0], [12, -1], [12, Infinity],
    [null, 1], ['', 1], ['invalid', 1], [-1, 1], [1001, 1], [Number.NaN, 1]]) {
    expect(calibratePm25(raw, multiplier)).toBeNull();
  }
});
