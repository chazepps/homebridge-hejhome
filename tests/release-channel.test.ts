import { describe, expect, test } from 'vitest';
import { releaseChannel } from '../tools/release/channel.mjs';

describe('release channel policy', () => {
  test('prereleases can only publish to beta with an exact tag and lockfile', () => {
    expect(releaseChannel('2.1.0-beta.0', 'v2.1.0-beta.0', '2.1.0-beta.0', 'beta')).toBe('beta');
    expect(() => releaseChannel('2.1.0-beta.0', 'v2.1.0-beta.0', '2.1.0-beta.0', 'latest')).toThrow();
    expect(() => releaseChannel('2.1.0-beta.0', 'v2.1.0-beta.1', '2.1.0-beta.0', 'beta')).toThrow();
    expect(() => releaseChannel('2.1.0-beta.0', 'v2.1.0-beta.0', '2.0.2', 'beta')).toThrow();
  });
  test('stable publication requires an explicit stable package configuration', () => {
    expect(releaseChannel('2.1.0', 'v2.1.0', '2.1.0', 'latest')).toBe('latest');
    expect(() => releaseChannel('2.1.0', 'v2.1.0', '2.1.0', 'beta')).toThrow();
  });
  test.each(['2.1.0-alpha.0', '2.1.0-beta.01', '2.1.0-beta', '2.1.0+build'])('rejects unreviewed version shape %s', (v) => {
    expect(() => releaseChannel(v, `v${v}`, v, 'beta')).toThrow();
  });
});
