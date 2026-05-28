import { describe, expect, test } from 'vitest';

import { listProjectFiles } from '../tools/docs/harness-lib.mjs';

describe('documentation project-structure harness', () => {
  test('excludes local Homebridge runtime files from the generated tree', () => {
    const files = listProjectFiles();

    expect(files).not.toContain('.git');
    expect(files).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^\.yarn\//),
    ]));
    expect(files).not.toContain('test/hbConfig/homebridge.log');
    expect(files).not.toContain('test/hbConfig/homebridge-ui.json');
    expect(files).not.toEqual(expect.arrayContaining([
      expect.stringMatching(/^test\/hbConfig\/matter\//),
    ]));
  });
});
