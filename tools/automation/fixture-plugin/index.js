import http from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';

const PLUGIN = 'homebridge-automation-fixture';
const PLATFORM = 'AutomationFixture';

const definitions = [
  { id: 'rgb', kind: 'rgb', state: { on: false, brightness: 40, hue: 60, saturation: 50 } },
  { id: 'white', kind: 'white', state: { on: false, brightness: 50, colorTemperature: 250 } },
  { id: 'fragile', kind: 'white', state: { on: false, brightness: 30, colorTemperature: 240 } },
  { id: 'door', kind: 'door', state: { open: false, online: true } },
  { id: 'motion', kind: 'motion', state: { detected: false, online: true } },
  { id: 'th1', kind: 'thermometer', state: { temperature: 20, humidity: 50, online: true } },
  { id: 'th2', kind: 'thermometer', state: { temperature: 24, humidity: 55, online: true } },
  { id: 'fan', kind: 'switch', state: { on: false } },
];

class AutomationFixture {
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.cached = new Map();
    this.devices = new Map(definitions.map(({ id, kind, state }) => [id, {
      id, kind, state: { ...state }, failWrite: false, service: null, accessory: null,
    }]));
    if (config.stateFile) {
      try {
        const saved = JSON.parse(readFileSync(config.stateFile, 'utf8'));
        for (const [id, state] of Object.entries(saved)) {
          if (this.devices.has(id)) {
            Object.assign(this.devices.get(id).state, state);
          }
        }
      } catch { /* A fresh test has no state file. */ }
    }
    this.writes = [];
    this.server = null;
    api.on('didFinishLaunching', () => void this.start());
    api.on('shutdown', () => this.server?.close());
  }

  configureAccessory(accessory) {
    this.cached.set(accessory.UUID, accessory);
  }

  async start() {
    const added = [];
    for (const device of this.devices.values()) {
      const uuid = this.api.hap.uuid.generate(`automation-fixture:${device.id}`);
      const accessory = this.cached.get(uuid) ?? new this.api.platformAccessory(device.id, uuid);
      device.accessory = accessory;
      this.configure(device);
      if (!this.cached.has(uuid)) {
        added.push(accessory);
      }
    }
    if (added.length) {
      this.api.registerPlatformAccessories(PLUGIN, PLATFORM, added);
    }
    this.server = http.createServer((request, response) => void this.handle(request, response));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.config.controlPort, '127.0.0.1', resolve);
    });
    this.log.info(`FIXTURE_READY port=${this.config.controlPort}`);
  }

  configure(device) {
    const { Service, Characteristic, HapStatusError, HAPStatus } = this.api.hap;
    const accessory = device.accessory;
    accessory.getService(Service.AccessoryInformation)
      .setCharacteristic(Characteristic.Manufacturer, 'Hejhome fixture')
      .setCharacteristic(Characteristic.Model, device.kind)
      .setCharacteristic(Characteristic.SerialNumber, device.id);
    const add = (serviceType, name) => accessory.getService(serviceType) ?? accessory.addService(serviceType, name);
    const sensor = (service, characteristic, key, map = value => value) => {
      service.getCharacteristic(characteristic).onGet(() => {
        if (device.state.online === false || device.state[key] === undefined) {
          throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        }
        return map(device.state[key]);
      });
      service.getCharacteristic(Characteristic.StatusFault)
        .onGet(() => device.state.online === false || device.state[key] === undefined ? 1 : 0);
    };
    const control = (service, characteristic, key) => {
      service.getCharacteristic(characteristic)
        .onGet(() => device.state[key])
        .onSet(value => {
          this.writes.push({ id: device.id, key, value, success: !device.failWrite });
          if (device.failWrite) {
            throw new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
          }
          device.state[key] = value;
          service.updateCharacteristic(characteristic, value);
          this.persist();
        });
    };
    if (device.kind === 'rgb' || device.kind === 'white') {
      const service = add(Service.Lightbulb, device.id);
      device.service = service;
      control(service, Characteristic.On, 'on');
      control(service, Characteristic.Brightness, 'brightness');
      if (device.kind === 'rgb') {
        control(service, Characteristic.Hue, 'hue');
        control(service, Characteristic.Saturation, 'saturation');
      } else {
        control(service, Characteristic.ColorTemperature, 'colorTemperature');
      }
    } else if (device.kind === 'switch') {
      const service = add(Service.Switch, device.id);
      device.service = service;
      control(service, Characteristic.On, 'on');
    } else if (device.kind === 'door') {
      const service = add(Service.ContactSensor, device.id);
      device.service = service;
      sensor(service, Characteristic.ContactSensorState, 'open', value => value ? 1 : 0);
    } else if (device.kind === 'motion') {
      const service = add(Service.MotionSensor, device.id);
      device.service = service;
      sensor(service, Characteristic.MotionDetected, 'detected');
    } else if (device.kind === 'thermometer') {
      const temperature = add(Service.TemperatureSensor, `${device.id} temperature`);
      const humidity = add(Service.HumiditySensor, `${device.id} humidity`);
      device.service = [temperature, humidity];
      sensor(temperature, Characteristic.CurrentTemperature, 'temperature');
      sensor(humidity, Characteristic.CurrentRelativeHumidity, 'humidity');
    }
    this.publish(device);
  }

  publish(device) {
    const { Characteristic } = this.api.hap;
    if (device.kind === 'door' && device.state.open !== undefined) {
      device.service.updateCharacteristic(Characteristic.ContactSensorState, device.state.open ? 1 : 0);
    } else if (device.kind === 'motion' && device.state.detected !== undefined) {
      device.service.updateCharacteristic(Characteristic.MotionDetected, device.state.detected);
    } else if (device.kind === 'thermometer') {
      if (device.state.temperature !== undefined) {
        device.service[0].updateCharacteristic(Characteristic.CurrentTemperature, device.state.temperature);
      }
      if (device.state.humidity !== undefined) {
        device.service[1].updateCharacteristic(Characteristic.CurrentRelativeHumidity, device.state.humidity);
      }
    } else if (['rgb', 'white', 'switch'].includes(device.kind)) {
      device.service.updateCharacteristic(Characteristic.On, device.state.on);
    }
    const services = Array.isArray(device.service) ? device.service : [device.service];
    for (const service of services) {
      if (service?.testCharacteristic(Characteristic.StatusFault)) {
        service.updateCharacteristic(Characteristic.StatusFault, device.state.online === false ? 1 : 0);
      }
    }
  }

  async handle(request, response) {
    try {
      if (request.method === 'GET' && request.url === '/state') {
        this.send(response, 200, { devices: [...this.devices.values()].map(({ id, kind, state, failWrite }) => ({
          id, kind, state, failWrite,
        })), writes: this.writes });
        return;
      }
      if (request.method !== 'POST' || request.url !== '/device') {
        this.send(response, 404, { error: 'not found' });
        return;
      }
      let body = '';
      for await (const chunk of request) {
        body += chunk;
      }
      const { id, patch = {}, failWrite } = JSON.parse(body);
      const device = this.devices.get(id);
      if (!device || typeof patch !== 'object' || Array.isArray(patch)) {
        this.send(response, 400, { error: 'invalid device' });
        return;
      }
      Object.assign(device.state, patch);
      if (typeof failWrite === 'boolean') {
        device.failWrite = failWrite;
      }
      this.persist();
      this.publish(device);
      this.send(response, 200, { ok: true });
    } catch (error) {
      this.send(response, 500, { error: String(error) });
    }
  }

  send(response, status, value) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(value));
  }

  persist() {
    if (!this.config.stateFile) {
      return;
    }
    writeFileSync(this.config.stateFile, JSON.stringify(Object.fromEntries(
      [...this.devices].map(([id, device]) => [id, device.state]))));
  }
}

export default api => api.registerPlatform(PLUGIN, PLATFORM, AutomationFixture);
