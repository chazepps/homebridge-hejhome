import { describe, expect, test } from 'vitest';

describe('evidenced non-IR air purifier control', () => {
  test('accepts exactly one known power or mode command', async () => {
    const { encodePurifierControl } = await import('../src/devices/purifier.js');
    expect(encodePurifierControl({ power: true })).toEqual({ power: true });
    expect(encodePurifierControl({ power: false })).toEqual({ power: false });
    for (const mode of ['auto', 'manual', 'sleep']) {
      expect(encodePurifierControl({ mode })).toEqual({ mode });
    }
    for (const invalid of [undefined, {}, { power: 'true' }, { mode: 'turbo' },
      { power: true, mode: 'auto' }, { mode: 'auto', filterReset: true }]) {
      expect(() => encodePurifierControl(invalid)).toThrow(TypeError);
    }
  });

  test('keeps unknown REST power and mode distinct from off or auto', async () => {
    const { decodePurifierSettings } = await import('../src/devices/purifier.js');
    expect(decodePurifierSettings({ power: true, mode: 'manual' })).toEqual({ power: true, mode: 'manual' });
    expect(decodePurifierSettings({ power: 'false', mode: 'sleep' })).toEqual({ power: false, mode: 'sleep' });
    expect(decodePurifierSettings({ power: 'true', mode: 'auto' })).toEqual({ power: true, mode: 'auto' });
    expect(decodePurifierSettings({ power: 0, mode: 'turbo' })).toEqual({ power: null, mode: null });
    expect(decodePurifierSettings(null)).toEqual({ power: null, mode: null });
  });

  test('offers the same strict mode encoder to the settings UI', async () => {
    const { encodeAirPurifierMode } = await import('../src/devices/purifier.js');
    expect(encodeAirPurifierMode('auto')).toEqual({ mode: 'auto' });
    expect(() => encodeAirPurifierMode('turbo')).toThrow(TypeError);
  });
});
