import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { v4 as uuidv4 } from 'uuid';

import { HejDevice } from '../requests/get_devices.js';
import { hejDevices } from '../requests/realtime.js';
import { control } from '../requests/control.js';
import { HejhomePlatform } from '../platform.js';
import { Base } from './base.js';

const CHARACTERISTIC_MANUFACTURER = '주식회사 고퀄';
const CHARACTERISTIC_MODEL = 'LS061-RGBW';

export class LedStripRgbw2 extends Base {
  private service: Service;
  private platform: HejhomePlatform;
  private accessory: PlatformAccessory;
  private device: HejDevice;
  private hsvTemp: { hue: number; saturation: number; brightness: number } | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    platform: HejhomePlatform,
    accessory: PlatformAccessory,
    device: HejDevice,
  ) {
    super();
    this.platform = platform;
    this.accessory = accessory;
    this.device = device;

    const {
      Characteristic: {
        Manufacturer,
        Model,
        SerialNumber,
        Name,
        On,
        Brightness,
        Hue,
        Saturation,
      },
      Service: {
        AccessoryInformation,
        Lightbulb,
      },
    } = this.platform;

    this.accessory
      .getService(AccessoryInformation)!
      .setCharacteristic(Manufacturer, CHARACTERISTIC_MANUFACTURER)
      .setCharacteristic(Model, this.device.modelName || CHARACTERISTIC_MODEL)
      .setCharacteristic(SerialNumber, this.device.id);

    this.service = this.accessory.getService(Lightbulb) || this.accessory.addService(Lightbulb, this.device.name, uuidv4());
    this.service.setCharacteristic(Name, this.device.name);

    this.service
      .getCharacteristic(On)
      .onSet(this.setOn.bind(this))
      .onGet(this.getOn.bind(this));

    this.service
      .getCharacteristic(Brightness)
      .onSet(this.setBrightness.bind(this))
      .onGet(this.getBrightness.bind(this));

    this.service
      .getCharacteristic(Hue)
      .onSet(this.setHue.bind(this))
      .onGet(this.getHue.bind(this));

    this.service
      .getCharacteristic(Saturation)
      .onSet(this.setSaturation.bind(this))
      .onGet(this.getSaturation.bind(this));
  }

  get state() {
    return hejDevices[this.device.id].deviceState;
  }

  async setOn(value: CharacteristicValue) {
    if (!this.state) {
      throw new Error('Not ready');
    }

    try {
      await control(this.platform, this.device.id, {
        requirments: {
          power: value as boolean,
        },
      });

      this.state.power = value as boolean;
    } catch (e) {
      this.platform.log.error(`Failed to set power state for device ${this.device.name}: ${e}`);
    }

    this.platform.log.info(
      `Device ${this.device.name} (LedStripRgbw2) power state changed to ${value ? 'ON' : 'OFF'}`,
    );
  }

  async getOn(): Promise<CharacteristicValue> {
    if (!this.state) {
      throw new Error('Not ready');
    }

    return this.state.power!;
  }

  async setBrightness(value: CharacteristicValue) {
    if (!this.state) {
      throw new Error('Not ready');
    }

    await this.setHSV({ brightness: value as number });
    this.state.hsvColor!.brightness = value as number;
    this.platform.log.info(`Device ${this.device.name} (LedStripRgbw2) brightness set to ${value}`);
  }

  async getBrightness(): Promise<CharacteristicValue> {
    if (!this.state) {
      throw new Error('Not ready');
    }

    return this.state.hsvColor!.brightness;
  }

  async setHue(value: CharacteristicValue) {
    if (!this.state) {
      throw new Error('Not ready');
    }

    await this.setHSV({ hue: value as number });
    this.state.hsvColor!.hue = value as number;
    this.platform.log.info(`Device ${this.device.name} (LedStripRgbw2) hue set to ${value}`);
  }

  async getHue(): Promise<CharacteristicValue> {
    if (!this.state) {
      throw new Error('Not ready');
    }

    return this.state.hsvColor!.hue;
  }

  async setSaturation(value: CharacteristicValue) {
    if (!this.state) {
      throw new Error('Not ready');
    }

    await this.setHSV({ saturation: value as number });
    this.state.hsvColor!.saturation = value as number;
    this.platform.log.info(`Device ${this.device.name} (LedStripRgbw2) saturation set to ${value}`);
  }

  async getSaturation(): Promise<CharacteristicValue> {
    if (!this.state) {
      throw new Error('Not ready');
    }

    return this.state.hsvColor!.saturation;
  }

  async setHSV(hsv: { hue?: number; saturation?: number; brightness?: number }) {
    if (this.timer) {
      clearTimeout(this.timer);
    }

    if (!this.state) {
      return;
    }

    if (!this.hsvTemp) {
      this.hsvTemp = this.state.hsvColor!;
    }

    if (hsv.hue !== undefined) {
      this.hsvTemp.hue = hsv.hue;
    }

    if (hsv.saturation !== undefined) {
      this.hsvTemp.saturation = hsv.saturation;
    }

    if (hsv.brightness !== undefined) {
      this.hsvTemp.brightness = hsv.brightness;
    }

    this.timer = setTimeout(async () => {
      if (!this.hsvTemp) {
        return;
      }

      try {
        await control(this.platform, this.device.id, {
          requirments: {
            hsvColor: this.hsvTemp,
          },
        });
      } catch (e) {
        this.platform.log.error(`Failed to set HSV for device ${this.device.name}: ${e}`);
      }

      this.hsvTemp = null;
    }, 100);
  }

  public updateCharacteristics() {
    if (!this.state) {
      return;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.On, this.state.power as boolean);
    this.service.updateCharacteristic(this.platform.Characteristic.Brightness, this.state.hsvColor!.brightness);
    this.service.updateCharacteristic(this.platform.Characteristic.Hue, this.state.hsvColor!.hue);
    this.service.updateCharacteristic(this.platform.Characteristic.Saturation, this.state.hsvColor!.saturation);
  }
}
