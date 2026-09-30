import { expect, test } from 'vitest';
import { whiteMiredToTemperaturePercent, whiteTemperaturePercentToMired } from '../src/lighting/temperature.js';

test('maps the documented LightWw 3000–6500 K range in both directions', () => {
  expect(whiteTemperaturePercentToMired(0)).toBe(333);
  expect(whiteTemperaturePercentToMired(100)).toBe(154);
  expect(whiteMiredToTemperaturePercent(333)).toBe(0);
  expect(whiteMiredToTemperaturePercent(154)).toBe(100);
  for (let percent = 0; percent <= 100; percent++) {
    const mired = whiteTemperaturePercentToMired(percent)!;
    expect(Math.abs(whiteMiredToTemperaturePercent(mired)! - percent)).toBeLessThanOrEqual(1);
  }
});

test('missing and invalid temperatures remain unknown instead of clipping into supported values', () => {
  for (const value of [undefined, null, true, '', {}, NaN, Infinity, -1, 101]) {
    expect(whiteTemperaturePercentToMired(value)).toBeNull();
  }
  for (const value of [undefined, null, true, '', {}, NaN, Infinity, 153, 334]) {
    expect(whiteMiredToTemperaturePercent(value)).toBeNull();
  }
});
