/** Vendor LightWw1/2/3 UI: temperature 0..100 corresponds to 3000..6500 K.
 * This contract does not apply to RGBW white mode.
 */
export function whiteTemperaturePercentToMired(value: unknown): number | null {
  const percent = boundedNumber(value, 0, 100);
  return percent === null ? null : Math.round(1_000_000 / (3000 + percent * 35));
}

export function whiteMiredToTemperaturePercent(value: unknown): number | null {
  const mired = boundedNumber(value, 154, 333);
  return mired === null ? null : Math.max(0, Math.min(100, Math.round((1_000_000 / mired - 3000) / 35)));
}

function boundedNumber(value: unknown, min: number, max: number): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= min && number <= max ? number : null;
}
