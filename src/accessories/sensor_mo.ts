import { PlatformAccessory, Service } from 'homebridge';

import { HejhomePlatform } from '../platform.js';
import { HejDevice } from '../requests/get_devices.js';
import { hejEvent } from '../requests/realtime.js';
import { Base } from './base.js';

export const EVENT_MOTION_DETECTED = 'motionDetected';

const CHARACTERISTIC_MANUFACTURER = 'Hejhome';
const CHARACTERISTIC_MODEL = 'Unknown Hejhome device';

export class SensorMo extends Base {
  private service: Service;

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
    } = this.platform;

    this.accessory
      .getService(Service.AccessoryInformation)!
      .setCharacteristic(Manufacturer, CHARACTERISTIC_MANUFACTURER)
      .setCharacteristic(Model, this.device.modelName || CHARACTERISTIC_MODEL)
      .setCharacteristic(SerialNumber, this.device.id);

    this.service = this.accessory.getService(Service.MotionSensor) || this.accessory.addService(Service.MotionSensor);
    this.service.setCharacteristic(Name, this.device.name);

    this.registerEventListeners();
  }

  private registerEventListeners() {
    hejEvent.addListener(EVENT_MOTION_DETECTED, this.handleMotionDetected.bind(this));
  }

  private handleMotionDetected(deviceId: string, value: string) {
    const { Characteristic: { MotionDetected } } = this.platform;

    const motionDetected = value === 'pir';
    this.service.updateCharacteristic(MotionDetected, motionDetected);
  }
}