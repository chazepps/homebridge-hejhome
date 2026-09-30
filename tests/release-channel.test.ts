import { describe, expect, test } from 'vitest';
import { releaseChannel } from '../tools/release/channel.mjs';

describe('release channel policy', () => {
  test('prereleases can only publish to beta with an exact tag and lockfile', () => {
    expect(releaseChannel('3.0.0-beta.1', 'v3.0.0-beta.1', '3.0.0-beta.1', 'beta')).toBe('beta');
    expect(() => releaseChannel('3.0.0-beta.1', 'v3.0.0-beta.1', '3.0.0-beta.1', 'latest')).toThrow();
    expect(() => releaseChannel('3.0.0-beta.1', 'v3.0.0-beta.2', '3.0.0-beta.1', 'beta')).toThrow();
    expect(() => releaseChannel('3.0.0-beta.1', 'v3.0.0-beta.1', '2.0.2', 'beta')).toThrow();
  });
  test('stable publication requires an explicit stable package configuration', () => {
    expect(releaseChannel('3.0.0', 'v3.0.0', '3.0.0', 'latest')).toBe('latest');
    expect(() => releaseChannel('3.0.0', 'v3.0.0', '3.0.0', 'beta')).toThrow();
  });
  test.each(['3.0.0-alpha.0', '3.0.0-beta.01', '3.0.0-beta', '3.0.0+build'])('rejects unreviewed version shape %s', (v) => {
    expect(() => releaseChannel(v, `v${v}`, v, 'beta')).toThrow();
  });
});
