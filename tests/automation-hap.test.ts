import { describe, expect, test, vi } from 'vitest';
import type { HejhomePlatform } from '../src/platform.js';
import { HejhomePlatformAccessory } from '../src/platformAccessory.js';
import type { HejDevice } from '../src/types.js';
import { HomebridgeAPI } from '../node_modules/homebridge/dist/api.js';

function produce(device: HejDevice, reachable = true) {
  const host = new HomebridgeAPI();
  const accessory = new host.platformAccessory(device.name, host.hap.uuid.generate(device.id));
  const controlDevice = vi.fn().mockResolvedValue(undefined);
  const client = { controlDevice: vi.fn().mockResolvedValue(undefined) };
  const platform = {
    Service: host.hap.Service,
    Characteristic: host.hap.Characteristic,
    api: { hap: host.hap },
    features: { adaptiveLighting: false, matter: false, meters: [] },
    controlDevice,
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    getDeviceHealth: () => ({ reachable, reason: reachable ? 'fresh' : 'stale' }),
    getMeasurementHealth: () => ({ reachable, reason: reachable ? 'fresh' : 'stale' }),
  } as unknown as HejhomePlatform;
  const handler = new HejhomePlatformAccessory(platform, accessory, device, client as never);
  return { host, accessory, handler, controlDevice };
}

function device(id: string, deviceType: HejDevice['deviceType'], state: HejDevice['deviceState']): HejDevice {
  return { id, name: id, deviceType, online: true, deviceState: state };
}

describe('UI 6 alpha HAP input and target contract from the produced plugin accessories', () => {
  test('C1 publishes only the writable light modes actually supported by each model', async () => {
    const rgb = produce(device('rgb', 'LightRgbw5', { power: true, brightness: 70,
      hsvColor: { hue: 120, saturation: 40, brightness: 70 } }));
    const white = produce(device('white', 'LightWw1', { power: true, brightness: 50, temperature: 50 }));
    const rgbLight = rgb.accessory.getService(rgb.host.hap.Service.Lightbulb)!;
    const whiteLight = white.accessory.getService(white.host.hap.Service.Lightbulb)!;
    expect(rgbLight.testCharacteristic(rgb.host.hap.Characteristic.On)).toBe(true);
    expect(rgbLight.testCharacteristic(rgb.host.hap.Characteristic.Hue)).toBe(true);
    expect(rgbLight.testCharacteristic(rgb.host.hap.Characteristic.Saturation)).toBe(true);
    expect(rgbLight.testCharacteristic(rgb.host.hap.Characteristic.ColorTemperature)).toBe(false);
    expect(whiteLight.testCharacteristic(white.host.hap.Characteristic.Brightness)).toBe(true);
    expect(whiteLight.testCharacteristic(white.host.hap.Characteristic.ColorTemperature)).toBe(true);
    expect(whiteLight.testCharacteristic(white.host.hap.Characteristic.Hue)).toBe(false);
    expect(rgb.accessory.UUID).toBe(rgb.host.hap.uuid.generate('rgb'));
    await rgbLight.getCharacteristic(rgb.host.hap.Characteristic.On).handleSetRequest(false);
    expect(rgb.controlDevice).toHaveBeenCalledWith('rgb', { power: false }, 'hap');
  });

  test('C2 and C5 publish contact and motion transitions to HAP subscribers', async () => {
    const door = produce(device('door', 'SensorDo', { state: 'CLOSED' }));
    const motion = produce(device('motion', 'SensorMo', { motionDetected: false }));
    const contact = door.accessory.getService(door.host.hap.Service.ContactSensor)!
      .getCharacteristic(door.host.hap.Characteristic.ContactSensorState);
    const detected = motion.accessory.getService(motion.host.hap.Service.MotionSensor)!
      .getCharacteristic(motion.host.hap.Characteristic.MotionDetected);
    const contactEvents: unknown[] = [];
    const motionEvents: unknown[] = [];
    contact.on('change', change => contactEvents.push(change.newValue));
    detected.on('change', change => motionEvents.push(change.newValue));
    door.handler.updateDevice(device('door', 'SensorDo', { state: 'OPEN' }));
    motion.handler.updateDevice(device('motion', 'SensorMo', { motionDetected: true }));
    expect(await contact.handleGetRequest()).toBe(door.host.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    expect(await detected.handleGetRequest()).toBe(true);
    expect(contactEvents).toContain(door.host.hap.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED);
    expect(motionEvents).toContain(true);
  });

  test('C3 humidity source and a switch target expose the expected HAP characteristics', async () => {
    const sensor = produce(device('th', 'SensorTh2', { temperature: 23, humidity: 62 }));
    const relay = produce(device('relay', 'RelayController', { power: false }));
    const humidity = sensor.accessory.getService(sensor.host.hap.Service.HumiditySensor)!
      .getCharacteristic(sensor.host.hap.Characteristic.CurrentRelativeHumidity);
    const on = relay.accessory.getService(relay.host.hap.Service.Switch)!
      .getCharacteristic(relay.host.hap.Characteristic.On);
    expect(await humidity.handleGetRequest()).toBe(62);
    expect(on.props.perms).toContain('pw');
    await on.handleSetRequest(true);
    expect(relay.controlDevice).toHaveBeenCalledWith('relay', { power: true }, 'hap');
  });

  test('C4 selects measured current temperature and keeps target setpoint separate', async () => {
    const sensor = produce(device('temp', 'SensorTh2', { temperature: 21.5, humidity: 45 }));
    const measured = sensor.accessory.getService(sensor.host.hap.Service.TemperatureSensor)!
      .getCharacteristic(sensor.host.hap.Characteristic.CurrentTemperature);
    expect(await measured.handleGetRequest()).toBe(21.5);
    expect(sensor.accessory.getService(sensor.host.hap.Service.TemperatureSensor)!
      .testCharacteristic(sensor.host.hap.Characteristic.TargetTemperature)).toBe(false);
  });

  test('C2-C5 unavailable sensors return HAP failure and publish StatusFault', async () => {
    for (const [id, type, state, serviceType, characteristicType] of [
      ['door-missing', 'SensorDo', {}, 'ContactSensor', 'ContactSensorState'],
      ['motion-missing', 'SensorMo', {}, 'MotionSensor', 'MotionDetected'],
      ['humidity-missing', 'SensorTh2', {}, 'HumiditySensor', 'CurrentRelativeHumidity'],
      ['temperature-missing', 'SensorTh2', {}, 'TemperatureSensor', 'CurrentTemperature'],
    ] as const) {
      const item = produce(device(id, type, state));
      const service = item.accessory.getService(item.host.hap.Service[serviceType])!;
      await expect(service.getCharacteristic(item.host.hap.Characteristic[characteristicType])
        .handleGetRequest()).rejects.toBeDefined();
      expect(await service.getCharacteristic(item.host.hap.Characteristic.StatusFault)
        .handleGetRequest()).toBe(item.host.hap.Characteristic.StatusFault.GENERAL_FAULT);
    }
  });

  test('disconnected HAP sensors reject fresh reads despite a cached value', async () => {
    const item = produce(device('door-disconnected', 'SensorDo', { state: 'OPEN' }), false);
    const service = item.accessory.getService(item.host.hap.Service.ContactSensor)!;
    await expect(service.getCharacteristic(item.host.hap.Characteristic.ContactSensorState)
      .handleGetRequest()).rejects.toBeDefined();
    expect(await service.getCharacteristic(item.host.hap.Characteristic.StatusFault)
      .handleGetRequest()).toBe(item.host.hap.Characteristic.StatusFault.GENERAL_FAULT);
  });
});
