import type { API, Characteristic, DynamicPlatformPlugin, Logging, MatterAccessory, PlatformAccessory, Service } from 'homebridge';

import { HejRestClient } from './hej/rest.js';
import { HejRealtimeClient } from './hej/realtime.js';
import { HejhomePlatformAccessory, mergeDeviceState } from './platformAccessory.js';
import { resolveDiscoveryScope } from './discovery/scope.js';
import { DeviceSnapshotStore } from './storage/deviceSnapshotStore.js';
import { LogStore, type LogLevel } from './storage/logStore.js';
import { SessionStore, sessionFingerprint } from './storage/sessionStore.js';
import type { HejDevice, HejFamily, HejhomePlatformConfig, HejSession } from './types.js';
import { sanitizeForLog } from './utils/redact.js';
import { createSessionLogContext } from './utils/sessionDiagnostics.js';
import { StateObservations } from './runtime/observations.js';
import { PowerEstimates } from './runtime/powerEstimates.js';
import { EstimatedEnergyStore, estimatedEnergyOwner } from './storage/estimatedEnergyStore.js';
import { RuntimeCommandServer, type RuntimeCommandRequest } from './runtime/commands.js';
import { createIrRemoteRequirements } from './media/irRemoteCommands.js';
import { getDeviceCapability } from './devices/capabilities.js';
import { isMomentaryPowerDevice } from './devices/power.js';
import { encodePurifierControl, decodePurifierSettings } from './devices/purifier.js';
import { encodeHvacControl, decodeHvacSettings, type HvacCommand } from './devices/hvac.js';
import { RuntimeHealth, measurementFreshnessMs, type HealthResult } from './runtime/health.js';
import { RuntimeStatusStore, type RuntimeStatus } from './runtime/status.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

import { normalizeFeatures, type FeatureOptions } from './features.js';
import { MatterAdapter } from './matter/adapter.js';

export class HejhomePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  public readonly features: FeatureOptions;
  private readonly matter: MatterAdapter | undefined;
  private stopping = false;
  private readonly commands = new Map<string, Promise<void>>();
  private readonly handlerSignatures = new Map<string, string>();
  private readonly accessoryHandlers: Map<string, HejhomePlatformAccessory> = new Map();
  private readonly logStore: LogStore;
  private readonly snapshotStore: DeviceSnapshotStore;
  private readonly sessionStore: SessionStore;
  private client: HejRestClient | null = null;
  private realtime: HejRealtimeClient | null = null;
  private initialized = false;
  private readonly devices = new Map<string, HejDevice>();
  private readonly observations = new StateObservations();
  private readonly powerEstimates: PowerEstimates;
  private readonly matterSettlements = new Map<string, ReturnType<typeof setImmediate>>();
  private readonly health: RuntimeHealth;
  private readonly statusStore: RuntimeStatusStore;
  private readonly commandServer: RuntimeCommandServer;
  private readonly controls = new Map<string, { at: string; success: boolean }>();
  private connection: RuntimeStatus['connection'] = { session: 'unknown', realtime: 'unknown' };
  private sessionFingerprint = '';
  private powerSessionVerified = false;
  private energyAccountRetry: { identifier: string; at: number } | null = null;
  private inventoryOwnerFingerprint = '';
  private generation = 0;
  private sessionChecking = false;
  private discoveryRunning: Promise<void> | null = null;
  private discoveryRetry: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 5000;
  private lastDiscoveryAt = 0;
  private receivedConnection = false;
  private rediscoveryPending = false;
  private readonly verifiedDevices = new Set<string>();
  private readonly reportedAt = new Map<string, Map<string, number>>();
  private readonly reportedStates = new Map<string, NonNullable<HejDevice['deviceState']>>();
  private discoveryPatches: Map<string, Partial<HejDevice>> | null = null;
  private initializing = false;
  private localPublicationsPruned = false;
  private sessionWatchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    public readonly log: Logging,
    public readonly config: HejhomePlatformConfig,
    public readonly api: API,
  ) {
    this.features = normalizeFeatures(config.features);
    this.health = new RuntimeHealth(() => Date.now(), this.features);
    this.powerEstimates = new PowerEstimates(this.features.devices ?? {}, this.features.meters,
      new EstimatedEnergyStore(api.user.storagePath(), (error) => this.warn('power-estimates.invalid-history', { error: error.message })),
      (error) => this.warn('power-estimates.persistence-failed', { error: String(error) }));
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.logStore = new LogStore(api.user.storagePath());
    this.snapshotStore = new DeviceSnapshotStore(api.user.storagePath());
    this.sessionStore = new SessionStore(api.user.storagePath());
    this.statusStore = new RuntimeStatusStore(api.user.storagePath());
    this.commandServer = new RuntimeCommandServer(api.user.storagePath(), (request, signal) => this.executeUiCommand(request, signal));

    if (api.matter) {
      this.matter = new MatterAdapter(api.matter, (id, requirements) => this.controlDevice(id, requirements, 'matter'),
        this.features.meters, (error) => this.warn('matter.update.failed', { error: String(error) }), this.features.devices ?? {},
        (device) => this.powerEstimates.project(device));
    } else if (this.features.matter) {
      this.warn('matter.disabled-on-bridge', { message: 'Enable Matter for this bridge in Homebridge UI and restart.' });
    }

    this.info('platform.bootstrapped', { name: this.config.name ?? 'Hejhome' });

    this.api.on('didFinishLaunching', () => {
      void this.initialize();
    });

    this.api.on('shutdown', () => {
      this.stopping = true;
      this.powerEstimates.setConnected(false);
      this.generation++;
      this.cancelMatterSettlements();
      this.cancelDiscoveryRetry();
      this.connection.realtime = 'disconnected';
      this.persistStatus();
      this.stopSessionWatcher();
      this.realtime?.disconnect();
      this.client?.dispose();
      this.matter?.dispose();
      for (const handler of this.accessoryHandlers.values()) {
        handler.dispose('shutdown');
      }
      return Promise.all([this.commandServer.stop(), this.statusStore.flush(), this.powerEstimates.flush()])
        .catch((error) => this.warn('runtime.status.failed', { error: String(error) }));
    });
  }

  configureMatterAccessory(accessory: MatterAccessory): void {
    this.matter?.restore(accessory);
  }

  public controlDevice(id: string, requirements: Record<string, unknown>, origin: 'hap' | 'matter' | 'ui', signal?: AbortSignal): Promise<void> {
    const generation = this.generation;
    const previous = this.commands.get(id) ?? Promise.resolve();
    const command = previous.catch(() => undefined).then(async () => {
      if (this.stopping || !this.client || signal?.aborted) {
        throw new Error('Hejhome is not ready.');
      }
      if (generation !== this.generation) {
        throw new Error('Hejhome session changed. Try again.');
      }
      if (this.initialized && !await this.currentSessionMatches()) {
        throw new Error('Hejhome session changed. Try again.');
      }
      if (generation !== this.generation || this.stopping || !this.client || signal?.aborted) {
        throw new Error('Hejhome session changed. Try again.');
      }
      if (!this.devices.has(id) || (this.initialized && !this.verifiedDevices.has(id))) {
        throw new Error('Hejhome device is no longer available.');
      }
      const uuid = this.api.hap.uuid.generate(id);
      if (origin === 'matter') {
        this.accessoryHandlers.get(uuid)?.prepareExternalControl(requirements);
      }
      const pendingSettlement = this.matterSettlements.get(id);
      if (pendingSettlement) {
        clearImmediate(pendingSettlement); this.matterSettlements.delete(id);
      }
      const observedAtDispatch = this.observations.capture(id);
      try {
        // A command ACK is not a new physical power observation. Pause before dispatch.
        this.powerEstimates.suspend(id);
        const currentDevice = this.devices.get(id)!;
        if (this.matterVisible(id)) {
          void this.matter?.update(this.matterDevice(currentDevice)).catch((error) => this.warn('matter.update.failed', { error: String(error) }));
        }
        await this.client.controlDevice(id, requirements);
        if ((this.initialized && !await this.currentSessionMatches()) || generation !== this.generation) {
          throw new Error('Hejhome session changed. Try again.');
        }
        if (this.stopping) {
          return;
        }
        const current = this.devices.get(id);
        if (!current) {
          throw new Error('Hejhome device is no longer available.');
        }
        this.controls.set(id, { at: new Date().toISOString(), success: true });
        const committed = origin === 'ui' ? {} : { ...requirements };
        if (isMomentaryPowerDevice(current)) {
          delete committed.power;
        }
        const settled = this.observations.commit(id, current, committed, observedAtDispatch);
        this.applyDevice(settled.device, origin);
        if (settled.conflicted && origin === 'matter') {
          this.settleMatterControl(id, generation);
        }
      } catch (error) {
        if (generation === this.generation) {
          this.controls.set(id, { at: new Date().toISOString(), success: false });
          this.persistStatus();
        }
        throw error;
      }
    });
    this.commands.set(id, command);
    void command.finally(() => {
      if (this.commands.get(id) === command) {
        this.commands.delete(id);
      }
    }).catch(() => undefined);
    return command;
  }

  private settleMatterControl(id: string, generation: number): void {
    const timer = setImmediate(() => {
      this.matterSettlements.delete(id);
      const current = this.devices.get(id);
      if (!this.stopping && generation === this.generation && current && this.matterVisible(id)) {
        // The host commits a requested cluster value after its handler resolves.
        // Re-publish current truth after those promise continuations have settled.
        void this.matter?.update(this.matterDevice(current)).catch((error) => this.warn('matter.update.failed', { error: String(error) }));
      }
    });
    this.matterSettlements.set(id, timer);
  }

  private cancelMatterSettlements(): void {
    for (const timer of this.matterSettlements.values()) {
      clearImmediate(timer);
    }
    this.matterSettlements.clear();
  }

  private async currentSessionMatches(): Promise<boolean> {
    const session = await this.sessionStore.load();
    const matches = !!session && sessionFingerprint(session) === this.sessionFingerprint;
    if (!matches) {
      this.powerSessionVerified = false;
      this.powerEstimates.setConnected(false);
    }
    return matches;
  }

  public async controlRemoteButton(id: string, command: unknown, signal?: AbortSignal): Promise<void> {
    const device = this.devices.get(id);
    if (!device) {
      throw new Error('기기를 찾을 수 없습니다.');
    }
    const requirements = createIrRemoteRequirements(device.deviceType, command);
    await this.controlDevice(id, requirements, 'ui', signal);
  }

  private executeUiCommand(request: RuntimeCommandRequest, signal: AbortSignal): Promise<void> {
    const device = this.devices.get(request.deviceId);
    if (!device) {
      return Promise.reject(new Error('기기를 찾을 수 없습니다.'));
    }
    let requirements: Record<string, unknown>;
    if (request.kind === 'remote') {
      return this.controlRemoteButton(device.id, request.command, signal);
    } else if (request.kind === 'purifier') {
      if (device.deviceType !== 'Airpurifier') {
        return Promise.reject(new Error('지원하지 않는 공기청정기입니다.'));
      }
      requirements = encodePurifierControl(request.command);
    } else {
      if (device.deviceType !== 'IrAirconditioner') {
        return Promise.reject(new Error('지원하지 않는 에어컨입니다.'));
      }
      requirements = encodeHvacControl(request.command as HvacCommand);
    }
    return this.controlDevice(device.id, requirements, 'ui', signal);
  }

  public getDeviceHealth(id: string): HealthResult {
    if (this.stopping) {
      return { reachable: false, reason: 'shutdown' };
    }
    const device = this.health.device(id);
    if (!device.reachable) {
      return device;
    }
    if (this.connection.realtime === 'disconnected' || this.connection.realtime === 'connecting') {
      return { reachable: false, reason: 'realtime-disconnected' };
    }
    return device;
  }

  public getMeasurementHealth(id: string, key: string): HealthResult {
    const device = this.getDeviceHealth(id);
    return device.reachable ? this.health.measurement(id, key) : device;
  }

  public getDeviceTemperature(id: string): number | undefined {
    const sensorId = this.features.devices?.[id]?.temperatureSensorId;
    return sensorId ? this.measuredTemperature(sensorId) : undefined;
  }

  private measuredTemperature(id: string): number | undefined {
    const sensor = this.devices.get(id);
    if (!sensor || !['SensorTh', 'SensorTh2', 'SensorRefTh', 'SensorRefTh2'].includes(sensor.deviceType)
      || !this.getMeasurementHealth(sensor.id, 'temperature').reachable) {
      return undefined;
    }
    const value = sensor.deviceState?.temperature;
    if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
      return undefined;
    }
    const number = Number(value);
    return Number.isFinite(number) ? number : undefined;
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.info('accessory.cache.loaded', { displayName: accessory.displayName, uuid: accessory.UUID });
    this.accessories.set(accessory.UUID, accessory);
    const device = accessory.context.device as HejDevice | undefined;
    if (typeof device?.id === 'string' && device.id) {
      this.devices.set(device.id, device);
      if (this.homekitVisible(device.id)) {
        this.createAccessoryHandler(accessory, device);
      }
    }
  }

  private async initialize(): Promise<void> {
    this.startSessionWatcher();
    if (this.stopping || this.initialized || this.initializing) {
      return;
    }
    this.initializing = true;
    try {
      await this.pruneHiddenPublications();
      await this.commandServer.start();
      const session = await this.sessionStore.load();
      if (this.stopping) {
        return;
      }
      if (!session?.accessToken) {
        this.connection = { session: 'missing', realtime: 'disconnected' };
        this.warn('initialize.no-session', { message: 'Open the plugin settings and complete login.' });
        this.persistStatus();
        return;
      }
      await this.replaceSession(session);
    } catch (error) {
      this.error('initialize.failed', { error: String(error) });
    } finally {
      this.initializing = false;
    }
  }

  private async pruneHiddenPublications(): Promise<void> {
    if (this.localPublicationsPruned || this.stopping) {
      return;
    }
    // Explicit local opt-outs are independent of remote discovery completeness.
    for (const [uuid, accessory] of this.accessories) {
      const id = (accessory.context.device as HejDevice | undefined)?.id;
      if (typeof id === 'string' && id && !this.homekitVisible(id)) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessoryHandlers.get(uuid)?.dispose();
        this.accessoryHandlers.delete(uuid);
        this.handlerSignatures.delete(uuid);
        this.accessories.delete(uuid);
      }
    }
    await this.matter?.pruneHidden((id) => id === undefined ? this.features.matter : this.matterVisible(id));
    this.localPublicationsPruned = true;
    this.persistStatus();
  }

  private async loadPowerAccount(identifier: string): Promise<void> {
    try {
      await this.powerEstimates.loadAccount(identifier);
      this.energyAccountRetry = null;
    } catch (error) {
      // Optional estimation storage must never prevent native session recovery.
      // The estimator hides all totals until the same account loads successfully.
      this.energyAccountRetry = { identifier, at: Date.now() + 60000 };
      this.warn('power-estimates.history-unavailable', { error: String(error), retryInMs: 60000 });
    }
  }

  private async replaceSession(session: HejSession): Promise<void> {
    const generation = ++this.generation;
    this.cancelMatterSettlements();
    this.observations.clear();
    this.verifiedDevices.clear();
    this.reportedStates.clear();
    this.reportedAt.clear();
    this.health.retain(new Set());
    this.cancelDiscoveryRetry();
    this.realtime?.disconnect();
    this.client?.dispose();
    await this.loadPowerAccount(session.identifier);
    if (generation !== this.generation || this.stopping) {
      return;
    }
    this.matter?.setElectricalAccount(estimatedEnergyOwner(session.identifier));
    this.powerSessionVerified = true;
    this.sessionFingerprint = sessionFingerprint(session);
    this.connection = { session: session.expiresAt <= Date.now() ? 'expired' : 'unknown', realtime: 'connecting' };
    this.receivedConnection = false;
    this.refreshHealth();
    this.retryDelay = 5000;
    this.info('session.loaded', createSessionLogContext(session));
    this.client = new HejRestClient(session, {
      logger: (event) => {
        if (generation !== this.generation || this.stopping) {
          return;
        }
        if (event.httpStatus === 401 || event.httpStatus === 403) {
          this.connection.session = 'expired';
        } else if (event.httpStatus && event.httpStatus >= 200 && event.httpStatus < 300) {
          this.connection.session = 'valid';
        }
        this.info('rest.request', event);
        this.refreshHealth();
      },
    });
    for (const handler of this.accessoryHandlers.values()) {
      handler.rebindClient(this.client);
    }
    this.realtime = new HejRealtimeClient(session, {
      onDeviceUpdate: (device) => {
        if (generation === this.generation && !this.stopping) {
          this.handleRealtimeDeviceUpdate(device);
        }
      },
      onError: (error) => {
        if (generation === this.generation && !this.stopping) {
          this.warn('realtime.error', { message: error.message });
        }
      },
      onStatus: (event, data = {}) => {
        if (generation === this.generation && !this.stopping) {
          this.handleRealtimeStatus(event, data);
        }
      },
    });
    this.realtime.connect();
    this.initialized = true;
    this.persistStatus();
    // One discovery at a time; an old session result is discarded by its generation check.
    await this.discoveryRunning?.catch(() => undefined);
    if (generation !== this.generation || this.stopping) {
      return;
    }
    await this.refreshDiscovery();
  }

  private async refreshDiscovery(): Promise<void> {
    if (this.stopping) {
      return;
    }
    if (this.discoveryRunning) {
      this.rediscoveryPending = true;
      return;
    }
    const generation = this.generation;
    const work = this.discoverDevices();
    this.discoveryRunning = work;
    try {
      await work;
      this.retryDelay = 5000;
    } catch (error) {
      if (generation === this.generation && !this.stopping) {
        this.warn('discovery.failed', { error: String(error), retryInMs: this.retryDelay });
        this.scheduleDiscovery(this.retryDelay);
        this.retryDelay = Math.min(this.retryDelay * 2, 60000);
      }
    } finally {
      if (this.discoveryRunning === work) {
        this.discoveryRunning = null;
        if (this.rediscoveryPending && generation === this.generation && !this.stopping) {
          this.rediscoveryPending = false;
          this.scheduleDiscovery(1000);
        }
      }
    }
  }

  private async discoverDevices(): Promise<void> {
    const patches = new Map<string, Partial<HejDevice>>();
    this.discoveryPatches = patches;
    try {
      await this.collectAndApplyDiscovery(patches);
    } finally {
      if (this.discoveryPatches === patches) {
        this.discoveryPatches = null;
      }
    }
  }

  private async collectAndApplyDiscovery(patches: Map<string, Partial<HejDevice>>): Promise<void> {
    const client = this.client;
    const generation = this.generation;
    const ownerFingerprint = this.sessionFingerprint;
    const powerObservationStarted = this.powerEstimates.capture();
    if (!client || this.stopping) {
      return;
    }
    this.lastDiscoveryAt = Date.now();
    const discoveryScope = structuredClone(this.config.scope ?? { mode: 'first-family' as const });
    const families = await client.getFamilies();
    const scope = resolveDiscoveryScope({ scope: discoveryScope }, families);
    const snapshotFamilies: Array<{ family: HejFamily; devices: HejDevice[] }> = [];
    // Stage the entire selected scope before mutating either protocol or the cache.
    for (const selected of scope) {
      if (generation !== this.generation || this.stopping) {
        return;
      }
      const family = families.find((entry) => entry.familyId === selected.familyId);
      if (family) {
        const devices = await this.getScopedDevices(client, selected.familyId, selected.roomIds);
        snapshotFamilies.push({ family, devices });
      }
    }
    if (generation !== this.generation || this.stopping) {
      return;
    }
    if (!await this.currentSessionMatches() || generation !== this.generation || this.stopping) {
      return;
    }
    const discovered = snapshotFamilies.flatMap((family) => family.devices);
    const devices = discovered.map((device) => {
      const patch = patches.get(device.id);
      return { ...device, ...patch, name: this.features.devices?.[device.id]?.name ?? device.name,
        deviceState: { ...device.deviceState, ...this.freshReportedState(device), ...patch?.deviceState } };
    });
    const ids = new Set(devices.map((device) => device.id));
    for (const device of devices) {
      const newlyDiscovered = !this.devices.has(device.id);
      this.observations.record(device.id, device.deviceState ?? {});
      this.devices.set(device.id, device);
      this.health.observe(device, 'snapshot');
      const observed = discovered.find((entry) => entry.id === device.id)!;
      this.powerEstimates.observe(device, observed.deviceState ?? {}, powerObservationStarted);
      if (newlyDiscovered && patches.get(device.id)?.deviceState) {
        // Unknown devices cannot be commanded yet; a report staged during their
        // first discovery is newer than that discovery snapshot.
        this.powerEstimates.observe(device, patches.get(device.id)!.deviceState!);
      }
      this.verifiedDevices.add(device.id);
      if (!this.homekitVisible(device.id)) {
        continue;
      }
      const uuid = this.api.hap.uuid.generate(device.id);
      const existing = this.accessories.get(uuid);
      const accessory = existing ?? new this.api.platformAccessory(device.name, uuid);
      accessory.context.device = device;
      accessory.displayName = device.name;
      this.createAccessoryHandler(accessory, device);
      if (existing) {
        this.api.updatePlatformAccessories([accessory]);
      } else {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.set(uuid, accessory);
      }
    }
    for (const [uuid, accessory] of this.accessories) {
      const id = (accessory.context.device as HejDevice | undefined)?.id;
      if (typeof id !== 'string' || !id) {
        continue;
      }
      if (!ids.has(id) || !this.homekitVisible(id)) {
        this.accessoryHandlers.get(uuid)?.dispose();
        this.accessoryHandlers.delete(uuid);
        this.handlerSignatures.delete(uuid);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
      }
    }
    for (const id of this.devices.keys()) {
      if (!ids.has(id)) {
        this.devices.delete(id);
        this.controls.delete(id);
        this.observations.remove(id);
        this.verifiedDevices.delete(id);
        this.reportedStates.delete(id);
        this.reportedAt.delete(id);
      }
    }
    this.health.retain(ids);
    this.powerEstimates.retain(ids);
    try {
      await this.matter?.reconcile(devices.filter((device) => this.matterVisible(device.id)).map((device) => this.matterDevice(device)));
    } catch (error) {
      this.warn('matter.discovery.failed', { error: String(error) });
    }
    if (generation !== this.generation || this.stopping) {
      return;
    }
    await this.snapshotStore.save(snapshotFamilies, ownerFingerprint, discoveryScope);
    if (generation !== this.generation || this.stopping) {
      return;
    }
    this.inventoryOwnerFingerprint = ownerFingerprint;
    this.persistStatus();
    this.info('discovery.finished', { activeAccessories: this.accessories.size, deviceCount: devices.length });
  }

  private async getScopedDevices(client: HejRestClient, familyId: number, roomIds: number[] | undefined): Promise<HejDevice[]> {
    if (roomIds === undefined) {
      return client.getDevices(familyId);
    }
    const byId = new Map<string, HejDevice>();
    for (const roomId of roomIds) {
      if (this.stopping) {
        return [];
      }
      for (const device of await client.getDevices(familyId, roomId)) {
        byId.set(device.id, { ...device, roomId });
      }
    }
    return [...byId.values()];
  }

  private createAccessoryHandler(accessory: PlatformAccessory, device: HejDevice): void {
    const signature = JSON.stringify([device.deviceType, device.modelName ?? null, isMomentaryPowerDevice(device),
      this.features.devices?.[device.id]?.remoteButtons === true, this.features.devices?.[device.id]?.freshnessMinutes ?? null,
      this.features.devices?.[device.id]?.pm25Multiplier ?? null]);
    const existing = this.accessoryHandlers.get(accessory.UUID);
    if (existing && this.handlerSignatures.get(accessory.UUID) === signature) {
      existing.rebindClient(this.client);
      existing.updateDevice(device);
      return;
    }
    existing?.dispose();
    const handler = new HejhomePlatformAccessory(this, accessory, device, this.client);
    this.accessoryHandlers.set(accessory.UUID, handler);
    this.handlerSignatures.set(accessory.UUID, signature);
  }

  private handleRealtimeDeviceUpdate(devicePatch: Partial<HejDevice> & { id: string }): void {
    if (this.discoveryPatches) {
      const previous = this.discoveryPatches.get(devicePatch.id);
      this.discoveryPatches.set(devicePatch.id, { ...previous,
        ...(Object.keys(devicePatch.deviceState ?? {}).length > 0 ? { online: true } : {}), ...devicePatch,
        deviceState: { ...previous?.deviceState, ...devicePatch.deviceState } });
    }
    const current = this.devices.get(devicePatch.id);
    if (!current) {
      this.scheduleDiscovery(1000);
      return;
    }
    this.observations.record(devicePatch.id, devicePatch.deviceState ?? {});
    const liveReport = Object.keys(devicePatch.deviceState ?? {}).length > 0;
    if (liveReport || devicePatch.online === true) {
      this.verifiedDevices.add(devicePatch.id);
    }
    const timestamps = this.reportedAt.get(devicePatch.id) ?? new Map<string, number>();
    for (const key of Object.keys(devicePatch.deviceState ?? {})) {
      timestamps.set(key, Date.now());
    }
    this.reportedAt.set(devicePatch.id, timestamps);
    this.reportedStates.set(devicePatch.id, { ...this.reportedStates.get(devicePatch.id), ...devicePatch.deviceState });
    const next = mergeDeviceState({ ...current, ...devicePatch,
      ...(liveReport && devicePatch.online === undefined ? { online: true } : {}), deviceState: current.deviceState ?? {} },
    devicePatch.deviceState ?? {});
    // Only the received patch refreshes per-field timestamps, never the merged snapshot.
    this.health.observe({ ...next, deviceState: devicePatch.deviceState ?? {} }, 'realtime');
    this.accessoryHandlers.get(this.api.hap.uuid.generate(next.id))?.observeExternal(devicePatch.deviceState ?? {});
    this.powerEstimates.observe(next, devicePatch.deviceState ?? {});
    this.applyDevice(next, 'external');
    for (const dependent of this.devices.values()) {
      if (dependent.id !== next.id && this.features.devices?.[dependent.id]?.temperatureSensorId === next.id) {
        this.applyDevice(dependent, 'external');
      }
    }
  }

  private freshReportedState(device: HejDevice): NonNullable<HejDevice['deviceState']> {
    const retained: NonNullable<HejDevice['deviceState']> = {};
    for (const [key, value] of Object.entries(this.reportedStates.get(device.id) ?? {})) {
      const receivedAt = this.reportedAt.get(device.id)?.get(key) ?? 0;
      const keep = measurementFreshnessMs(device, key, this.features) !== null
        ? this.health.measurement(device.id, key).reachable
        : Date.now() - receivedAt <= 5000;
      if (keep) {
        retained[key] = value;
      }
    }
    return retained;
  }

  private applyDevice(device: HejDevice, origin: 'hap' | 'matter' | 'ui' | 'external'): void {
    if (this.stopping) {
      return;
    }
    this.devices.set(device.id, device);
    const uuid = this.api.hap.uuid.generate(device.id);
    const accessory = this.accessories.get(uuid);
    if (accessory) {
      accessory.context.device = device;
      this.api.updatePlatformAccessories([accessory]);
      this.accessoryHandlers.get(uuid)?.updateDevice(device);
    }
    if (this.matterVisible(device.id)) {
      const projected = this.matterDevice(device);
      if (origin === 'matter') {
        this.matter?.accept(projected);
      } else {
        void this.matter?.update(projected).catch((error) => this.warn('matter.update.failed', { error: String(error) }));
      }
    }
    this.persistStatus();
  }

  private homekitVisible(id: string): boolean {
    const visibility = this.features.devices?.[id]?.visibility;
    const device = this.devices.get(id);
    const capability = device ? getDeviceCapability(device.deviceType) : undefined;
    return visibility !== 'matter' && visibility !== 'hidden' && !!capability
      && capability.supportStatus !== 'unsupported' && capability.supportStatus !== 'deferred'
      && capability.serviceKind !== 'unsupported' && capability.homeKitServices.length > 0;
  }

  private matterVisible(id: string): boolean {
    const visibility = this.features.devices?.[id]?.visibility;
    return this.features.matter && visibility !== 'homekit' && visibility !== 'hidden';
  }

  private matterDevice(device: HejDevice): HejDevice {
    const deviceState = { ...device.deviceState };
    for (const key of Object.keys(deviceState)) {
      if (!this.health.measurement(device.id, key).reachable) {
        Object.assign(deviceState, { [key]: null });
      }
    }
    return { ...device, online: this.getDeviceHealth(device.id).reachable, deviceState };
  }

  private handleRealtimeStatus(event: string, data: Record<string, unknown>): void {
    this.info(`realtime.${event}`, data);
    const previous = this.connection.realtime;
    if (event === 'connect.success' || event === 'subscribe.success') {
      this.connection.realtime = 'connected';
      if (this.receivedConnection && previous !== 'connected') {
        this.scheduleDiscovery(1000);
      }
      this.receivedConnection = true;
    } else if (event === 'connect.closed' || event === 'disconnect' || event === 'connect.error' || event === 'subscribe.error') {
      this.connection.realtime = 'disconnected';
      this.discoveryPatches?.clear();
      this.reportedStates.clear();
      this.reportedAt.clear();
      this.health.invalidateMeasurements();
    } else if (event === 'connect.reconnect' || event === 'connect.start') {
      this.connection.realtime = 'connecting';
      this.discoveryPatches?.clear();
    }
    if (previous !== this.connection.realtime) {
      this.refreshHealth();
    }
  }

  private refreshHealth(): void {
    this.powerEstimates.setConnected(!this.stopping && this.powerSessionVerified && this.connection.realtime === 'connected'
      && this.connection.session !== 'missing' && this.connection.session !== 'expired');
    this.powerEstimates.tick();
    for (const device of this.devices.values()) {
      this.accessoryHandlers.get(this.api.hap.uuid.generate(device.id))?.updateDevice(device);
      if (this.matterVisible(device.id)) {
        void this.matter?.update(this.matterDevice(device)).catch((error) => this.warn('matter.update.failed', { error: String(error) }));
      }
    }
    this.persistStatus();
  }

  private scheduleDiscovery(delay: number): void {
    if (this.stopping || this.discoveryRetry) {
      return;
    }
    this.discoveryRetry = setTimeout(() => {
      this.discoveryRetry = null;
      void this.refreshDiscovery();
    }, Math.max(delay, 5000 - (Date.now() - this.lastDiscoveryAt)));
    this.discoveryRetry.unref?.();
  }

  private cancelDiscoveryRetry(): void {
    this.rediscoveryPending = false;
    if (this.discoveryRetry) {
      clearTimeout(this.discoveryRetry);
      this.discoveryRetry = null;
    }
  }

  private startSessionWatcher(): void {
    if (this.sessionWatchTimer || this.stopping) {
      return;
    }
    this.sessionWatchTimer = setInterval(() => {
      void this.checkSessionAndInitialize();
    }, 2000);
    this.sessionWatchTimer.unref?.();
  }

  private stopSessionWatcher(): void {
    if (this.sessionWatchTimer) {
      clearInterval(this.sessionWatchTimer);
      this.sessionWatchTimer = null;
    }
  }

  private async checkSessionAndInitialize(): Promise<void> {
    if (this.stopping || this.initializing || this.sessionChecking) {
      return;
    }
    this.sessionChecking = true;
    try {
      await this.pruneHiddenPublications();
      const session = await this.sessionStore.load();
      if (this.stopping) {
        return;
      }
      if (!session?.accessToken) {
        this.powerSessionVerified = false;
        this.energyAccountRetry = null;
        this.powerEstimates.setConnected(false);
        if (this.initialized) {
          this.generation++;
          this.cancelMatterSettlements();
          this.observations.clear();
          this.verifiedDevices.clear();
          this.reportedStates.clear();
          this.reportedAt.clear();
          this.health.retain(new Set());
          this.cancelDiscoveryRetry();
          this.realtime?.disconnect();
          this.client?.dispose();
          this.client = null;
          this.realtime = null;
          this.initialized = false;
          this.sessionFingerprint = '';
        }
        this.connection = { session: 'missing', realtime: 'disconnected' };
      } else if (sessionFingerprint(session) !== this.sessionFingerprint) {
        await this.replaceSession(session);
      }
      if (this.initialized && this.energyAccountRetry && Date.now() >= this.energyAccountRetry.at) {
        await this.loadPowerAccount(this.energyAccountRetry.identifier);
      }
      if (this.initialized && !this.discoveryRunning && Date.now() - this.lastDiscoveryAt >= 300000) {
        this.scheduleDiscovery(0);
      }
      this.refreshHealth();
    } catch (error) {
      this.warn('session-watcher.check-failed', { error: String(error) });
    } finally {
      this.sessionChecking = false;
    }
  }

  private persistStatus(): void {
    const ownedDevices = this.sessionFingerprint && this.inventoryOwnerFingerprint === this.sessionFingerprint ? [...this.devices.values()] : [];
    const status: RuntimeStatus = { version: 1, ...(this.sessionFingerprint ? { ownerFingerprint: this.sessionFingerprint } : {}),
      controlsAvailable: this.commandServer.available && !this.stopping,
      updatedAt: new Date().toISOString(), connection: { ...this.connection },
      devices: ownedDevices.map((device) => {
        const control = this.controls.get(device.id);
        const sensor = ['SensorTh', 'SensorTh2', 'SensorRefTh', 'SensorRefTh2'].includes(device.deviceType);
        const linkedHvac = device.deviceType === 'IrAirconditioner'
          && !!this.features.devices?.[device.id]?.temperatureSensorId;
        const temperatureCelsius = sensor ? this.measuredTemperature(device.id) : this.getDeviceTemperature(device.id);
        return { ...(sensor || linkedHvac ? { temperatureCelsius: temperatureCelsius ?? null } : {}),
          ...(device.deviceType === 'IrAirconditioner' ? { hvacSettings: decodeHvacSettings(device.deviceState) } : {}),
          ...(device.deviceType === 'Airpurifier' ? { purifierSettings: decodePurifierSettings(device.deviceState) } : {}),
          id: device.id, name: device.name, deviceType: device.deviceType,
          online: device.online ?? null, lastSeenAt: this.health.lastSeen(device.id),
          lastControlAt: control?.at ?? null, lastControl: control ? (control.success ? 'success' : 'failed') : 'unknown',
          homekit: this.accessories.has(this.api.hap.uuid.generate(device.id)),
          matter: this.matterVisible(device.id) && (this.matter?.hasDevice(device.id) ?? false) };
      }) };
    void this.statusStore.save(status).catch((error) => this.warn('runtime.status.failed', { error: String(error) }));
  }

  public debug(event: string, data: unknown = {}): void {
    this.writeLog('debug', event, data);
  }

  public info(event: string, data: unknown = {}): void {
    this.writeLog('info', event, data);
  }

  public warn(event: string, data: unknown = {}): void {
    this.writeLog('warn', event, data);
  }

  public error(event: string, data: unknown = {}): void {
    this.writeLog('error', event, data);
  }

  private writeLog(level: LogLevel, event: string, data: unknown = {}): void {
    const safeData = sanitizeForLog(data);
    void this.logStore.append(level, `platform.${event}`, safeData).catch((error) => {
      this.log.warn('Hejhome log file write failed:', sanitizeForLog(error instanceof Error ? error.message : String(error)));
    });

    const message = `Hejhome ${event}:`;
    if (level === 'error') {
      this.log.error(message, safeData);
      return;
    }
    if (level === 'warn') {
      this.log.warn(message, safeData);
      return;
    }
    if (level === 'debug') {
      this.log.debug(message, safeData);
      return;
    }
    this.log.info(message, safeData);
  }
}
