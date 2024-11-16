import { HejhomePlatform } from '../platform.js';
import { hejRequest } from './request.js';

export const getDevices = async (
  platform: HejhomePlatform,
  familyId: number,
  roomId?: number,
) => {
  const path = roomId
    ? `dashboard/${familyId}/room/${roomId}/devices-state?scope=shop`
    : `dashboard/${familyId}/devices-state?scope=shop`;

  return hejRequest<null, HejDevices>(platform, 'GET', path);
};

export interface HejDeviceState {
  power?: boolean;
  lightMode?: 'WHITE' | 'COLOR' | 'SCENE';
  hsvColor?: {
    hue: number;
    saturation: number;
    brightness: number;
  };
  brightness?: number;
  sceneValues?: string;
  power1?: boolean;
  power2?: boolean;
  battery?: number;
}

export interface HejDevice {
  id: string;
  name: string;
  deviceType:
  | 'LightRgbw5'
  | 'ZigbeeSwitch1'
  | 'ZigbeeSwitch2'
  | 'IrFan'
  | 'IrTv'
  | 'SensorMo'
  | 'LedStripRgbw2'
  | 'SmartButton'
  | 'SensorTh'
  | 'RelayController';
  hasSubDevices: boolean;
  modelName: string | null;
  familyId: number;
  category: string;
  deviceState: HejDeviceState | null;
  online: boolean;
  roomId?: number;
}

type HejDevices = HejDevice[];
