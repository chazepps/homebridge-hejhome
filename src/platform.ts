import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, Service } from 'homebridge';

import { HejRestClient } from './hej/rest.js';
import { HejRealtimeClient } from './hej/realtime.js';
import { HejhomePlatformAccessory } from './platformAccessory.js';
import { DeviceSnapshotStore } from './storage/deviceSnapshotStore.js';
import { LogStore, type LogLevel } from './storage/logStore.js';
import { SessionStore } from './storage/sessionStore.js';
import type { HejDevice, HejFamily, HejhomePlatformConfig } from './types.js';
import { sanitizeForLog } from './utils/redact.js';
import { createSessionLogContext } from './utils/sessionDiagnostics.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class HejhomePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;
  public readonly accessories: Map<string, PlatformAccessory> = new Map();

  private readonly accessoryHandlers: Map<string, HejhomePlatformAccessory> = new Map();
  private readonly logStore: LogStore;
  private readonly snapshotStore: DeviceSnapshotStore;
  private readonly sessionStore: SessionStore;
  private client: HejRestClient | null = null;
  private realtime: HejRealtimeClient | null = null;
  private initialized = false;
  private initializing = false;
  private sessionWatchTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    public readonly log: Logging,
    public readonly config: HejhomePlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;
    this.logStore = new LogStore(api.user.storagePath());
    this.snapshotStore = new DeviceSnapshotStore(api.user.storagePath());
    this.sessionStore = new SessionStore(api.user.storagePath());

    this.info('platform.bootstrapped', { name: this.config.name ?? 'Hejhome' });

    this.api.on('didFinishLaunching', () => {
      void this.initialize();
    });

    this.api.on('shutdown', () => {
      this.stopSessionWatcher();
      this.realtime?.disconnect();
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.info('accessory.cache.loaded', { displayName: accessory.displayName, uuid: accessory.UUID });
    this.accessories.set(accessory.UUID, accessory);
  }

  private async initialize(): Promise<void> {
    if (this.initialized || this.initializing) {
      this.debug('initialize.skipped', { initialized: this.initialized, initializing: this.initializing });
      return;
    }

    this.initializing = true;
    try {
      this.info('initialize.start');
      const session = await this.sessionStore.load();
      if (!session?.accessToken) {
        this.warn('initialize.no-session', { message: 'Open the plugin settings and complete login.' });
        this.startSessionWatcher();
        return;
      }

      this.stopSessionWatcher();
      this.info('session.loaded', createSessionLogContext(session));

      this.client = new HejRestClient(session, {
        logger: (event) => this.info('rest.request', event),
      });
      await this.discoverDevices();

      this.realtime = new HejRealtimeClient(session, {
        onDeviceUpdate: (device) => this.handleRealtimeDeviceUpdate(device),
        onError: (error) => this.warn('realtime.error', { message: error.message }),
        onStatus: (event, data = {}) => this.info(`realtime.${event}`, data),
      });
      this.realtime.connect();
      this.initialized = true;
    } catch (error) {
      this.error('initialize.failed', { error: error instanceof Error ? error.message : String(error) });
    } finally {
      this.initializing = false;
    }
  }

  private async discoverDevices(): Promise<void> {
    if (!this.client) {
      return;
    }

    this.info('accessory-load.start', {
      cachedAccessories: this.accessories.size,
      source: 'stored-session',
    });
    this.info('discovery.start');
    let registeredCount = 0;
    let updatedCount = 0;
    let staleCount = 0;
    let deviceCount = 0;
    const discoveredCacheUUIDs = new Set<string>();
    const snapshotFamilies: Array<{ family: HejFamily; devices: HejDevice[] }> = [];
    const families = await this.client.getFamilies();
    this.info('discovery.families', { familyCount: families.length });
    for (const family of families) {
      const devices = await this.client.getDevices(family.familyId);
      deviceCount += devices.length;
      snapshotFamilies.push({ family, devices });
      this.info('discovery.family-devices', {
        familyId: family.familyId,
        familyName: family.name,
        deviceCount: devices.length,
      });
      for (const device of devices) {
        const uuid = this.api.hap.uuid.generate(device.id);
        discoveredCacheUUIDs.add(uuid);
        const existingAccessory = this.accessories.get(uuid);

        if (existingAccessory) {
          existingAccessory.context.device = device;
          this.api.updatePlatformAccessories([existingAccessory]);
          this.createAccessoryHandler(existingAccessory, device);
          updatedCount += 1;
          this.info('accessory.updated', deviceLogContext(device, uuid));
        } else {
          const accessory = new this.api.platformAccessory(device.name, uuid);
          accessory.context.device = device;
          this.createAccessoryHandler(accessory, device);
          this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
          this.accessories.set(uuid, accessory);
          registeredCount += 1;
          this.info('accessory.registered', deviceLogContext(device, uuid));
        }
      }
    }

    const snapshot = await this.snapshotStore.save(snapshotFamilies);
    this.info('snapshot.saved', {
      path: this.snapshotStore.path,
      familyCount: snapshot.familyCount,
      deviceCount: snapshot.deviceCount,
      generatedAt: snapshot.generatedAt,
    });

    for (const [uuid, accessory] of this.accessories) {
      if (!discoveredCacheUUIDs.has(uuid)) {
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.accessories.delete(uuid);
        this.accessoryHandlers.delete(uuid);
        staleCount += 1;
        this.info('accessory.unregistered-stale', {
          displayName: accessory.displayName,
          uuid,
        });
      }
    }
    this.info('discovery.summary', {
      familyCount: families.length,
      deviceCount,
      registeredCount,
      updatedCount,
      staleCount,
      activeAccessories: this.accessories.size,
    });
    this.info('discovery.finished', {
      activeAccessories: this.accessories.size,
    });
    this.info('accessory-load.finished', {
      activeAccessories: this.accessories.size,
      registeredCount,
      updatedCount,
      staleCount,
    });
  }

  private createAccessoryHandler(accessory: PlatformAccessory, device: HejDevice): void {
    const handler = new HejhomePlatformAccessory(this, accessory, device, this.client);
    this.accessoryHandlers.set(accessory.UUID, handler);
  }

  private handleRealtimeDeviceUpdate(devicePatch: Partial<HejDevice> & { id: string }): void {
    const uuid = this.api.hap.uuid.generate(devicePatch.id);
    const accessory = this.accessories.get(uuid);
    if (!accessory) {
      this.warn('realtime.update.ignored-unknown-device', { deviceId: devicePatch.id });
      return;
    }

    const current = accessory.context.device as HejDevice;
    const next: HejDevice = {
      ...current,
      ...devicePatch,
      deviceState: {
        ...(current.deviceState ?? {}),
        ...(devicePatch.deviceState ?? {}),
      },
    };
    accessory.context.device = next;
    this.api.updatePlatformAccessories([accessory]);
    this.accessoryHandlers.get(uuid)?.updateDevice(next);
    this.info('realtime.state-applied', {
      deviceId: devicePatch.id,
      stateKeys: Object.keys(devicePatch.deviceState ?? {}),
    });
  }

  private startSessionWatcher(): void {
    if (this.sessionWatchTimer) {
      return;
    }
    this.info('session-watcher.started');
    this.sessionWatchTimer = setInterval(() => {
      void this.checkSessionAndInitialize();
    }, 2000);
    this.sessionWatchTimer.unref?.();
  }

  private stopSessionWatcher(): void {
    if (!this.sessionWatchTimer) {
      return;
    }
    clearInterval(this.sessionWatchTimer);
    this.sessionWatchTimer = null;
    this.info('session-watcher.stopped');
  }

  private async checkSessionAndInitialize(): Promise<void> {
    if (this.initialized || this.initializing) {
      return;
    }
    try {
      const session = await this.sessionStore.load();
      if (!session?.accessToken) {
        return;
      }
      this.info('session-watcher.session-detected');
      await this.initialize();
    } catch (error) {
      this.warn('session-watcher.check-failed', { error: error instanceof Error ? error.message : String(error) });
    }
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

function deviceLogContext(device: HejDevice, uuid: string): Record<string, unknown> {
  return sanitizeForLog({
    id: device.id,
    uuid,
    name: device.name,
    deviceType: device.deviceType,
    modelName: device.modelName,
    familyId: device.familyId,
    roomId: device.roomId,
    online: device.online,
    stateKeys: Object.keys(device.deviceState ?? {}),
  });
}
