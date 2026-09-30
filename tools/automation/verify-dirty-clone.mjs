#!/usr/bin/env node
// Proves the official source probe ignores a dirty checkout without touching an existing one.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const TAG = 'v6.0.1-alpha.20';
const SHA = 'b85d97ff3777c6f72a451db9ba8c16bd530fab42';
const scratch = await mkdtemp(path.join(os.tmpdir(), 'hejhome-dirty-alpha-probe-'));
const source = process.argv[2] ?? path.join(scratch, 'source');
const dirtyClone = path.join(scratch, 'dirty');

try {
  if (!process.argv[2]) {
    execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', TAG,
      'https://github.com/homebridge/homebridge-config-ui-x.git', source], { stdio: 'pipe' });
  }
  const originalStatus = execFileSync('git', ['status', '--short'], { cwd: source, encoding: 'utf8' });
  assert.equal(execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim(), SHA);
  execFileSync('git', ['clone', '--quiet', source, dirtyClone], { stdio: 'pipe' });
  await writeFile(path.join(dirtyClone, 'src/smart-automation/rules/smart-light-group.rules-engine.ts'),
    'THIS DIRTY WORKTREE FILE MUST NEVER BE TRANSPILED\n');
  assert.match(execFileSync('git', ['status', '--short'], { cwd: dirtyClone, encoding: 'utf8' }),
    /smart-light-group\.rules-engine\.ts/);
  const output = execFileSync('node', [path.join(import.meta.dirname, 'verify-upstream.mjs'), dirtyClone],
    { cwd: process.cwd(), encoding: 'utf8' });
  assert.match(output, /PASS official Smart Automation v6\.0\.1-alpha\.20 b85d97ff/);
  assert.match(output, /LIMITATION C5: an unresolved input does not prevent arming/);
  assert.equal(execFileSync('git', ['status', '--short'], { cwd: source, encoding: 'utf8' }), originalStatus);
  console.log('PASS dirty-clone isolation: official Git blobs tested; existing checkout untouched');
} finally {
  await rm(scratch, { recursive: true, force: true });
}
