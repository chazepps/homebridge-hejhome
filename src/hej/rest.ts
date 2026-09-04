import type { HejDevice, HejFamily, HejRoom, HejSession } from '../types.js';
import { GOQUAL_ORIGIN } from './auth.js';
import { sanitizeForLog } from '../utils/redact.js';

export const HEJ_VIRTUAL_FAMILY_ID = 1;
const HEJ_VIRTUAL_FAMILY_NAME = 'Hejhome';

export interface HejRestLogEvent {
  path: string;
  method: string;
  status: 'start' | 'success' | 'error';
  durationMs?: number;
  httpStatus?: number;
  message?: string;
}

export interface HejRestClientOptions {
  fetch?: typeof fetch;
  logger?: (event: HejRestLogEvent) => void;
  now?: () => number;
  requestTimeoutMs?: number;
}

export class HejRestClient {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: ((event: HejRestLogEvent) => void) | undefined;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly session: HejSession,
    options: HejRestClientOptions = {},
  ) {
    this.fetchImpl = options.fetch ?? fetch;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
  }

  async getFamilies(): Promise<HejFamily[]> {
    return familiesFromDevices(await this.listDevices());
  }

  async getRooms(familyId: number): Promise<HejRoom[]> {
    return roomsFromDevices(await this.listDevices(), familyId);
  }

  async getDevices(familyId: number, roomId?: number | 'all'): Promise<HejDevice[]> {
    const devices = await this.listDevices();
    return devices.filter((device) => {
      if (assignedFamilyId(device) !== familyId) {
        return false;
      }
      if (roomId === undefined || roomId === 'all') {
        return true;
      }
      return device.roomId === roomId;
    }).map((device) => ({
      ...device,
      familyId: assignedFamilyId(device),
    }));
  }

  async getCameraDevices(): Promise<unknown[]> {
    return this.request<unknown[]>('dashboard/devices/camera');
  }

  async getWebrtcConfig(deviceId: string): Promise<unknown> {
    return this.request<unknown>(`dashboard/webrtc/configs/${deviceId}`);
  }

  async createWebrtcAccessConfig(body: Record<string, unknown>): Promise<string> {
    return this.requestText('dashboard/webrtc/access-config', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  async controlDevice(deviceId: string, requirements: Record<string, unknown>): Promise<void> {
    await this.requestText(`openapi/control/${deviceId}`, {
      method: 'POST',
      body: JSON.stringify({ requirments: requirements }),
    });
  }

  private async listDevices(): Promise<HejDevice[]> {
    const text = await this.requestText('openapi/devices', { method: 'GET' });
    return normalizeOpenApiDevices(JSON.parse(text || 'null'));
  }

  private async request<T>(path: string): Promise<T> {
    const text = await this.requestText(path, { method: 'GET' });
    return JSON.parse(text || 'null') as T;
  }

  private async requestText(path: string, init: RequestInit): Promise<string> {
    const method = init.method ?? 'GET';
    const startedAt = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);

    this.emitLog({ path, method, status: 'start' });
    try {
      const response = await this.fetchImpl(`${GOQUAL_ORIGIN}/${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          authorization: `Bearer ${this.session.accessToken}`,
          'content-type': 'application/json;charset=UTF-8',
          cookie: `username=${this.session.usernameCookie}; autoLogin=true; JSESSIONID=${this.session.jsessionId}; accessToken=${this.session.accessToken}`,
          Referer: `${GOQUAL_ORIGIN}/`,
          'x-requested-with': 'XMLHttpRequest',
          ...init.headers,
        },
      });
      this.emitLog({
        path,
        method,
        status: 'success',
        durationMs: this.now() - startedAt,
        httpStatus: response.status,
      });
      if (!response.ok) {
        throw new Error(`Hejhome API request failed: ${response.status} ${path}`);
      }
      return response.text();
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      this.emitLog({
        path,
        method,
        status: 'error',
        durationMs: this.now() - startedAt,
        message: sanitizeForLog(isAbort
          ? `request timed out after ${this.requestTimeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error)),
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private emitLog(event: HejRestLogEvent): void {
    this.logger?.(event);
  }
}

function normalizeOpenApiDevices(payload: unknown): HejDevice[] {
  return unwrapDeviceList(payload)
    .map((entry) => normalizeDevice(entry))
    .filter((device): device is HejDevice => device !== null);
}

function unwrapDeviceList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) {
    return payload;
  }
  if (payload && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    for (const key of ['result', 'devices', 'data']) {
      if (Array.isArray(record[key])) {
        return record[key];
      }
    }
  }
  return [];
}

function normalizeDevice(raw: unknown): HejDevice | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  const entry = raw as Record<string, unknown>;
  const id = stringValue(entry.id) ?? stringValue(entry.deviceId) ?? stringValue(entry.devId);
  if (!id) {
    return null;
  }
  const familyId = numberValue(entry.familyId) ?? numberValue(entry.family_id);
  const roomId = numberValue(entry.roomId) ?? numberValue(entry.room_id);
  const device: HejDevice = {
    id,
    name: stringValue(entry.name) ?? id,
    deviceType: stringValue(entry.deviceType) ?? 'Unknown',
    modelName: stringValue(entry.modelName) ?? null,
    deviceState: isRecord(entry.deviceState) ? entry.deviceState : null,
  };
  if (typeof entry.hasSubDevices === 'boolean') {
    device.hasSubDevices = entry.hasSubDevices;
  }
  if (familyId !== undefined) {
    device.familyId = familyId;
  }
  const category = stringValue(entry.category);
  if (category) {
    device.category = category;
  }
  if (typeof entry.online === 'boolean') {
    device.online = entry.online;
  }
  if (roomId !== undefined) {
    device.roomId = roomId;
  }
  return device;
}

function familiesFromDevices(devices: HejDevice[]): HejFamily[] {
  const families = new Map<number, HejFamily>();
  for (const device of devices) {
    const familyId = assignedFamilyId(device);
    if (!families.has(familyId)) {
      families.set(familyId, {
        familyId,
        name: familyId === HEJ_VIRTUAL_FAMILY_ID && device.familyId === undefined
          ? HEJ_VIRTUAL_FAMILY_NAME
          : `Home ${familyId}`,
      });
    }
  }
  if (families.size === 0) {
    return [{ familyId: HEJ_VIRTUAL_FAMILY_ID, name: HEJ_VIRTUAL_FAMILY_NAME }];
  }
  return [...families.values()];
}

function roomsFromDevices(devices: HejDevice[], familyId: number): HejRoom[] {
  const rooms = new Map<number, HejRoom>();
  for (const device of devices) {
    if (assignedFamilyId(device) !== familyId || typeof device.roomId !== 'number') {
      continue;
    }
    if (!rooms.has(device.roomId)) {
      rooms.set(device.roomId, {
        room_id: device.roomId,
        name: `Room ${device.roomId}`,
      });
    }
  }
  return [...rooms.values()];
}

function assignedFamilyId(device: HejDevice): number {
  return typeof device.familyId === 'number' && Number.isFinite(device.familyId)
    ? device.familyId
    : HEJ_VIRTUAL_FAMILY_ID;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
