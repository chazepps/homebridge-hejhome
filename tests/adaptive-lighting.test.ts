import { describe, expect, test, vi } from 'vitest';
import { AdaptiveLightingSession } from '../src/lighting/adaptive.js';

describe('Adaptive Lighting lifecycle', () => {
  test('external manual temperature changes disable the schedule, matching command echoes do not', () => {
    const controller = { isAdaptiveLightingActive: () => true, disableAdaptiveLighting: vi.fn() };
    const session = new AdaptiveLightingSession(controller);
    session.commanded(40);
    session.observe({ temperature: 40 });
    expect(controller.disableAdaptiveLighting).not.toHaveBeenCalled();
    session.observe({ temperature: 70 });
    expect(controller.disableAdaptiveLighting).toHaveBeenCalledOnce();
  });
  test('unrelated telemetry does not disable lighting and expired echoes are manual', () => {
    vi.useFakeTimers();
    try {
      const controller = { isAdaptiveLightingActive: () => true, disableAdaptiveLighting: vi.fn() };
      const session = new AdaptiveLightingSession(controller);
      session.commanded(40);
      session.observe({ power: true, brightness: 50 });
      vi.advanceTimersByTime(31_000);
      session.observe({ temperature: 40 });
      expect(controller.disableAdaptiveLighting).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
});
