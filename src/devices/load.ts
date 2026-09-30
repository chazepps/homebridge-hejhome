import type { MeterSource } from '../features.js';

/** Calibrated watts only. Thresholds are local load policy, not vendor capabilities. */
export class OutletLoadTracker {
  private value: boolean | null = null;
  private observedAt: number | null = null;
  private pending: { value: boolean; since: number } | null = null;

  constructor(private readonly source: MeterSource, private readonly freshnessMs = 300000) {}

  observe(patch: Record<string, unknown>, now = Date.now()): void {
    if (!(this.source.field in patch)) {
      return;
    }
    if (this.observedAt !== null && (now < this.observedAt || now - this.observedAt >= this.freshnessMs)) {
      this.value = null;
      this.pending = null;
    }
    const raw = patch[this.source.field];
    const watts = (typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== ''))
      ? Number(raw) * this.source.multiplier : NaN;
    this.observedAt = now;
    if (!Number.isFinite(watts) || watts < 0) {
      this.value = null;
      this.pending = null;
      return;
    }
    const next = watts >= 1 ? true : watts <= 0.5 ? false : this.value;
    if (this.value === null) {
      this.value = next;
      this.pending = null;
    } else if (next === this.value) {
      this.pending = null;
    } else if (this.pending?.value !== next) {
      this.pending = next === null ? null : { value: next, since: now };
    } else if (now - this.pending.since >= 2000) {
      this.value = next;
      this.pending = null;
    }
  }

  invalidate(): void {
    this.value = null;
    this.observedAt = null;
    this.pending = null;
  }

  read(now = Date.now()): boolean | null {
    return this.observedAt === null || (now < this.observedAt || now - this.observedAt >= this.freshnessMs) ? null : this.value;
  }
}
