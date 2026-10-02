import type { DevicePreference, MeterProfile } from '../features.js';
import type { HejDevice } from '../types.js';
import { getDeviceCapability } from '../devices/capabilities.js';
import { decodeAirPurifierPower } from '../devices/purifier.js';
import { EstimatedEnergyStore, MAX_ESTIMATED_ENERGY_MWH } from '../storage/estimatedEnergyStore.js';

export const MAX_POWER_ESTIMATE_WATTS = 1_000_000;
export interface EstimatedElectricalState { activePower: number | null; cumulativeEnergyImported: number | null }
export interface PowerEstimateSupport {
  supported: boolean;
  powerField?: string;
  reason: 'supported' | 'multiple-loads' | 'unsupported-device';
}

/** Eligibility describes a native load, independently of whether its current power is known. */
export function powerEstimateSupport(device: HejDevice): PowerEstimateSupport {
  const kind = getDeviceCapability(device.deviceType)?.serviceKind;
  const state = device.deviceState ?? {};
  const numbered = Object.keys(state).filter((key) => /^power\d+$/.test(key));
  if (kind === 'power-strip' || (kind === 'multi-switch' && !['Switch1', 'ZigbeeSwitch1'].includes(device.deviceType))
    || numbered.some((key) => key !== 'power1') || (Object.hasOwn(state, 'power') && numbered.length > 0)) {
    return { supported: false, reason: 'multiple-loads' };
  }
  if (device.deviceType.includes('Dc') || !['color-light', 'white-light', 'outlet', 'relay-switch', 'multi-switch'].includes(kind ?? '')) {
    return { supported: false, reason: 'unsupported-device' };
  }
  const powerField = kind === 'multi-switch'
    || (kind === 'relay-switch' && device.deviceType !== 'Airpurifier' && !Object.hasOwn(state, 'power')) ? 'power1' : 'power';
  return { supported: true, powerField, reason: 'supported' };
}

interface Estimate {
  total: number | null;
  power: number | null;
  anchor: number | null;
  barrier: number;
}

/** Only observe() accepts vendor evidence. Optimistic command snapshots never enter this state. */
export class PowerEstimates {
  private readonly states = new Map<string, Estimate>();
  private owner = '';
  private ready = false;
  private connected = false;
  private revision = 0;
  private globalBarrier = 0;
  private dirty = false;
  private lastPersist = 0;
  private saving: Promise<void> = Promise.resolve();

  constructor(
    private readonly preferences: Record<string, DevicePreference>,
    private readonly meters: MeterProfile[],
    private readonly store: EstimatedEnergyStore,
    private readonly onError: (error: unknown) => void,
    private readonly now: () => number = () => performance.now(),
  ) {}

  async loadAccount(identifier: string): Promise<void> {
    this.ready = false;
    // Account changes invalidate old evidence even if transport was already down.
    this.globalBarrier = ++this.revision;
    this.setConnected(false);
    await this.flush();
    const totals = await this.store.load(identifier);
    this.states.clear();
    for (const [id, total] of Object.entries(totals)) {
      this.states.set(id, { total, power: null, anchor: null, barrier: this.revision });
    }
    this.owner = identifier;
    this.ready = true;
    this.lastPersist = this.now();
  }

  capture(): number {
    return this.revision;
  }

  setConnected(connected: boolean): void {
    if (!connected && this.connected) {
      for (const id of this.states.keys()) {
        this.suspend(id);
      }
      this.globalBarrier = ++this.revision;
    }
    this.connected = connected;
  }

  suspend(id: string): void {
    const state = this.states.get(id) ?? { total: null, power: null, anchor: null, barrier: 0 };
    this.advance(state);
    state.power = null;
    state.anchor = null;
    state.barrier = ++this.revision;
    this.states.set(id, state);
  }

  observe(device: HejDevice, patch: Record<string, unknown>, started = this.capture()): void {
    if (device.online === false) {
      this.suspend(device.id);
      return;
    }
    if (!this.enabled(device)) {
      this.suspend(device.id);
      return;
    }
    if (!this.connected || !this.owner || !this.ready) {
      return;
    }
    const support = powerEstimateSupport(device);
    const state = this.states.get(device.id) ?? { total: null, power: null, anchor: null, barrier: 0 };
    if (started < Math.max(state.barrier, this.globalBarrier) || !Object.hasOwn(patch, support.powerField!)) {
      return;
    }
    this.advance(state);
    state.barrier = ++this.revision;
    const raw = patch[support.powerField!];
    const power = device.deviceType === 'Airpurifier' ? decodeAirPurifierPower(raw) : typeof raw === 'boolean' ? raw : undefined;
    const watts = power == null ? undefined : this.preferences[device.id]?.powerSpec?.[power ? 'activeWatts' : 'standbyWatts'];
    state.power = typeof watts === 'number' && Number.isFinite(watts) && watts >= 0 && watts <= MAX_POWER_ESTIMATE_WATTS
      ? Math.round(watts * 1000) : null;
    state.anchor = state.power === null ? null : this.now();
    if (state.power !== null && state.total === null) {
      state.total = 0;
      this.dirty = true;
    }
    this.states.set(device.id, state);
  }

  retain(ids: Set<string>): void {
    for (const id of this.states.keys()) {
      if (!ids.has(id)) {
        this.suspend(id);
      }
    }
  }

  tick(): void {
    for (const state of this.states.values()) {
      this.advance(state);
    }
    const now = this.now();
    if (this.dirty && now - this.lastPersist >= 60000) {
      this.lastPersist = now;
      void this.flush().catch(this.onError);
    }
  }

  project(device: HejDevice): EstimatedElectricalState | undefined {
    if (!this.enabled(device)) {
      return undefined;
    }
    const state = this.ready ? this.states.get(device.id) : undefined;
    return { activePower: this.connected && device.online !== false ? state?.power ?? null : null,
      cumulativeEnergyImported: state?.total == null ? null : Math.floor(state.total + 1e-7) };
  }

  async flush(): Promise<void> {
    if (this.dirty && this.owner) {
      const owner = this.owner;
      const totals = Object.fromEntries([...this.states].filter(([, value]) => value.total !== null).map(([id, value]) => [id, value.total!]));
      this.dirty = false;
      this.saving = this.store.save(owner, totals).catch((error) => {
        if (this.owner === owner) {
          this.dirty = true;
        }
        throw error;
      });
    }
    await this.saving;
  }

  private enabled(device: HejDevice): boolean {
    const profile = this.meters.find((entry) => entry.model === device.modelName);
    const spec = this.preferences[device.id]?.powerSpec;
    return powerEstimateSupport(device).supported && !!spec && Object.keys(spec).length > 0 && !profile?.power && !profile?.energy;
  }

  private advance(state: Estimate): void {
    if (state.anchor === null || state.power === null || state.total === null) {
      return;
    }
    const now = this.now();
    const elapsed = now - state.anchor;
    // The 2 s observer must keep running. A stalled process cannot attest a long gap.
    if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed > 10000) {
      state.anchor = null;
      state.power = null;
      return;
    }
    state.anchor = now;
    const next = Math.min(MAX_ESTIMATED_ENERGY_MWH, state.total + state.power * elapsed / 3600000);
    if (next !== state.total) {
      state.total = next;
      this.dirty = true;
    }
  }
}
