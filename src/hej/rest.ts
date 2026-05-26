import type { HejDevice, HejFamily, HejRoom, HejSession } from '../types.js';
import { sanitizeForLog } from '../utils/redact.js';

const SQUARE_ORIGIN = 'https://square.hej.so';

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

interface FamilyListResponse {
  result: HejFamily[];
}

interface RoomListResponse {
  result: {
    rooms: HejRoom[];
  };
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
    const response = await this.request<FamilyListResponse>('dashboard/family');
    return response.result;
  }

  async getRooms(familyId: number): Promise<HejRoom[]> {
    const response = await this.request<RoomListResponse>(`dashboard/rooms/${familyId}`);
    return response.result.rooms;
  }

  async getDevices(familyId: number, roomId?: number | 'all'): Promise<HejDevice[]> {
    const roomSegment = roomId === undefined ? '' : `/room/${roomId}`;
    return this.request<HejDevice[]>(`dashboard/${familyId}${roomSegment}/devices-state?scope=shop`);
  }

  async controlDevice(deviceId: string, requirements: Record<string, unknown>): Promise<void> {
    await this.requestText(`dashboard/control/${deviceId}`, {
      method: 'POST',
      body: JSON.stringify({ requirments: requirements }),
    });
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
      const response = await this.fetchImpl(`${SQUARE_ORIGIN}/${path}`, {
        ...init,
        signal: controller.signal,
        headers: {
          accept: 'application/json, text/javascript, */*; q=0.01',
          authorization: `Bearer ${this.session.accessToken}`,
          'content-type': 'application/json;charset=UTF-8',
          cookie: `username=${this.session.usernameCookie}; autoLogin=true; JSESSIONID=${this.session.jsessionId}; accessToken=${this.session.accessToken}`,
          Referer: `${SQUARE_ORIGIN}/list`,
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
