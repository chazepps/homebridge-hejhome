import type { Device, DevicePreference, Translate } from '../../core/types';
import { getDeviceCapability } from '../../../../src/devices/capabilities';

export const sensorTypes = new Set(['SensorTh', 'SensorTh2', 'SensorRefTh', 'SensorRefTh2']);
export const remoteTypes = new Set(['IrTv', 'IrSettopbox', 'IrFan']);

export interface DeviceEditorValue {
  name: string;
  visibility: NonNullable<DevicePreference['visibility']>;
  role: NonNullable<DevicePreference['role']>;
  temperatureSensorId: string;
  freshnessMinutes: string;
  remoteButtons: boolean;
  pm25Multiplier: string;
}

export function editorValue(preference: DevicePreference = {}): DeviceEditorValue {
  return {
    name: preference.name ?? '', visibility: preference.visibility ?? 'both', role: preference.role ?? 'original',
    temperatureSensorId: preference.temperatureSensorId ?? '', freshnessMinutes: String(preference.freshnessMinutes ?? ''),
    remoteButtons: preference.remoteButtons ?? false, pm25Multiplier: String(preference.pm25Multiplier ?? ''),
  };
}

export function serializePreference(
  value: DeviceEditorValue, device: Device, devices: Device[], t: Translate = (ko) => ko,
): DevicePreference {
  const preference: DevicePreference = {};
  const invalid = (ko: string, en: string): never => {
    throw new Error(t(ko, en));
  };
  if (!['both', 'homekit', 'matter', 'hidden'].includes(value.visibility)) {
    invalid('연결 방식을 확인해 주세요.', 'Choose a valid connection.');
  }
  if (value.visibility !== 'both') {
    preference.visibility = value.visibility;
  }
  if (value.name.trim().length > 64) {
    invalid('표시 이름은 64자 이내로 입력해 주세요.', 'Use 64 characters or fewer for the display name.');
  }
  if (value.name.trim()) {
    preference.name = value.name.trim();
  }
  if (!['original', 'light', 'outlet', 'switch'].includes(value.role)
    || value.role !== 'original' && !device.roleChangeSupported) {
    invalid('이 장치는 표시 형태를 변경할 수 없습니다.', 'This device does not support that appearance.');
  }
  if (value.role !== 'original') {
    preference.role = value.role;
  }
  if (value.temperatureSensorId) {
    const sensor = devices.find((item) => item.id === value.temperatureSensorId && sensorTypes.has(item.deviceType));
    if (device.deviceType !== 'IrAirconditioner' || !sensor) {
      invalid('선택한 온도계를 사용할 수 없습니다. 온도계를 다시 선택해 주세요.', 'The selected thermometer is unavailable. Choose it again.');
    }
    preference.temperatureSensorId = value.temperatureSensorId;
  }
  if (value.remoteButtons) {
    if (!remoteTypes.has(device.deviceType) || ['matter', 'hidden'].includes(value.visibility)) {
      invalid('이 연결 방식에는 Apple Home 리모컨 버튼을 표시할 수 없습니다.', 'Remote buttons require an Apple Home connection.');
    }
    preference.remoteButtons = true;
  }
  if (value.pm25Multiplier.trim()) {
    const multiplier = Number(value.pm25Multiplier);
    if (device.deviceType !== 'Airpurifier' || !Number.isFinite(multiplier) || multiplier <= 0) {
      invalid('PM2.5 보정 배율은 0보다 큰 숫자로 입력해 주세요.', 'Enter a PM2.5 correction factor greater than zero.');
    }
    preference.pm25Multiplier = multiplier;
  }
  if (value.freshnessMinutes.trim()) {
    const minutes = Number(value.freshnessMinutes);
    if (!Number.isInteger(minutes) || minutes < 5 || minutes > 1440) {
      invalid('측정값 유효 시간은 5분부터 1440분까지의 정수로 입력해 주세요.', 'Enter a whole number from 5 to 1440 minutes.');
    }
    if (!sensorTypes.has(device.deviceType) && !device.meterProfileApplied
      && !(device.deviceType === 'Airpurifier' && preference.pm25Multiplier !== undefined)) {
      invalid('이 장치에는 측정값 유효 시간을 설정할 수 없습니다.', 'Measurement validity is unavailable for this device.');
    }
    preference.freshnessMinutes = minutes;
  }
  return preference;
}

export function deviceNeedsAttention(device: Device, fresh: boolean, session: string | undefined, matterEnabled: boolean): boolean {
  if (!fresh || session !== 'valid' || device.online !== true || !device.lastSeenAt || device.lastControl === 'failed') {
    return true;
  }
  const visibility = device.preference?.visibility ?? 'both';
  if (visibility === 'hidden') {
    return false;
  }
  return visibility !== 'matter' && !device.homekit
    || visibility !== 'homekit' && matterEnabled && !device.matter;
}

const catalogLabels: Record<string, string> = {
  'RGB 조명': 'RGB light', '색온도 조명': 'White light', '스위치': 'Switch', '릴레이': 'Relay',
  '플러그': 'Plug', '멀티탭': 'Power strip', '커튼/블라인드': 'Curtain / blind', '모션 센서': 'Motion sensor',
  '레이더 센서': 'Radar sensor', '문 열림 센서': 'Door sensor', '온습도 센서': 'Temperature & humidity sensor',
  '누수 센서': 'Leak sensor', '연기 센서': 'Smoke sensor', '스마트 버튼': 'Smart button', '도어락 문 열림': 'Door-lock contact sensor',
  'IR 리모컨 장비': 'IR remote device', 'IR 에어컨': 'IR air conditioner', 'IR 선풍기': 'IR fan', '홈 카메라': 'Home camera',
  '공기청정기 전원': 'Air purifier power', '센서/알림 장비': 'Sensor / alarm device', '공기 관리 장비': 'Air care device',
};

export function deviceKind(device: Device, t: Translate): string {
  const types: Record<string, [string, string]> = {
    IrTv: ['TV 리모컨', 'TV remote'], IrSettopbox: ['셋톱박스 리모컨', 'Set-top box remote'],
    IrFan: ['선풍기 리모컨', 'Fan remote'], IrAirconditioner: ['에어컨', 'Air conditioner'],
    Airpurifier: ['공기청정기', 'Air purifier'], ZigbeeDoorlock: ['문 열림 센서', 'Door sensor'],
  };
  const named = types[device.deviceType];
  if (named) {
    return t(...named);
  }
  const capability = getDeviceCapability(device.deviceType);
  return capability ? t(capability.label, catalogLabels[capability.label] ?? device.deviceType) : t('장치', 'Device');
}

export function deviceSearchText(device: Device, t: Translate): string {
  const capability = getDeviceCapability(device.deviceType);
  const category = capability ? t(capability.label, catalogLabels[capability.label] ?? device.deviceType) : '';
  return [device.name, deviceKind(device, t), category, device.deviceType, device.modelName ?? ''].join(' ');
}
