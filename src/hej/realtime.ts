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
    const parsed = JSON.parse(payload) as {
      deviceDataReport?: {
        devId: string;
        status?: Array<{ code: string; value: unknown }>;
      };
    };
    const report = parsed.deviceDataReport;
    if (!report?.devId) {
      this.events.onStatus?.('message.ignored', { reason: 'missing deviceDataReport.devId' });
      return;
    }

    const deviceState: Record<string, unknown> = {};
    for (const status of report.status ?? []) {
      switch (status.code) {
        case 'switch_led':
        case 'switch_power':
          deviceState.power = status.value;
          break;
        case 'switch': {
          deviceState.power = status.value;
          deviceState.state = status.value ? 'OPEN' : 'CLOSED';
          break;
        }
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
        case 'bright_value':
          if (typeof status.value === 'number') {
            deviceState.brightness = percentFromByte(status.value);
          }
          break;
        case 'temp_value':
          if (typeof status.value === 'number') {
            deviceState.temperature = percentFromByte(status.value);
          }
          break;
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
          deviceState.curPower = toNumber(status.value);
          break;
        case 'cur_current':
          deviceState.curCurrent = toNumber(status.value);
          break;
        case 'cur_voltage':
          deviceState.curVoltage = toNumber(status.value);
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
          deviceState.alarmSwitch = Boolean(status.value);
          break;
        case 'alarm_state':
          deviceState.alarm = status.value === 'alarm' || status.value === '1' || status.value === true;
          break;
      }
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

function decimalFromTenths(value: unknown): number {
  return Math.round(toNumber(value)) / 10;
}

function percentFromTenths(value: unknown): number {
  return Math.round(toNumber(value) / 10);
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
    return {
      hue: clamp(Number(parsed.h ?? 0), 0, 360),
      saturation: percentFromByte(Number(parsed.s ?? 0)),
      brightness: percentFromByte(Number(parsed.v ?? 0)),
    };
  } catch {
    return null;
  }
}

function percentFromByte(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.round(clamp(value, 0, 255) / 255 * 100);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
