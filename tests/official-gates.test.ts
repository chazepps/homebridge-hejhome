import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, test, vi } from 'vitest';
import type { API } from 'homebridge';

import initializePlugin from '../src/index.js';
import { HejhomePlatform } from '../src/platform.js';
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
      keywords: string[];
      homepage: string;
      bugs: { url: string };
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
    expect(pkg.engines.node).toBe('^22.13.0 || ^24.0.0 || ^26.0.0');
    expect(pkg.engines.homebridge).toBe('^2.4.0');
    expect(pkg.keywords).toEqual(expect.arrayContaining(['homebridge-plugin', 'supports-hap', 'supports-matter']));
    expect(new URL(pkg.homepage).protocol).toBe('https:');
    expect(new URL(pkg.bugs.url).protocol).toBe('https:');
    for (const hook of ['preinstall', 'install', 'postinstall']) {
      expect(pkg.scripts?.[hook]).toBeUndefined();
    }
    for (const dependency of ['homebridge', 'hap-nodejs', '@homebridge/hap-nodejs']) {
      expect(pkg.dependencies).not.toHaveProperty(dependency);
      expect(pkg.peerDependencies ?? {}).not.toHaveProperty(dependency);
      expect(pkg.bundledDependencies ?? []).not.toContain(dependency);
      expect(pkg.bundleDependencies ?? []).not.toContain(dependency);
    }
  });

  test('initializer registers the schema alias without constructing the platform', () => {
    const registerPlatform = vi.fn();
    initializePlugin({ registerPlatform } as unknown as API);
    const schema = readJson<{ pluginAlias: string }>('config.schema.json');
    expect(registerPlatform).toHaveBeenCalledExactlyOnceWith(schema.pluginAlias, HejhomePlatform);
  });

  test('all schema required declarations use object-level arrays of existing property names', () => {
    const { schema } = readJson<{ schema: unknown }>('config.schema.json');
    function validateRequired(value: unknown): void {
      if (!value || typeof value !== 'object') {
        return;
      }
      const node = value as Record<string, unknown>;
      if (Object.hasOwn(node, 'required')) {
        expect(Array.isArray(node.required)).toBe(true);
        for (const name of node.required as unknown[]) {
          expect(typeof name).toBe('string');
          expect(node.properties).toHaveProperty(name as string);
        }
      }
      Object.values(node).forEach(validateRequired);
    }
    validateRequired(schema);
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
