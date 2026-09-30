import type { HejDevice } from '../types.js';
import { getDeviceCapability } from './capabilities.js';

/** Power representations consumed by the vendor IR air-conditioner UI. */
export function readVendorPower(device: HejDevice): boolean | undefined {
  const value: unknown = device.deviceState?.power;
  if (typeof value === 'boolean') {
    return value;
  }
  if (device.deviceType === 'IrAirconditioner') {
    if (value === '켜짐' || value === 'true') {
      return true;
    }
    if (value === '꺼짐' || value === 'false') {
      return false;
    }
  }
  return undefined;
}

export function isMomentaryPowerDevice(device: HejDevice): boolean {
  const kind = getDeviceCapability(device.deviceType)?.serviceKind;
  return (kind === 'ir-switch' || kind === 'ir-fan') && device.deviceType !== 'IrAirconditioner'
    && readVendorPower(device) === undefined;
}
