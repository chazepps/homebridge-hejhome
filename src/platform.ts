import { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, Service } from 'homebridge';

import { Base, LedStripRgbw2, LightRgbw5, RelayController, SensorMo, SmartButton, ZigbeeSwitch1, ZigbeeSwitch2 } from './accessories/index.js';
import { getToken, hejAccessories, HejDevice, hejDevices, hejEvent, startRealtime } from './requests/index.js';
import { HejhomePlatformConfig, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';

export class HejhomePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  public token: string | null = null;
  private tokenExpiry: number | null = null;

  constructor(
    public readonly log: Logging,
    public readonly config: HejhomePlatformConfig,
    public readonly api: API,
  ) {
    this.log.info('Initializing platform...');
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.api.on('didFinishLaunching', async () => {
      await this.initializeToken();
      await this.refreshToken();

      await new Promise<void>((r) => {
        const interval = setInterval(() => {
          if (this.token) {
            clearInterval(interval);
            r();
          }
        }, 100);
      });

      // Start real-time updates
      await startRealtime(this);
      // Discover and register devices
      await this.discoverDevices();

      // Device state update event handler
      hejEvent.on('deviceUpdated', (device: HejDevice) => {
        const uuid = this.api.hap.uuid.generate(device.id);
        const accessory = this.accessories.get(uuid);
        if (accessory) {
          accessory.context.device = device;
          hejAccessories[device.id]?.updateCharacteristics();
        }
      });
    });
  }

  // Initialize token and set refresh interval
  private async initializeToken() {
    setInterval(() => this.refreshToken(), 24 * 60 * 60 * 1000); // Refresh token every 24 hours
  }

  // Token refresh logic
  private async refreshToken() {
    const token = await getToken(this);
    if (!token) {
      this.log.error('Failed to refresh token');
      return;
    }

    try {
      this.token = token;
      this.tokenExpiry = Date.now() + 24 * 60 * 60 * 1000; // Set token expiry time (24 hours later)
      this.log.info('Token refreshed successfully');
    } catch (error) {
      this.log.error('Failed to refresh token:', error);
    }
  }

  // Validate and refresh token if necessary
  private async getToken() {
    if (!this.token || (this.tokenExpiry && Date.now() >= this.tokenExpiry)) {
      await this.refreshToken();
    }
    return this.token;
  }

  // Load accessory from cache
  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  // Discover and register devices
  async discoverDevices() {
    for (const id in hejDevices) {
      const device = hejDevices[id];
      const uuid = this.api.hap.uuid.generate(device.id);
      let existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        this.initHejAccessory(this, existingAccessory, device);
      } else {
        this.log.info('Adding new accessory:', device.name);

        const accessory = new this.api.platformAccessory(device.name, uuid);
        this.initHejAccessory(this, accessory, device);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.discoveredCacheUUIDs.push(uuid);
    }

    // Remove accessories that are in cache but no longer exist
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }

  // Initialize accessory based on device type
  initHejAccessory(
    platform: HejhomePlatform,
    accessory: PlatformAccessory,
    device: HejDevice,
  ) {
    let hejAccessory: Base | null = null;
    switch (device.deviceType) {
      case 'ZigbeeSwitch1':
        hejAccessory = new ZigbeeSwitch1(platform, accessory, device);
        break;
      case 'ZigbeeSwitch2':
        hejAccessory = new ZigbeeSwitch2(platform, accessory, device);
        break;
      case 'LightRgbw5':
        hejAccessory = new LightRgbw5(platform, accessory, device);
        break;
      case 'LedStripRgbw2':
        hejAccessory = new LedStripRgbw2(platform, accessory, device);
        break;
      case 'SensorMo':
        hejAccessory = new SensorMo(platform, accessory, device);
        break;
      case 'SmartButton':
        hejAccessory = new SmartButton(platform, accessory, device);
        break;
      case 'RelayController':
        hejAccessory = new RelayController(platform, accessory, device);
        break;
    }

    if (hejAccessory) {
      hejAccessories[device.id] = hejAccessory;
    }
  }
}
