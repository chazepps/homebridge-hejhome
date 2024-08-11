import { API, DynamicPlatformPlugin, Logging, PlatformAccessory, Service, Characteristic } from 'homebridge';

import { HejhomePlatformConfig, PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import { HejDevice, getToken, hejDevices, hejEvent, startRealtime } from './requests/index.js';
import { ZigbeeSwitch1, ZigbeeSwitch2, LightRgbw5, LedStripRgbw2, SmartButton, SensorMo, Base } from './accessories/index.js';

export class HejhomePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: PlatformAccessory[] = [];

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


      await startRealtime(this);
      await this.discoverDevices();

      hejEvent.on('deviceUpdated', (device) => {
        // 디바이스 상태 업데이트 반영
        const accessory = this.accessories.find(
          (acc) => acc.context.device.id === device.id,
        );
        if (accessory) {
          accessory.context.device = device;

          accessory.context.hejAccessory?.updateCharacteristics?.();
        }
      });
    });
  }

  private async initializeToken() {
    setInterval(() => this.refreshToken(), 24 * 60 * 60 * 1000); // 1일 간격으로 토큰 갱신
  }

  private async refreshToken() {
    const token = await getToken(this);
    if (!token) {
      this.log.error('Failed to refresh token');
      return;
    }

    try {
      this.token = token;
      this.tokenExpiry = Date.now() + 24 * 60 * 60 * 1000; // 토큰 만료 시간 설정 (1일 후)
      this.log.info('Token refreshed successfully');
    } catch (error) {
      this.log.error('Failed to refresh token:', error);
    }
  }

  private async getToken() {
    if (!this.token || (this.tokenExpiry && Date.now() >= this.tokenExpiry)) {
      await this.refreshToken();
    }
    return this.token;
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info(
      `Loading accessory from cache... name: ${accessory.displayName}`,
    );

    this.accessories.push(accessory);
  }

  async discoverDevices() {
    const uuids = Object.values(hejDevices).map((device) =>
      this.api.hap.uuid.generate(device.id),
    );

    for (const accessory of this.accessories) {
      if (!uuids.includes(accessory.UUID)) {
        this.log.info(
          'Removing existing accessory from cache:',
          accessory.displayName,
        );
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
      }
    }

    // Register new devices
    for (const id in hejDevices) {
      const device = hejDevices[id];

      const uuid = this.api.hap.uuid.generate(device.id);
      let accessory = this.accessories.find(
        (accessory) => accessory.UUID === uuid,
      );

      let needRegister = false;

      if (!accessory) {
        accessory = new this.api.platformAccessory(device.name, uuid);
        accessory.context.device = device;
        needRegister = true;
      }

      const supported = this.initHejAccessory(this, accessory, device);

      if (needRegister && supported) {
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [
          accessory,
        ]);
      }
    }
  }

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
    }

    if (hejAccessory) {
      accessory.context.hejAccessory = hejAccessory;
      return true;
    }

    return false;
  }
}
