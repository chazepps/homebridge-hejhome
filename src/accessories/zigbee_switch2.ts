import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { v4 as uuidv4 } from 'uuid';

import { HejDevice } from '../requests/get_devices.js';
import { Base } from './base.js';
import { hejDevices } from '../requests/realtime.js';
import { control } from '../requests/control.js';
import { HejhomePlatform } from '../platform.js';

const CHARACTERISTIC_MANUFACTURER = '반디통신기술(주)';
const CHARACTERISTIC_MODEL = 'BDS03G2(2구)';

export class ZigbeeSwitch2 extends Base {
  private services: Service[] = [];

  get state() {
    return hejDevices[this.device.id].deviceState;
  }

  constructor(
    private platform: HejhomePlatform,
    private accessory: PlatformAccessory,
    private device: HejDevice,
  ) {
    super();

    const {
      Characteristic: {
        Manufacturer,
        Model,
        Name,
        On,
        SerialNumber,
      },
      Service: {
        AccessoryInformation,
        Switch,
      },
    } = platform;

    accessory
      .getService(AccessoryInformation)!
      .setCharacteristic(Manufacturer, CHARACTERISTIC_MANUFACTURER)
      .setCharacteristic(Model, device.modelName || CHARACTERISTIC_MODEL)
      .setCharacteristic(SerialNumber, device.id);

    for (let i = 1; i <= 2; i++) {
      const serviceName = `${device.name} ${i}`;
      let service = accessory.getService(serviceName);

      if (!service) {
        service = accessory.addService(Switch, serviceName, uuidv4());
      }

      service.setCharacteristic(Name, serviceName);
      service
        .getCharacteristic(On)
        .onSet(this.setPower.bind(this, i))
        .onGet(this.getPower.bind(this, i));

      this.services.push(service);
    }
  }

  async setPower(index: number, value: CharacteristicValue) {
    const { platform, device, state } = this;

    if (!state) {
      return;
    }

    const powerKey = `power${index}` as 'power1' | 'power2';

    try {
      await control(platform, device.id, {
        requirments: {
          [powerKey]: value as boolean,
        },
      });
      state[powerKey] = value as boolean;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      platform.log.error(`Failed to set power state for ${device.name} (ZigbeeSwitch2) power ${index}: ${e}`);
    }

    platform.log.info(
      `Device ${device.name} (ZigbeeSwitch2) power ${index} state changed to ${value ? 'ON' : 'OFF'}`,
    );
  }

  async getPower(index: number) {
    if (!this.state) {
      throw new Error('Not ready');
    }

    const powerKey = `power${index}` as 'power1' | 'power2';
    return this.state[powerKey] as boolean;
  }

  public updateCharacteristics() {
    this.services.forEach((service, index) => {
      if (!this.state) {
        return;
      }

      const powerKey = `power${index + 1}` as keyof typeof this.state;
      service.updateCharacteristic(this.platform.Characteristic.On, this.state[powerKey] as boolean);
    });
  }
}
