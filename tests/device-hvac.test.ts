import { describe, expect, test } from 'vitest';
import { encodeHvacControl } from '../src/devices/hvac.js';

describe('vendor web-app HVAC command contract', () => {
  test('maps named modes and fan speeds explicitly to vendor strings', () => {
    for (const [mode, value] of [['cool', '0'], ['heat', '1'], ['auto', '2'], ['fan', '3'], ['dry', '4']] as const) {
      expect(encodeHvacControl({ mode })).toEqual({ mode: value });
    }
    for (const [fanSpeed, value] of [['auto', '0'], ['low', '1'], ['medium', '2'], ['high', '3']] as const) {
      expect(encodeHvacControl({ fanSpeed })).toEqual({ fanSpeed: value });
    }
    expect(encodeHvacControl({ power: false })).toEqual({ power: false });
    expect(encodeHvacControl({ temperature: 16 })).toEqual({ temperature: 16 });
    expect(encodeHvacControl({ temperature: 30 })).toEqual({ temperature: 30 });
  });
  test('rejects unsupported modes, ranges and malformed UI input', () => {
    for (const command of [{ mode: '2' }, { fanSpeed: 3 }, { power: 'on' }, { temperature: 15 },
      { temperature: 31 }, { temperature: 22.5 }, { temperature: NaN }, { swing: true }, { mode: 'cool', power: true }]) {
      expect(() => encodeHvacControl(command as never)).toThrow();
    }
  });
});

test('decodes reported settings without claiming measured temperature or compressor operation', async () => {
  const { decodeHvacSettings } = await import('../src/devices/hvac.js');
  expect(decodeHvacSettings({ power: '꺼짐', temperature: '23', mode: '0', fanSpeed: 3 })).toEqual({
    power: false, targetTemperature: 23, mode: 'cool', fanSpeed: 'high',
  });
  expect(decodeHvacSettings({ power: '켜짐', temperature: 30, mode: 4, fanSpeed: '0' })).toEqual({
    power: true, targetTemperature: 30, mode: 'dry', fanSpeed: 'auto',
  });
  expect(decodeHvacSettings({ power: 'unknown', temperature: null, mode: 99, fanSpeed: true })).toEqual({
    power: null, targetTemperature: null, mode: null, fanSpeed: null,
  });
});

test('requires actual mode strings instead of accepting JavaScript coercion', () => {
  expect(() => encodeHvacControl({ mode: ['cool'] } as never)).toThrow();
  expect(() => encodeHvacControl({ fanSpeed: ['low'] } as never)).toThrow();
});
