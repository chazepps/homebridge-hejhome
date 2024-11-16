import { HejhomePlatform } from '../platform.js';
import { HejDeviceState } from './get_devices.js';
import { hejRequest } from './request.js';

export const control = async (
  platform: HejhomePlatform,
  deviceId: string,
  body: Data,
) => {
  const res = await hejRequest<Data, null>(platform, 'POST', `dashboard/control/${deviceId}`, body, false);

  platform.log.debug(`Control device: ${deviceId} ⇒ ${JSON.stringify(body)}`);

  return res;
};

export type Data = {
  requirments: HejDeviceState;
};
