import type { AdaptiveLightingController } from 'homebridge';
import type { HejDeviceState } from '../types.js';

export class AdaptiveLightingSession {
  private readonly expected = new Map<number, number>();
  constructor(private readonly controller: Pick<AdaptiveLightingController, 'isAdaptiveLightingActive' | 'disableAdaptiveLighting'>) {}

  commanded(temperature: number): void {
    this.prune();
    this.expected.set(temperature, Date.now() + 30_000);
  }

  observe(patch: HejDeviceState): void {
    this.prune();
    if (!this.controller.isAdaptiveLightingActive()) {
      return;
    }
    const mode = typeof patch.lightMode === 'string' ? patch.lightMode.toUpperCase() : '';
    const manualColor = ['COLOR', 'COLOUR', 'SCENE'].includes(mode);
    const temperature = typeof patch.temperature === 'number' || (typeof patch.temperature === 'string' && patch.temperature.trim() !== '')
      ? Number(patch.temperature) : NaN;
    const changedTemperature = Number.isFinite(temperature) && temperature >= 0 && temperature <= 100 && !this.expected.has(temperature);
    // Stored HSV and scene recipe values can be reported while WHITE remains active. They are not a mode change.
    if (manualColor || changedTemperature) {
      this.controller.disableAdaptiveLighting();
    }
  }

  private prune(): void {
    for (const [value, expires] of this.expected) {
      if (expires < Date.now()) {
        this.expected.delete(value);
      }
    }
  }
}
