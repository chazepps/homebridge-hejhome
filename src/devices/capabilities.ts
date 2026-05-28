export type DeviceSupportStatus = 'supported' | 'partial' | 'deferred' | 'unsupported';

export type DeviceServiceKind =
  | 'color-light'
  | 'white-light'
  | 'multi-switch'
  | 'relay-switch'
  | 'outlet'
  | 'power-strip'
  | 'window-covering'
  | 'motion-sensor'
  | 'contact-sensor'
  | 'temperature-humidity-sensor'
  | 'leak-sensor'
  | 'smoke-sensor'
  | 'stateless-button'
  | 'ir-switch'
  | 'ir-thermostat'
  | 'ir-fan'
  | 'camera'
  | 'unsupported';

export interface DeviceCapability {
  deviceType: string;
  label: string;
  serviceKind: DeviceServiceKind;
  supportStatus: DeviceSupportStatus;
  homeKitServices: string[];
  note?: string;
}

export interface SupportedDeviceModel {
  deviceType: string;
  label: string;
  homeKitService: string;
  homeKitServices: string[];
  supportStatus: DeviceSupportStatus;
  note?: string;
}

const COLOR_LIGHT_TYPES = [
  'LightRgbw5',
  'LightRgbw4',
  'LightRgbw3',
  'LightRgbw2',
  'LightRgbw1',
  'LightRgb5',
  'LightRgb4',
  'LedStripRgbw2',
  'LedStripRgbw1',
  'LedStripRgb',
];

const WHITE_LIGHT_TYPES = ['LightWw3', 'LightWw2', 'LightWw1'];
const SWITCH_TYPES = ['Switch1', 'Switch2', 'Switch3', 'Switch4', 'Switch5', 'Switch6', 'ZigbeeSwitch1', 'ZigbeeSwitch2', 'ZigbeeSwitch3'];
const RELAY_TYPES = ['Relay', 'RelayController', 'RelayController2', 'RelayControllerDc', 'RelayControllerDc2'];
const PLUG_TYPES = ['Plug', 'SmartPlug', 'BruntPlug'];
const POWER_STRIP_TYPES = ['PowerStrip', 'PowerStrip2'];
const WINDOW_COVERING_TYPES = ['Curtain', 'Blind', 'Blind2'];
const MOTION_TYPES = ['SensorMo', 'SensorRadar'];
const CONTACT_TYPES = ['SensorDo'];
const TEMPERATURE_HUMIDITY_TYPES = ['SensorTh', 'SensorTh2', 'SensorRefTh', 'SensorRefTh2'];
const LEAK_TYPES = ['SensorWater2', 'SensorWater3'];
const SMOKE_TYPES = ['SensorSmoke3', 'SensorSmoke4'];
const BUTTON_TYPES = ['SmartButton'];
const IR_SWITCH_TYPES = ['IrTv', 'IrSettopbox', 'IrProjector', 'IrLamp', 'IrSpeaker', 'IrDvd', 'IrTvbox', 'IrCamera', 'IrDIY'];
const IR_THERMOSTAT_TYPES = ['IrAirconditioner'];
const IR_FAN_TYPES = ['IrFan'];
const CAMERA_TYPES = ['HomeCamera', 'HomeCameraPro', 'HomeCameraProPlus'];
const PARTIAL_SENSOR_TYPES = ['AudibleAlarm', 'SensorGas2', 'SensorWater', 'SensorSmoke', 'SensorSos', 'Siren', 'SmartDoorLock', 'ZigbeeDoorlock'];
const PARTIAL_AIR_TYPES = ['Airpurifier', 'IrAirpurifier'];

export const EXAMPLE_DEVICE_TYPES = [
  ...COLOR_LIGHT_TYPES,
  ...WHITE_LIGHT_TYPES,
  ...SWITCH_TYPES,
  ...RELAY_TYPES,
  ...PLUG_TYPES,
  ...POWER_STRIP_TYPES,
  ...WINDOW_COVERING_TYPES,
  ...MOTION_TYPES,
  ...CONTACT_TYPES,
  ...TEMPERATURE_HUMIDITY_TYPES,
  ...LEAK_TYPES,
  ...SMOKE_TYPES,
  ...BUTTON_TYPES,
  ...IR_SWITCH_TYPES,
  ...IR_THERMOSTAT_TYPES,
  ...IR_FAN_TYPES,
  ...CAMERA_TYPES,
  ...PARTIAL_SENSOR_TYPES,
  ...PARTIAL_AIR_TYPES,
].sort((a, b) => a.localeCompare(b));

const CAPABILITIES = new Map<string, DeviceCapability>();

register(COLOR_LIGHT_TYPES, {
  label: 'RGB 조명',
  serviceKind: 'color-light',
  supportStatus: 'supported',
  homeKitServices: ['Lightbulb'],
});
register(WHITE_LIGHT_TYPES, {
  label: '색온도 조명',
  serviceKind: 'white-light',
  supportStatus: 'supported',
  homeKitServices: ['Lightbulb'],
});
register(SWITCH_TYPES, {
  label: '스위치',
  serviceKind: 'multi-switch',
  supportStatus: 'supported',
  homeKitServices: ['Switch'],
});
register(RELAY_TYPES, {
  label: '릴레이',
  serviceKind: 'relay-switch',
  supportStatus: 'supported',
  homeKitServices: ['Switch'],
});
register(PLUG_TYPES, {
  label: '플러그',
  serviceKind: 'outlet',
  supportStatus: 'supported',
  homeKitServices: ['Outlet'],
});
register(POWER_STRIP_TYPES, {
  label: '멀티탭',
  serviceKind: 'power-strip',
  supportStatus: 'supported',
  homeKitServices: ['Outlet'],
});
register(WINDOW_COVERING_TYPES, {
  label: '커튼/블라인드',
  serviceKind: 'window-covering',
  supportStatus: 'supported',
  homeKitServices: ['WindowCovering'],
});
register(MOTION_TYPES, {
  label: '모션 센서',
  serviceKind: 'motion-sensor',
  supportStatus: 'supported',
  homeKitServices: ['MotionSensor', 'BatteryService'],
});
register(CONTACT_TYPES, {
  label: '문 열림 센서',
  serviceKind: 'contact-sensor',
  supportStatus: 'supported',
  homeKitServices: ['ContactSensor', 'BatteryService'],
});
register(TEMPERATURE_HUMIDITY_TYPES, {
  label: '온습도 센서',
  serviceKind: 'temperature-humidity-sensor',
  supportStatus: 'supported',
  homeKitServices: ['TemperatureSensor', 'HumiditySensor', 'BatteryService'],
});
register(LEAK_TYPES, {
  label: '누수 센서',
  serviceKind: 'leak-sensor',
  supportStatus: 'supported',
  homeKitServices: ['LeakSensor', 'BatteryService'],
});
register(SMOKE_TYPES, {
  label: '연기 센서',
  serviceKind: 'smoke-sensor',
  supportStatus: 'supported',
  homeKitServices: ['SmokeSensor', 'BatteryService'],
});
register(BUTTON_TYPES, {
  label: '스마트 버튼',
  serviceKind: 'stateless-button',
  supportStatus: 'supported',
  homeKitServices: ['StatelessProgrammableSwitch', 'BatteryService'],
});
register(IR_SWITCH_TYPES, {
  label: 'IR 리모컨 장비',
  serviceKind: 'ir-switch',
  supportStatus: 'partial',
  homeKitServices: ['Switch'],
  note: '전원처럼 의미가 명확한 명령만 지원합니다.',
});
register(IR_THERMOSTAT_TYPES, {
  label: 'IR 에어컨',
  serviceKind: 'ir-thermostat',
  supportStatus: 'partial',
  homeKitServices: ['Thermostat'],
  note: '전원, 온도, 운전 모드만 보수적으로 지원합니다.',
});
register(IR_FAN_TYPES, {
  label: 'IR 선풍기',
  serviceKind: 'ir-fan',
  supportStatus: 'partial',
  homeKitServices: ['Fan'],
  note: '전원과 바람 세기만 보수적으로 지원합니다.',
});
register(CAMERA_TYPES, {
  label: '홈 카메라',
  serviceKind: 'camera',
  supportStatus: 'deferred',
  homeKitServices: ['Camera'],
  note: '카메라는 API 분석 완료, Home 앱 영상 연동은 다음 단계입니다.',
});
register(PARTIAL_SENSOR_TYPES, {
  label: '센서/알림 장비',
  serviceKind: 'unsupported',
  supportStatus: 'partial',
  homeKitServices: [],
  note: 'HomeKit 의미가 명확한 상태값을 추가 확인한 뒤 지원합니다.',
});
register(PARTIAL_AIR_TYPES, {
  label: '공기 관리 장비',
  serviceKind: 'unsupported',
  supportStatus: 'partial',
  homeKitServices: [],
  note: '전원과 모드 상태는 확인됐지만 HomeKit 매핑은 추가 검증이 필요합니다.',
});

export function getDeviceCapability(deviceType: string): DeviceCapability | undefined {
  return CAPABILITIES.get(deviceType);
}

export function getSupportedDeviceModels(): SupportedDeviceModel[] {
  return [...CAPABILITIES.values()]
    .filter((capability) => capability.supportStatus !== 'unsupported')
    .sort((a, b) => a.deviceType.localeCompare(b.deviceType))
    .map((capability) => {
      const model: SupportedDeviceModel = {
        deviceType: capability.deviceType,
        label: capability.label,
        homeKitService: capability.homeKitServices[0] ?? '',
        homeKitServices: capability.homeKitServices,
        supportStatus: capability.supportStatus,
      };
      if (capability.note !== undefined) {
        model.note = capability.note;
      }
      return model;
    });
}

export function isFullySupportedDeviceType(deviceType: string): boolean {
  return getDeviceCapability(deviceType)?.supportStatus === 'supported';
}

function register(
  deviceTypes: string[],
  capability: Omit<DeviceCapability, 'deviceType'>,
): void {
  for (const deviceType of deviceTypes) {
    CAPABILITIES.set(deviceType, {
      deviceType,
      ...capability,
    });
  }
}
