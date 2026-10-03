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
      homepage: string;
      bugs: { url: string };
      keywords: string[];
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
      bundledDependencies?: string[];
      bundleDependencies?: string[];
    }>('package.json');

    expect(pkg.name).toBe(PLUGIN_NAME);
    expect(pkg.name).toMatch(/^(@[a-z0-9-]+\/)?homebridge-[a-z0-9-]+$/);
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.type).toBe('module');
    expect(pkg.private).toBe(false);
    expect(pkg.engines.node).toBe('^22.12.0 || ^24.0.0');
    expect(pkg.engines.homebridge).toBe('^1.8.0 || ^2.0.0');
    expect(pkg.homepage).toMatch(/^https:\/\//);
    expect(pkg.bugs.url).toMatch(/^https:\/\//);
    expect(pkg.keywords).toContain('homebridge-plugin');
    expect(pkg.keywords).toContain('supports-hap');
    expect(pkg.keywords).not.toContain('supports-matter');
    for (const hook of ['preinstall', 'install', 'postinstall']) {
      expect(pkg.scripts?.[hook]).toBeUndefined();
    }
    for (const name of ['homebridge', 'hap-nodejs']) {
      expect(pkg.dependencies?.[name]).toBeUndefined();
      expect(pkg.peerDependencies?.[name]).toBeUndefined();
      expect(pkg.bundledDependencies ?? []).not.toContain(name);
      expect(pkg.bundleDependencies ?? []).not.toContain(name);
    }
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
    expect(schema.schema.properties).toHaveProperty('name');
  });

  test('uses object-level required arrays throughout the JSON schema', () => {
    const validate = (value: unknown): void => {
      if (!value || typeof value !== 'object') {
        return;
      }
      if (!Array.isArray(value) && Object.hasOwn(value, 'required')) {
        const object = value as { required: unknown; properties?: Record<string, unknown> };
        expect(Array.isArray(object.required)).toBe(true);
        for (const name of object.required as string[]) {
          expect(typeof name).toBe('string');
          expect(object.properties).toHaveProperty(name);
        }
      }
      for (const nested of Object.values(value)) {
        validate(nested);
      }
    };
    validate(readJson<{ schema: unknown }>('config.schema.json').schema);
  });
});
