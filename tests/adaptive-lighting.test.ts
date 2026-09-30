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

test('external color or scene selection ends Adaptive Lighting but brightness and white echo do not', () => {
  for (const patch of [{ lightMode: 'COLOUR' }, { lightMode: 'SCENE' }]) {
    const controller = { isAdaptiveLightingActive: () => true, disableAdaptiveLighting: vi.fn() };
    const session = new AdaptiveLightingSession(controller);
    session.observe(patch as never);
    expect(controller.disableAdaptiveLighting).toHaveBeenCalledOnce();
  }
  const controller = { isAdaptiveLightingActive: () => true, disableAdaptiveLighting: vi.fn() };
  const session = new AdaptiveLightingSession(controller);
  session.commanded(40);
  session.observe({ brightness: 30, lightMode: 'WHITE', temperature: 40 });
  expect(controller.disableAdaptiveLighting).not.toHaveBeenCalled();
});

test('stored inactive color and scene reports do not cancel a white lighting schedule', () => {
  const controller = { isAdaptiveLightingActive: () => true, disableAdaptiveLighting: vi.fn() };
  const session = new AdaptiveLightingSession(controller);
  session.observe({ lightMode: 'WHITE', sceneValues: 'stored-recipe', hsvColor: { hue: 120, saturation: 80, brightness: 20 } });
  session.observe({ sceneValues: 'stored-recipe' });
  session.observe({ hsvColor: { hue: 120, saturation: 80, brightness: 20 } });
  session.observe({ temperature: null } as never);
  expect(controller.disableAdaptiveLighting).not.toHaveBeenCalled();
});
