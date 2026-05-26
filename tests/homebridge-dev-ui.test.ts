import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { createHomebridgeArgs, homebridgeLogPath } from '../tools/homebridge/dev-ui-logging.mjs';

describe('Homebridge dev UI launcher', () => {
  test('writes to the log file Homebridge UI reads and enables insecure accessory access', () => {
    const storagePath = path.join('/tmp', 'hb-storage');
    const pluginPath = path.join('/tmp', 'hb-plugins');
    const args = createHomebridgeArgs({ pluginPath, storagePath });

    expect(homebridgeLogPath(storagePath)).toBe(path.join(storagePath, 'homebridge.log'));
    expect(args).toEqual(expect.arrayContaining(['-I', '-U', storagePath, '-P', pluginPath]));
    expect(args).toEqual(expect.arrayContaining(['--strict-plugin-resolution', '-D']));
  });
});
