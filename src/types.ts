import type { PlatformConfig } from 'homebridge';

export interface HejhomePlatformConfig extends PlatformConfig {
  name?: string;
  auth?: {
    identifier?: string;
    sessionConfigured?: boolean;
  };
  scope?: {
    mode?: 'first-family' | 'all' | 'custom';
    includedFamilyIds?: number[];
    includedRoomsByFamilyId?: Record<string, number[]>;
  };
  debug?: boolean;
}

export interface HejSession {
  identifier: string;
  autoLogin: true;
  accessToken: string;
  jsessionId: string;
  usernameCookie: string;
  expiresAt: number;
}

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
  power3?: boolean;
  power4?: boolean;
  power5?: boolean;
  power6?: boolean;
  battery?: number;
  motionDetected?: boolean;
  lastMotionAt?: number;
  temperature?: number | string;
  humidity?: number;
  state?: 'OPEN' | 'CLOSED' | string;
  doorOpened?: boolean;
  percentState?: number | string;
  percentControl?: number | string;
  control?: 'open' | 'close' | string;
  workState?: string;
  fanSpeed?: number | string | boolean;
  mode?: number | string;
  curPower?: number;
  curCurrent?: number;
  curVoltage?: number;
  alarm?: boolean;
  alarmSwitch?: boolean;
  pm25?: string | number;
  [key: string]: unknown;
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
    | 'SensorTh2'
    | 'SensorDo'
    | 'SensorRefTh'
    | 'SensorRefTh2'
    | 'RelayController'
    | string;
  hasSubDevices?: boolean;
  modelName?: string | null;
  familyId?: number;
  category?: string;
  deviceState?: HejDeviceState | null;
  online?: boolean;
  roomId?: number;
}

export interface HejFamily {
  familyId: number;
  name: string;
}

export interface HejRoom {
  room_id: number;
  name: string;
}
