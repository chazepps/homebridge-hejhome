import mqtt, { type MqttClient } from 'mqtt';

import type { HejDevice, HejSession } from '../types.js';
import { HEJ_CLIENT_ID, HEJ_CLIENT_SECRET } from './auth.js';

export interface HejRealtimeEvents {
  onDeviceUpdate(device: Partial<HejDevice> & { id: string }): void;
  onError(error: Error): void;
  onStatus?(event: string, data?: Record<string, unknown>): void;
}

export class HejRealtimeClient {
  private client: MqttClient | null = null;

  constructor(
    private readonly session: HejSession,
    private readonly events: HejRealtimeEvents,
  ) {}

  connect(): void {
    this.events.onStatus?.('connect.start', { url: 'ws://mqtt.hej.so:15675/ws' });
    this.client = mqtt.connect('ws://mqtt.hej.so:15675/ws', {
      username: HEJ_CLIENT_ID,
      password: HEJ_CLIENT_SECRET,
      keepalive: 30,
      reconnectPeriod: 30_000,
      connectTimeout: 10_000,
    });

    this.client.on('connect', () => {
      const topic = `custom.${this.topicIdentifier()}.*`;
      this.events.onStatus?.('connect.success', { topic });
      this.client?.subscribe(topic, { qos: 1 }, (error) => {
        if (error) {
          this.events.onStatus?.('subscribe.error', { topic, message: error.message });
          this.events.onError(error);
          return;
        }
        this.events.onStatus?.('subscribe.success', { topic, qos: 1 });
      });
    });

    this.client.on('message', (_topic, payload) => {
      this.events.onStatus?.('message.received', { topic: _topic, bytes: payload.byteLength });
      this.handleMessage(payload.toString('utf8'));
    });

    this.client.on('error', (error) => {
      this.events.onStatus?.('connect.error', { message: error.message });
      this.events.onError(error);
    });

    this.client.on('close', () => {
      this.events.onStatus?.('connect.closed');
    });

    this.client.on('reconnect', () => {
      this.events.onStatus?.('connect.reconnect');
    });
  }

  disconnect(): void {
    this.events.onStatus?.('disconnect');
    this.client?.end(true);
    this.client = null;
  }

  private topicIdentifier(): string {
    return decodeURIComponent(this.session.usernameCookie).replace(/\./g, '-');
  }

  private handleMessage(payload: string): void {
    const report = parseDeviceReport(payload);
    if (!report) {
      this.events.onStatus?.('message.ignored', { reason: 'invalid-report' });
      return;
    }

    const deviceState: Record<string, unknown> = {};
    try {
      for (const status of report.status) {
        switch (status.code) {
          case 'switch_led':
          case 'switch_power':
            deviceState.power = status.value;
            break;
          case 'switch': {
            const power = booleanReport(status.value);
            deviceState.power = power;
            if (power !== null) {
              deviceState.state = power ? 'OPEN' : 'CLOSED';
            }
            break;
          }
          case 'door_opened':
            deviceState.doorOpened = typeof status.value === 'boolean' ? status.value : null;
            break;
          case 'prm_switch':
            deviceState.state = status.value ? 'OPEN' : 'CLOSED';
            break;
          case 'switch_usb1':
            deviceState.power4 = status.value;
            break;
          default: {
            const powerKey = parseSwitchPowerKey(status.code);
            if (powerKey) {
              deviceState[powerKey] = status.value;
              break;
            }
            deviceState[status.code] = status.value;
            break;
          }
          case 'bright_value': {
            const value = lightReportPercent(status.value, 25);
            if (value !== null) {
              deviceState.brightness = value;
            }
            break;
          }
          case 'temp_value': {
            const value = lightReportPercent(status.value, 0);
            if (value !== null) {
              deviceState.temperature = value;
            }
            break;
          }
          case 'work_mode':
            deviceState.lightMode = parseLightMode(status.value);
            break;
          case 'scene_data':
            deviceState.sceneValues = String(status.value ?? '');
            break;
          case 'colour_data': {
            const hsvColor = parseColourData(status.value);
            if (hsvColor) {
              deviceState.hsvColor = hsvColor;
            }
            break;
          }
          case 'pir': {
            if (status.value !== 'pir' && status.value !== 'none') {
              break;
            }
            const motionDetected = status.value === 'pir';
            deviceState.motionDetected = motionDetected;
            if (motionDetected) {
              deviceState.lastMotionAt = Date.now();
            }
            break;
          }
          case 'percent_state':
            deviceState.percentState = toNumberOrValue(status.value);
            break;
          case 'percent_control':
            deviceState.percentControl = toNumberOrValue(status.value);
            break;
          case 'control':
            deviceState.control = String(status.value ?? '');
            break;
          case 'wind':
            deviceState.fanSpeed = toNumberOrValue(status.value);
            break;
          case 'temp':
            deviceState.temperature = toNumberOrValue(status.value);
            break;
          case 'cur_power':
            deviceState.curPower = toMeterNumber(status.value);
            break;
          case 'cur_current':
            deviceState.curCurrent = toMeterNumber(status.value);
            break;
          case 'cur_voltage':
            deviceState.curVoltage = toMeterNumber(status.value);
            break;
          case 'va_temperature':
          case 'prm_temperature':
            deviceState.temperature = decimalFromTenths(status.value);
            break;
          case 'va_humidity':
          case 'prm_content':
            deviceState.humidity = percentFromTenths(status.value);
            break;
          case 'battery':
            deviceState.battery = toNumber(status.value);
            break;
          case 'alarm_switch':
            deviceState.alarmSwitch = booleanReport(status.value);
            break;
          case 'alarm_state':
            deviceState.alarm = status.value === 'alarm' ? true : booleanReport(status.value);
            break;
        }
      }
    } catch {
      // Reject the entire report; malformed values must never escape the MQTT message boundary.
      this.events.onStatus?.('message.ignored', { reason: 'invalid-values' });
      return;
    }

    this.events.onStatus?.('device.update', {
      deviceId: report.devId,
      stateKeys: Object.keys(deviceState),
    });
    this.events.onDeviceUpdate({
      id: report.devId,
      deviceState,
    });
  }
}

function parseSwitchPowerKey(code: string): `power${number}` | null {
  const match = /^switch_(\d+)$/.exec(code);
  if (!match?.[1]) {
    return null;
  }
  return `power${Number(match[1])}`;
}

function toNumber(value: unknown): number {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : 0;
}

function toNumberOrValue(value: unknown): number | string {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : String(value ?? '');
}

function decimalFromTenths(value: unknown): number | null {
  const numeric = finiteReportNumber(value);
  return numeric === null ? null : Math.round(numeric) / 10;
}

function percentFromTenths(value: unknown): number | null {
  const numeric = finiteReportNumber(value);
  return numeric === null || numeric < 0 || numeric > 1000 ? null : Math.round(numeric / 10);
}

function finiteReportNumber(value: unknown): number | null {
  if (typeof value !== 'number' && (typeof value !== 'string' || value.trim() === '')) {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function parseLightMode(value: unknown): 'WHITE' | 'COLOR' | 'SCENE' | undefined {
  switch (String(value ?? '').toLowerCase()) {
    case 'white':
      return 'WHITE';
    case 'colour':
    case 'color':
      return 'COLOR';
    case 'scene':
      return 'SCENE';
    default:
      return undefined;
  }
}

function parseColourData(
  value: unknown,
): { hue: number; saturation: number; brightness: number } | null {
  try {
    const parsed = typeof value === 'string'
      ? JSON.parse(value) as { h?: unknown; s?: unknown; v?: unknown }
      : value as { h?: unknown; s?: unknown; v?: unknown };
    if (!parsed || typeof parsed !== 'object') {
      return null;
    }
    const saturation = lightReportPercent(parsed.s, 25);
    const brightness = lightReportPercent(parsed.v, 25);
    if (typeof parsed.h !== 'number' || !Number.isFinite(parsed.h) || parsed.h < 0 || parsed.h > 360
      || saturation === null || brightness === null) {
      return null;
    }
    return { hue: parsed.h, saturation, brightness };
  } catch {
    return null;
  }
}

/** Vendor liveEvent.js uses a 230-step scale, with a 25 offset for brightness and HSV S/V.
 * REST state is already normalized and never passes through this conversion.
 */
function lightReportPercent(value: unknown, offset: 0 | 25): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < offset || value > offset + 230) {
    return null;
  }
  return Math.round((value - offset) * 100 / 230);
}

function toMeterNumber(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') {
    return null;
  }
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function booleanReport(value: unknown): boolean | null {
  if (value === true || value === 'true' || value === 1 || value === '1') {
    return true;
  }
  if (value === false || value === 'false' || value === 0 || value === '0') {
    return false;
  }
  return null;
}

interface DeviceReport {
  devId: string;
  status: Array<{ code: string; value: unknown }>;
}

/** Local resource limits, not vendor protocol limits: 256 KiB and 256 datapoints per report. */
function parseDeviceReport(payload: string): DeviceReport | null {
  if (Buffer.byteLength(payload, 'utf8') > 256 * 1024) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(payload);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || !isRecord(parsed.deviceDataReport)) {
    return null;
  }
  const report = parsed.deviceDataReport;
  if (typeof report.devId !== 'string' || !report.devId.trim() || report.devId.length > 512
    || !Array.isArray(report.status) || report.status.length > 256) {
    return null;
  }
  for (const item of report.status) {
    if (!isRecord(item) || typeof item.code !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,127}$/.test(item.code)
      || item.code in Object.prototype || item.code === 'prototype' || !Object.hasOwn(item, 'value')) {
      return null;
    }
  }
  return { devId: report.devId, status: report.status as DeviceReport['status'] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
