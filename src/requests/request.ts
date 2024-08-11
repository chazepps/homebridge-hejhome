import ky from 'ky';

import { HejhomePlatform } from '../platform.js';

export const hejRequest = async <Request extends Record<string, unknown> | null, Response>(
  platform: HejhomePlatform,
  method: 'GET' | 'POST',
  path: string,
  data: Request | undefined = undefined,
) => {
  const url = `https://square.hej.so/${path}`;
  const response = await ky(url, {
    headers: {
      authorization: `Bearer ${platform.token}`,
      'x-requested-with': 'XMLHttpRequest',
      Referer: 'https://square.hej.so/square',
    },
    json: data,
    method,
  });

  const text = await response.text();

  return JSON.parse(text) as Response;
};
