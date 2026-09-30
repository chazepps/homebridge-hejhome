export type AirPurifierMode = 'auto' | 'manual' | 'sleep';

export function decodeAirPurifierMode(value: unknown): AirPurifierMode | null {
  return value === 'auto' || value === 'manual' || value === 'sleep' ? value : null;
}

export function decodeAirPurifierPower(value: unknown): boolean | null {
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return null;
}

export function encodeAirPurifierMode(value: unknown): { mode: AirPurifierMode } {
  const mode = decodeAirPurifierMode(value);
  if (mode === null) {
    throw new TypeError('Unsupported air purifier mode.');
  }
  return { mode };
}

export function encodePurifierControl(command: unknown): { power: boolean } | { mode: AirPurifierMode } {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('Unsupported air purifier command.');
  }
  const entry = command as Record<string, unknown>;
  const keys = Object.keys(entry);
  if (keys.length === 1 && keys[0] === 'power' && typeof entry.power === 'boolean') {
    return { power: entry.power };
  }
  if (keys.length === 1 && keys[0] === 'mode') {
    return encodeAirPurifierMode(entry.mode);
  }
  throw new TypeError('Unsupported air purifier command.');
}

export function decodePurifierSettings(state: unknown): { power: boolean | null; mode: AirPurifierMode | null } {
  const value = state && typeof state === 'object' && !Array.isArray(state)
    ? state as Record<string, unknown> : {};
  return { power: decodeAirPurifierPower(value.power), mode: decodeAirPurifierMode(value.mode) };
}
