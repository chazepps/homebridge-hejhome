/** Returns calibrated PM2.5 in µg/m³ only when the user supplied a valid conversion. */
export function calibratePm25(raw: unknown, multiplier: unknown): number | null {
  if (typeof multiplier !== 'number' || !Number.isFinite(multiplier) || multiplier <= 0) {
    return null;
  }
  if (typeof raw !== 'number' && (typeof raw !== 'string' || raw.trim() === '')) {
    return null;
  }
  const value = Number(raw);
  const calibrated = value * multiplier;
  return Number.isFinite(value) && value >= 0 && Number.isFinite(calibrated)
    && calibrated >= 0 && calibrated <= 1000 ? calibrated : null;
}
