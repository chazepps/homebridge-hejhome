import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test } from 'vitest';

import { PLATFORM_NAME, PLUGIN_NAME } from '../src/settings.js';

const root = path.resolve(import.meta.dirname, '..');

function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8')) as T;
}

describe('Homebridge official plugin gates', () => {
  test('package metadata follows the dynamic platform plugin rules', () => {
    const pkg = readJson<{
      name: string;
      main: string;
      type: string;
      engines: Record<string, string>;
      scripts?: Record<string, string>;
      private?: boolean;
    }>('package.json');

    expect(pkg.name).toBe(PLUGIN_NAME);
    expect(pkg.name).toMatch(/^(@[a-z0-9-]+\/)?homebridge-[a-z0-9-]+$/);
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.type).toBe('module');
    expect(pkg.private).toBe(false);
    expect(pkg.engines.node).toBe('^22.12.0 || ^24.0.0');
    expect(pkg.engines.homebridge).toBe('^1.8.0 || ^2.0.0');
    expect(pkg.scripts?.postinstall).toBeUndefined();
  });

  test('config schema enables a singular custom platform UI without hand-written platform fields', () => {
    const schema = readJson<{
      pluginAlias: string;
      pluginType: string;
      singular: boolean;
      customUi: boolean;
      customUiPath?: string;
      schema: {
        type: string;
        additionalProperties: boolean;
        properties: Record<string, unknown>;
      };
    }>('config.schema.json');

    expect(schema.pluginAlias).toBe(PLATFORM_NAME);
    expect(schema.pluginType).toBe('platform');
    expect(schema.singular).toBe(true);
    expect(schema.customUi).toBe(true);
    expect(schema.customUiPath).toBe('./homebridge-ui');
    expect(schema.schema.type).toBe('object');
    expect(schema.schema.additionalProperties).toBe(false);
    expect(schema.schema.properties).not.toHaveProperty('platform');
  });
});
