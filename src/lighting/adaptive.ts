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
    if (patch.temperature !== undefined && !this.expected.has(Number(patch.temperature))) {
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
