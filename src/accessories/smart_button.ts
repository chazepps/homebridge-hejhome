import { PlatformAccessory, Service } from 'homebridge';

import { HejhomePlatform } from '../platform.js';
import { HejDevice } from '../requests/get_devices.js';
import { hejEvent } from '../requests/realtime.js';
import { Base } from './base.js';

export const EVENT_BUTTON_PRESSED = 'clickSmartButton';

export const SMART_BUTTON_ACTION_SINGLE_CLICK = 'single_click';
export const SMART_BUTTON_ACTION_DOUBLE_CLICK = 'double_click';

export type SmartButtonAction =
  typeof SMART_BUTTON_ACTION_SINGLE_CLICK |
  typeof SMART_BUTTON_ACTION_DOUBLE_CLICK;

const CHARACTERISTIC_MANUFACTURER = 'Hejhome';
const CHARACTERISTIC_MODEL = 'Unknown Hejhome device';

export class SmartButton extends Base {
  private services: Service[];

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
        SerialNumber,
        Name,
      },
      Service,
      uuid,
    } = this.platform.api.hap;

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Manufacturer, CHARACTERISTIC_MANUFACTURER)
      .setCharacteristic(Model, this.device.modelName || CHARACTERISTIC_MODEL)
      .setCharacteristic(SerialNumber, this.device.id);

    this.services = [...Array(4).keys()].map(i => {
      const serviceName = `Button ${i + 1}`;
      const serviceUUID = uuid.generate(`${this.device.id}-button-${i + 1}`);
      let service = this.accessory.getService(serviceUUID);

      if (!service) {
        service = this.accessory.addService(Service.StatelessProgrammableSwitch, serviceName, serviceUUID);
      }

      service.setCharacteristic(Name, serviceName);

      service.getCharacteristic(this.platform.Characteristic.ProgrammableSwitchEvent)
        .setProps({
          validValues: [
            this.platform.Characteristic.ProgrammableSwitchEvent.SINGLE_PRESS,
            this.platform.Characteristic.ProgrammableSwitchEvent.DOUBLE_PRESS,
          ],
        });
      service.setCharacteristic(this.platform.Characteristic.ServiceLabelIndex, i + 1);

      return service;
    });

    this.registerEventListeners();
  }

  private registerEventListeners() {
    hejEvent.addListener(EVENT_BUTTON_PRESSED, this.handleButtonPress.bind(this));
  }

  private handleButtonPress(deviceId: string, idx: number, value: SmartButtonAction) {
    if (deviceId !== this.device.id) {
      return;
    }

    const { Characteristic: { ProgrammableSwitchEvent } } = this.platform;

    const characteristicValues = {
      [SMART_BUTTON_ACTION_SINGLE_CLICK]: ProgrammableSwitchEvent.SINGLE_PRESS,
      [SMART_BUTTON_ACTION_DOUBLE_CLICK]: ProgrammableSwitchEvent.DOUBLE_PRESS,
    };

    this.services[idx].updateCharacteristic(ProgrammableSwitchEvent, characteristicValues[value]);
  }
}