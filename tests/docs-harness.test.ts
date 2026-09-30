import { describe, expect, test } from 'vitest';

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { ROOT, listMarkdownFiles, listProjectFiles } from '../tools/docs/harness-lib.mjs';

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

test('keeps private agent work records out of public documentation and generated inventory', () => {
  const parent = path.join(ROOT, '.superpowers');
  fs.mkdirSync(parent, { recursive: true });
  const fixture = fs.mkdtempSync(path.join(parent, 'docs-check-'));
  try {
    fs.writeFileSync(path.join(fixture, 'private.md'), 'Private task verification record.');
    expect(listMarkdownFiles().some((file) => file.startsWith('.superpowers/'))).toBe(false);
    expect(listProjectFiles().some((file) => file.startsWith('.superpowers/'))).toBe(false);
  } finally {
    fs.rmSync(fixture, { recursive: true, force: true });
  }
});

test('does not make the source inventory stale when a local npm package is built', () => {
  const artifact = path.join(ROOT, `package-check-${randomUUID()}.tgz`);
  fs.writeFileSync(artifact, 'Test artifact, not a release package.');
  try {
    expect(listProjectFiles()).not.toContain(path.basename(artifact));
  } finally {
    fs.rmSync(artifact);
  }
});
