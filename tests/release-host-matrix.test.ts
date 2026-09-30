import { expect, test } from 'vitest';
import { candidateVersion, localNpmArgs, matrixCells, nodeVersionAllowed, selectCells } from '../tools/release/verify-host-matrix.mjs';

test('the release matrix covers each supported Node and pinned Homebridge combination', () => {
  expect(matrixCells.map((cell) => cell.key)).toEqual([
    '22-stable', '22-beta', '24-stable', '24-beta', '26-stable', '26-beta',
  ]);
  expect(matrixCells.filter((cell) => cell.key.endsWith('stable')).map((cell) => cell.host)).toEqual([
    '2.4.0', '2.4.0', '2.4.0',
  ]);
  expect(matrixCells.filter((cell) => cell.key.endsWith('beta')).map((cell) => cell.host)).toEqual([
    '2.4.1-beta.11', '2.4.1-beta.11', '2.4.1-beta.11',
  ]);
  expect(matrixCells.filter((cell) => cell.major === 22).map((cell) => cell.nodeVersion)).toEqual(['22.13.0', '22.13.0']);
  expect(selectCells('24-stable').map((cell) => cell.key)).toEqual(['24-stable']);
  expect(() => selectCells('24-unknown')).toThrow('Unknown matrix cell');
});

test('native Matter rejects Node 22.12 even when supplied through an override', () => {
  expect(nodeVersionAllowed('v22.12.0', 22)).toBe(false);
  expect(nodeVersionAllowed('v22.13.0', 22)).toBe(true);
  expect(nodeVersionAllowed('v22.14.1', 22)).toBe(true);
  expect(nodeVersionAllowed('v24.4.1', 24)).toBe(true);
  expect(nodeVersionAllowed('v26.10.0', 26)).toBe(true);
  expect(nodeVersionAllowed('v22.13.0', 24)).toBe(false);
});

test('candidate and npm installation arguments cannot drift into a global or wrong-channel install', () => {
  const candidate = { name: '@chazepps/homebridge-hejhome', version: '3.0.0-beta.1', publishConfig: { tag: 'beta' } };
  expect(candidateVersion(candidate)).toBe('3.0.0-beta.1');
  expect(() => candidateVersion({ ...candidate, publishConfig: { tag: 'latest' } })).toThrow();
  expect(() => candidateVersion({ ...candidate, version: '2.1.0-beta.1' })).toThrow();
  expect(localNpmArgs('/tmp/isolated-cell', ['install', 'homebridge@2.4.0'])).toEqual([
    'install', 'homebridge@2.4.0', '--global=false', '--prefix=/tmp/isolated-cell',
  ]);
});
