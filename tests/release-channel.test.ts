import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import { afterEach, describe, expect, test } from 'vitest';

const fixtureRoots: string[] = [];
const releaseScript = path.resolve(import.meta.dirname, '../tools/release/channel.mjs');

afterEach(() => {
  for (const fixtureRoot of fixtureRoots.splice(0)) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

function runRelease({ version = '2.1.2', tag = 'v2.1.2', lockVersion = version, rootVersion = version, channel = 'latest' } = {}) {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hejhome-release-'));
  fixtureRoots.push(cwd);
  fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify({ version, publishConfig: { tag: channel } }));
  fs.writeFileSync(path.join(cwd, 'package-lock.json'), JSON.stringify({ version: lockVersion, packages: { '': { version: rootVersion } } }));
  const output = path.join(cwd, 'github-output');
  const result = spawnSync(process.execPath, [releaseScript, tag], {
    cwd, encoding: 'utf8', env: { ...process.env, GITHUB_OUTPUT: output },
  });
  return { ...result, output: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '' };
}

describe('npm release tag and package version gate', () => {
  test('selects latest only when the tag, package and lockfile agree', () => {
    const result = runRelease();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('latest');
    expect(result.output).toBe('channel=latest\n');
  });

  test('selects beta only for a matching numbered prerelease', () => {
    const result = runRelease({ version: '3.0.0-beta.1', tag: 'v3.0.0-beta.1', channel: 'beta' });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe('beta');
    expect(result.output).toBe('channel=beta\n');
  });

  test.each([
    { tag: 'v2.1.1' },
    { lockVersion: '2.1.1' },
    { rootVersion: '2.1.1' },
    { channel: 'beta' },
    { version: '3.0.0-beta.1', tag: 'v3.0.0-beta.1', channel: 'latest' },
    { version: '3.0.0-rc.1', tag: 'v3.0.0-rc.1' },
    { version: '02.1.2', tag: 'v02.1.2' },
  ])('rejects inconsistent release metadata without publishing a channel: %j', (overrides) => {
    const result = runRelease(overrides);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/must agree|Lockfile root package version|Only stable or numbered beta/);
    expect(result.output).toBe('');
  });
});
