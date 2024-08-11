import { HejhomePlatform } from '../platform.js';
import { HejDeviceState } from './get_devices.js';
import { hejRequest } from './request.js';

export const control = async (
  platform: HejhomePlatform,
  deviceId: string,
  body: Data,
) => hejRequest<Data, null>(platform, 'POST', `dashboard/control/${deviceId}`, body);

export type Data = {
  requirments: HejDeviceState;
};
