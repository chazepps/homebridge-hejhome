import type { MatterAPI, MatterAccessory } from 'homebridge';
import type { DevicePreference, MeterProfile } from '../features.js';
import type { HejDevice } from '../types.js';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings.js';
import { createMatterAccessory, MatterDimmingController } from './accessory.js';

export class MatterAdapter {
  private readonly accessories = new Map<string, MatterAccessory>();
  private readonly active = new Set<string>();
  private readonly devices = new Map<string, HejDevice>();
  private readonly reported = new Map<string, { data: string; at: number }>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly dimmers = new Map<string, MatterDimmingController>();
  private queue = Promise.resolve();
  private disposed = false;

  constructor(
    private readonly api: MatterAPI,
    private readonly send: (deviceId: string, requirements: Record<string, unknown>) => Promise<void>,
    private readonly meters: MeterProfile[],
    private readonly onError: (error: unknown) => void,
    private readonly devicePreferences: Record<string, DevicePreference> = {},
  ) {}

  restore(accessory: MatterAccessory): void {
    this.accessories.set(accessory.UUID, accessory);
  }

  async pruneHidden(isVisible: (deviceId: string | undefined) => boolean): Promise<void> {
    if (this.disposed) {
      return;
    }
    for (const [uuid, accessory] of this.accessories) {
      const id = cachedDeviceId(accessory);
      if (isVisible(id)) {
        // A restored endpoint has no freshly verified device state yet.
        try {
          await this.api.updateAccessoryState(uuid, 'bridgedDeviceBasicInformation', { reachable: false });
        } catch (error) {
          this.onError(error);
        }
        continue;
      }
      await this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      this.accessories.delete(uuid);
      this.active.delete(uuid);
      for (const key of this.reported.keys()) {
        if (key.startsWith(`${uuid}/`)) {
          this.reported.delete(key);
        }
      }
      for (const [key, timer] of this.timers) {
        if (key.startsWith(`${uuid}/`)) {
          clearTimeout(timer);
          this.timers.delete(key);
        }
      }
      if (id && ![...this.accessories.values()].some((other) => cachedDeviceId(other) === id)) {
        this.devices.delete(id);
        this.dimmers.get(id)?.cancel(true);
        this.dimmers.delete(id);
      }
    }
  }

  hasDevice(id: string): boolean {
    const uuid = this.api.uuid.generate(`hejhome:matter:${id}`);
    return !this.disposed && this.active.has(uuid);
  }

  async reconcile(devices: HejDevice[]): Promise<void> {
    this.reported.clear();
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    const retained = new Set<string>();
    for (const device of devices) {
      if (this.disposed) {
        return;
      }
      this.devices.set(device.id, device);
      const accessory = this.build(device.id);
      if (!accessory) {
        continue;
      }
      retained.add(accessory.UUID);
      const restored = this.accessories.get(accessory.UUID);
      if (restored && !this.active.has(accessory.UUID)
        && accessory.parts?.some((part) => part.id === 'air-quality')
        && restored.parts?.some((part) => part.id === 'air-quality')) {
        // Homebridge's cached part type contains only name/code. Its restore compares
        // parent behavior keys and part IDs, so an optional PM2.5 behavior is lost
        // unless a fresh discovery replaces that cached endpoint via public APIs.
        const pmState = await this.api.getAccessoryState?.(accessory.UUID, 'pm25ConcentrationMeasurement', 'air-quality');
        if (pmState === undefined) {
          await this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [restored]);
          this.accessories.delete(accessory.UUID);
        }
      }
      if (this.active.has(accessory.UUID)) {
        await this.api.updatePlatformAccessories([accessory]);
      } else {
        await this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
      this.active.add(accessory.UUID);
      this.accessories.set(accessory.UUID, accessory);
      await this.update(device);
    }
    for (const [uuid, accessory] of this.accessories) {
      if (!retained.has(uuid)) {
        await this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
        this.active.delete(uuid);
      }
    }
    const activeIds = new Set(devices.map((d) => d.id));
    for (const id of this.devices.keys()) {
      if (!activeIds.has(id)) {
        this.devices.delete(id);
        this.dimmers.get(id)?.cancel(true);
        this.dimmers.delete(id);
      }
    }
  }

  // Commands update the shared device snapshot, but the host commits their cluster state.
  accept(device: HejDevice): void {
    this.devices.set(device.id, device);
    // The host commits command results independently of our external-report cache.
    // Invalidate actuators so a later reversal is not mistaken for an old duplicate.
    // Leave metering timestamps intact: switching must not bypass the energy cadence.
    const uuid = this.api.uuid.generate(`hejhome:matter:${device.id}`);
    for (const key of this.reported.keys()) {
      if (key.startsWith(`${uuid}/`) && /\/(onOff|levelControl|colorControl|windowCovering)$/.test(key)) {
        this.reported.delete(key);
      }
    }
  }

  update(device: HejDevice): Promise<void> {
    const previous = this.devices.get(device.id);
    const dimmer = this.dimmers.get(device.id);
    if (dimmer && previous && lightControlChanged(previous, device, dimmer)) {
      dimmer.cancel(true);
    }
    this.devices.set(device.id, device);
    this.queue = this.queue.catch(this.onError).then(async () => {
      if (this.disposed) {
        return;
      }
      const accessory = this.build(device.id);
      if (!accessory || !this.accessories.has(accessory.UUID)) {
        return;
      }
      await this.report(accessory.UUID, accessory.clusters ?? {});
      for (const part of accessory.parts ?? []) {
        await this.report(accessory.UUID, part.clusters, part.id);
      }
    });
    return this.queue;
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.devices.clear();
    this.reported.clear();
    for (const dimmer of this.dimmers.values()) {
      dimmer.cancel(true);
    }
    this.dimmers.clear();
  }

  private build(id: string): MatterAccessory | null {
    const device = this.devices.get(id);
    if (!device) {
      return null;
    }
    let dimmer = this.dimmers.get(id);
    if (!dimmer) {
      dimmer = new MatterDimmingController(this.onError);
      this.dimmers.set(id, dimmer);
    }
    return createMatterAccessory(this.api, () => this.devices.get(id) ?? device, async (requirements) => {
      if (this.disposed) {
        throw new Error('Hejhome bridge is shutting down.');
      }
      await this.send(id, requirements);
    }, this.meters, dimmer, this.devicePreferences[id]?.pm25Multiplier);
  }

  private async report(uuid: string, clusters: Record<string, Record<string, unknown>>, partId?: string): Promise<void> {
    for (const [cluster, attributes] of Object.entries(clusters)) {
      const key = `${uuid}/${partId ?? ''}/${cluster}`;
      const data = JSON.stringify(attributes);
      const previous = this.reported.get(key);
      if (previous?.data === data) {
        continue;
      }
      if (cluster === 'electricalEnergyMeasurement' && previous && Date.now() - previous.at < 60_000) {
        if (!this.timers.has(key)) {
          const timer = setTimeout(() => {
            this.timers.delete(key);
            const id = this.accessories.get(uuid)?.context.deviceId;
            const device = typeof id === 'string' ? this.devices.get(id) : undefined;
            if (device && !this.disposed) {
              void this.update(device).catch(this.onError);
            }
          }, 60_000 - (Date.now() - previous.at));
          timer.unref?.();
          this.timers.set(key, timer);
        }
        continue;
      }
      await this.api.updateAccessoryState(uuid, cluster, attributes, partId);
      this.reported.set(key, { data, at: Date.now() });
    }
  }
}

function cachedDeviceId(accessory: MatterAccessory): string | undefined {
  const contextId = accessory.context?.deviceId;
  if (typeof contextId === 'string' && contextId.trim()) {
    return contextId;
  }
  return typeof accessory.serialNumber === 'string' && accessory.serialNumber.trim() ? accessory.serialNumber : undefined;
}

function lightControlChanged(previous: HejDevice, next: HejDevice, dimmer: MatterDimmingController): boolean {
  if (next.online === false || previous.deviceType !== next.deviceType) {
    return true;
  }
  const before = previous.deviceState ?? {};
  const after = next.deviceState ?? {};
  const mode = (value: unknown) => value === 'COLOR' || value === 'COLOUR' || value === 'colour' ? 'COLOR' : value;
  if (before.power !== after.power || mode(before.lightMode) !== mode(after.lightMode)
    || before.temperature !== after.temperature
    || before.hsvColor?.hue !== after.hsvColor?.hue
    || before.hsvColor?.saturation !== after.hsvColor?.saturation) {
    return true;
  }
  for (const [oldValue, newValue] of [
    [before.brightness, after.brightness],
    [before.hsvColor?.brightness, after.hsvColor?.brightness],
  ]) {
    if (oldValue !== newValue && !dimmer.expectsBrightness(newValue)) {
      return true;
    }
  }
  return false;
}
