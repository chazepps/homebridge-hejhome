import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { v4 as uuidv4 } from 'uuid';

import { HejhomePlatform } from '../platform.js';
import { control } from '../requests/control.js';
import { HejDevice } from '../requests/get_devices.js';
import { hejDevices } from '../requests/realtime.js';
import { Base } from './base.js';

const CHARACTERISTIC_MANUFACTURER = '주식회사 고퀄';
const CHARACTERISTIC_MODEL = 'LB032-RGBW';

export class LightRgbw5 extends Base {
  private service: Service;
  private platform: HejhomePlatform;
  private accessory: PlatformAccessory;
  private device: HejDevice;

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      this.platform.log.error(`Failed to set power state for device ${this.device.name}: ${e.message}`);
    }

    this.platform.log.info(
      `Device ${this.device.name} (LightRgbw5) power state changed to ${value ? 'ON' : 'OFF'}`,
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
    this.platform.log.info(`Device ${this.device.name} (LightRgbw5) brightness set to ${value}`);
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
    this.platform.log.info(`Device ${this.device.name} (LightRgbw5) hue set to ${value}`);
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
    this.platform.log.info(`Device ${this.device.name} (LightRgbw5) saturation set to ${value}`);
  }

  async getSaturation(): Promise<CharacteristicValue> {
    if (!this.state) {
      throw new Error('Not ready');
    }

    return this.state.hsvColor!.saturation;
  }

  private hue = -1;
  private saturation = -1;
  private brightness = -1;

  async setHSV(hsv: { hue?: number; saturation?: number; brightness?: number }) {
    if (!this.state?.hsvColor) {
      return;
    }

    if (this.hue === -1 && this.saturation === -1 && this.brightness === -1) {
      this.hue = this.state.hsvColor.hue;
      this.saturation = this.state.hsvColor.saturation;
      this.brightness = this.state.hsvColor.brightness;
    }

    if (hsv.hue !== undefined) {
      this.hue = hsv.hue;
    }

    if (hsv.saturation !== undefined) {
      this.saturation = hsv.saturation;
    }

    if (hsv.brightness !== undefined) {
      this.brightness = hsv.brightness;
    }

    try {
      await control(this.platform, this.device.id, {
        requirments: {
          hsvColor: {
            hue: this.hue,
            saturation: this.saturation,
            brightness: this.brightness,
          },
        },
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      this.platform.log.error(`Failed to set HSV for device ${this.device.name}: ${e.message}`);
    }

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
