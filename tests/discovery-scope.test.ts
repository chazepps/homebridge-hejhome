import { describe, expect, test } from 'vitest';

import { resolveDiscoveryScope } from '../src/discovery/scope.js';
import type { HejFamily, HejhomePlatformConfig } from '../src/types.js';

const families: HejFamily[] = [
  { familyId: 101, name: '첫 번째 집' },
  { familyId: 202, name: '두 번째 집' },
];

describe('discovery scope', () => {
  test('defaults to the first family when the user has not changed settings', () => {
    expect(resolveDiscoveryScope({}, families)).toEqual([
      { familyId: 101, roomIds: undefined },
    ]);
  });

  test('supports all-family discovery after the user changes settings', () => {
    expect(resolveDiscoveryScope({ scope: { mode: 'all' } } as HejhomePlatformConfig, families)).toEqual([
      { familyId: 101, roomIds: undefined },
      { familyId: 202, roomIds: undefined },
    ]);
  });

  test('supports custom family and room selections from plugin config', () => {
    const config = {
      scope: {
        mode: 'custom',
        includedFamilyIds: [202],
        includedRoomsByFamilyId: {
          '202': [7, 8],
        },
      },
    } as HejhomePlatformConfig;

    expect(resolveDiscoveryScope(config, families)).toEqual([
      { familyId: 202, roomIds: [7, 8] },
    ]);
  });
});
