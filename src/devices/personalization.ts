import type { HejDevice } from '../types.js';
import { getDeviceCapability } from './capabilities.js';

export interface FavoriteChannel { id: string; name: string; channel: number }
export interface Personalization {
  favoriteChannels?: FavoriteChannel[];
  purifierModeButtons?: boolean;
  channelNames?: Record<string, string>;
}

export function normalizePersonalization(value: Record<string, unknown>): Personalization {
  const result: Personalization = {};
  if (value.purifierModeButtons !== undefined) {
    if (typeof value.purifierModeButtons !== 'boolean') {
      throw new Error('Purifier mode buttons must be enabled or disabled.');
    }
    result.purifierModeButtons = value.purifierModeButtons;
  }
  if (value.favoriteChannels !== undefined) {
    if (!Array.isArray(value.favoriteChannels) || value.favoriteChannels.length > 8) {
      throw new Error('Favorite channels must be a list of at most 8 entries.');
    }
    const ids = new Set<string>();
    result.favoriteChannels = value.favoriteChannels.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('Invalid favorite channel.');
      }
      const entry = raw as Record<string, unknown>;
      if (Object.keys(entry).some((key) => !['id', 'name', 'channel'].includes(key))
        || typeof entry.id !== 'string' || !/^[a-z0-9][a-z0-9-]{0,23}$/.test(entry.id) || ids.has(entry.id)
        || typeof entry.name !== 'string' || !entry.name.trim() || entry.name.trim().length > 32
        || typeof entry.channel !== 'number' || !Number.isInteger(entry.channel) || entry.channel < 0 || entry.channel > 999) {
        throw new Error('Favorite channels need unique stable IDs, names of 1–32 characters and whole channels from 0 to 999.');
      }
      ids.add(entry.id);
      return { id: entry.id, name: entry.name.trim(), channel: entry.channel };
    });
  }
  if (value.channelNames !== undefined) {
    if (!value.channelNames || typeof value.channelNames !== 'object' || Array.isArray(value.channelNames)) {
      throw new Error('Port names must be an object.');
    }
    result.channelNames = {};
    for (const [key, name] of Object.entries(value.channelNames)) {
      if (!/^power[1-6]$/.test(key) || typeof name !== 'string' || !name.trim() || name.trim().length > 64) {
        throw new Error('Port names need power1–power6 keys and names of 1–64 characters.');
      }
      result.channelNames[key] = name.trim();
    }
  }
  return result;
}

/** Only metadata: this never creates additional device channels. */
export function nameablePowerChannels(device: Pick<HejDevice, 'deviceType' | 'deviceState'>): string[] {
  const kind = getDeviceCapability(device.deviceType)?.serviceKind;
  if (kind === 'multi-switch') {
    const count = Number(/Switch(\d+)/.exec(device.deviceType)?.[1] ?? 1);
    return Array.from({ length: count }, (_, index) => `power${index + 1}`);
  }
  if (kind === 'power-strip') {
    return ['power1', 'power2', 'power3', 'power4',
      ...(Object.hasOwn(device.deviceState ?? {}, 'power6') ? ['power6'] : [])];
  }
  return [];
}

export function validateDevicePersonalization(
  device: Pick<HejDevice, 'deviceType' | 'deviceState'>,
  preference: Personalization & { visibility?: string },
): void {
  const favorites = preference.favoriteChannels?.length;
  if (favorites && !['IrTv', 'IrSettopbox'].includes(device.deviceType)) {
    throw new Error('즐겨찾기 채널은 TV·셋톱박스에서만 사용할 수 있습니다. / Favorite channels require a TV or set-top box.');
  }
  if (preference.purifierModeButtons && device.deviceType !== 'Airpurifier') {
    throw new Error('모드 버튼은 지원 공기청정기에서만 사용할 수 있습니다. / Mode buttons require a supported air purifier.');
  }
  const allowed = nameablePowerChannels(device);
  // A cached secondary USB port can temporarily omit its report. Keep its name.
  if (getDeviceCapability(device.deviceType)?.serviceKind === 'power-strip') {
    allowed.push('power6');
  }
  if (Object.keys(preference.channelNames ?? {}).some((key) => !allowed.includes(key))) {
    throw new Error('이 장치에서 지원하지 않는 포트 이름입니다. / Port names must refer to supported channels.');
  }
}
