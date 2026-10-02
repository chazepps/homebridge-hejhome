const HINT_TTL_MS = 300000;
const HINT_SCAN_INTERVAL_MS = 30000;
const MAX_PENDING = 256;
const MAX_SUPPRESSED = 1024;

/** Realtime IDs request an inventory check; they never establish device ownership. */
export class RealtimeDiscoveryHints {
  private readonly pending = new Map<string, number>();
  private readonly suppressed = new Map<string, number>();
  private lastScanAt = 0;

  add(id: string): boolean {
    const now = Date.now();
    this.expire(now);
    if (this.pending.has(id) || this.suppressed.has(id)) {
      return false;
    }
    // Keep admitting new identities even if a noisy account exhausts the bound.
    if (this.pending.size >= MAX_PENDING) {
      this.pending.delete(this.pending.keys().next().value!);
    }
    this.pending.set(id, now + HINT_TTL_MS);
    return true;
  }

  get hasPending(): boolean {
    this.expire(Date.now());
    return this.pending.size > 0;
  }

  get nextScanAt(): number {
    return this.lastScanAt + HINT_SCAN_INTERVAL_MS;
  }

  beginPass(): number {
    const now = Date.now();
    this.expire(now);
    const count = this.pending.size;
    for (const id of this.pending.keys()) {
      if (this.suppressed.size >= MAX_SUPPRESSED) {
        this.suppressed.delete(this.suppressed.keys().next().value!);
      }
      this.suppressed.set(id, now + HINT_TTL_MS);
    }
    this.pending.clear();
    if (count) {
      this.lastScanAt = now;
    }
    return count;
  }

  confirm(ids: Set<string>): void {
    for (const id of ids) {
      this.pending.delete(id);
      this.suppressed.delete(id);
    }
  }

  clear(): void {
    this.pending.clear();
    this.suppressed.clear();
    this.lastScanAt = 0;
  }

  private expire(now: number): void {
    for (const entries of [this.pending, this.suppressed]) {
      for (const [id, until] of entries) {
        if (until <= now) {
          entries.delete(id);
        }
      }
    }
  }
}
