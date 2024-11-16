import { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import { v4 as uuidv4 } from 'uuid';

import { HejhomePlatform } from '../platform.js';
import { control } from '../requests/control.js';
import { HejDevice } from '../requests/get_devices.js';
import { hejDevices } from '../requests/realtime.js';
import { Base } from './base.js';

const CHARACTERISTIC_MANUFACTURER = '(주)고퀄';
const CHARACTERISTIC_MODEL = 'LKW-RC031';

export class RelayController extends Base {
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
      },
      Service,
    } = this.platform;

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Manufacturer, CHARACTERISTIC_MANUFACTURER)
      .setCharacteristic(Model, this.device.modelName || CHARACTERISTIC_MODEL)
      .setCharacteristic(SerialNumber, this.device.id);

    this.service = this.accessory.getService(Service.Switch) || this.accessory.addService(Service.Switch, this.device.name, uuidv4());
    this.service.setCharacteristic(Name, this.device.name);

    this.service
      .getCharacteristic(this.platform.Characteristic.On)
      .onSet(this.setPower.bind(this))
      .onGet(this.getPower.bind(this));
  }

  get state() {
    return hejDevices[this.device.id].deviceState;
  }

  async setPower(value: CharacteristicValue) {
    if (!this.state) {
      throw new Error('Not ready');
    }

    try {
      const power1 = value as boolean;
      await control(this.platform, this.device.id, { requirments: { power1 } });
      this.state.power1 = power1;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      this.platform.log.error(`Failed to set power state for device ${this.device.name}: ${e.message}`);
    }

    this.platform.log.info(
      `Device ${this.device.name} (RelayController) power state changed to ${value ? 'ON' : 'OFF'}`,
    );
  }

  async getPower() {
    if (!this.state) {
      throw new Error('Not ready');
    }

    return this.state.power1!;
  }

  public updateCharacteristics() {
    if (!this.state) {
      return;
    }

    this.service.updateCharacteristic(this.platform.Characteristic.On, this.state.power1 as boolean);
  }
}
