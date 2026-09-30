#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const pluginName = '@chazepps/homebridge-hejhome';
const nodeVersions = { 22: '22.13.0', 24: '24.4.1', 26: '26.10.0' };
const hosts = { stable: '2.4.0', beta: '2.4.1-beta.11' };
export const matrixCells = Object.freeze(Object.keys(nodeVersions).flatMap((major) =>
  Object.entries(hosts).map(([channel, version]) => ({ key: `${major}-${channel}`, major: Number(major),
    nodeVersion: nodeVersions[major], host: version }))));

export function selectCells(only) {
  if (!only) {
    return matrixCells;
  }
  const requested = new Set(only.split(',').filter(Boolean));
  const selected = matrixCells.filter((cell) => requested.delete(cell.key));
  if (requested.size) {
    throw new Error(`Unknown matrix cell: ${[...requested].join(', ')}`);
  }
  if (!selected.length) {
    throw new Error('At least one matrix cell is required.');
  }
  return selected;
}

export function candidateVersion(pkg, expected = '3.0.0-beta.1') {
  assert.equal(pkg.name, pluginName, 'Unexpected plugin package name');
  assert.equal(pkg.version, expected, 'Tarball version differs from requested candidate');
  assert.equal(pkg.publishConfig?.tag, 'beta', 'Candidate must remain on the beta channel');
  return pkg.version;
}

export function nodeVersionAllowed(version, major) {
  const parsed = /^v(\d+)\.(\d+)\.(\d+)$/.exec(version);
  return parsed !== null && Number(parsed[1]) === major && (major !== 22 || Number(parsed[2]) >= 13);
}

function parseArgs(argv) {
  const options = { tarball: '', output: '', only: '', skipRollback: false, expectedVersion: '3.0.0-beta.1', latestVersion: '' };
  for (const arg of argv) {
    if (arg === '--skip-rollback') {
      options.skipRollback = true;
    } else if (arg === '--help') {
      options.help = true;
    } else if (arg.startsWith('--tarball=')) {
      options.tarball = arg.slice(10);
    } else if (arg.startsWith('--output=')) {
      options.output = arg.slice(9);
    } else if (arg.startsWith('--only=')) {
      options.only = arg.slice(7);
    } else if (arg.startsWith('--expected-version=')) {
      options.expectedVersion = arg.slice(19);
    } else if (arg.startsWith('--latest-version=')) {
      options.latestVersion = arg.slice(17);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function npmCliPath() {
  if (process.env.HEJ_NPM_CLI) {
    return path.resolve(process.env.HEJ_NPM_CLI);
  }
  return realpathSync(execFileSync('which', ['npm'], { encoding: 'utf8' }).trim());
}

function runLogged(binary, args, { cwd, log, timeoutMs, env = {} }) {
  appendFileSync(log, `\n$ ${binary} ${args.join(' ')}\n`);
  const fd = openSync(log, 'a');
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', fd, fd],
      detached: process.platform !== 'win32' });
    closeSync(fd);
    let timedOut = false;
    let forceTimer;
    const signalChild = (signal) => {
      try {
        if (process.platform !== 'win32' && child.pid) {
          process.kill(-child.pid, signal);
        } else {
          child.kill(signal);
        }
      } catch {
        child.kill(signal);
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      signalChild('SIGTERM');
      forceTimer = setTimeout(() => signalChild('SIGKILL'), 3000);
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      reject(error);
    });
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      clearTimeout(forceTimer);
      if (code === 0 && !timedOut) {
        resolve();
      } else {
        reject(new Error(`Command ${timedOut ? 'timed out' : 'failed'} (exit ${code}, signal ${signal}); see ${log}`));
      }
    });
  });
}

async function npmRun(nodeBinary, args, directory, log, cache, timeoutMs = 180_000) {
  await runLogged(nodeBinary, [npmCliPath(), ...localNpmArgs(directory, args)], { cwd: directory, log, timeoutMs,
    env: { npm_config_cache: cache, npm_config_global: 'false', npm_config_update_notifier: 'false',
      npm_config_audit: 'false', npm_config_fund: 'false' } });
}

export function localNpmArgs(directory, args) {
  return [...args, '--global=false', `--prefix=${directory}`];
}

async function resolveNode(major, output, log, cache) {
  const configured = process.env[`HEJ_NODE_${major}`];
  if (configured) {
    const version = execFileSync(configured, ['--version'], { encoding: 'utf8' }).trim();
    assert(nodeVersionAllowed(version, major), `HEJ_NODE_${major} points to unsupported ${version}`);
    return configured;
  }
  if (nodeVersionAllowed(process.version, major)) {
    return process.execPath;
  }
  const prefix = path.join(output, 'runtimes', `node-${nodeVersions[major]}`);
  const binary = path.join(prefix, 'node_modules', 'node', 'bin', 'node');
  if (!existsSync(binary)) {
    mkdirSync(prefix, { recursive: true });
    writeFileSync(path.join(prefix, 'package.json'), '{"private":true}\n');
    await npmRun(process.execPath, ['install', '--no-save', '--package-lock=false', `node@${nodeVersions[major]}`],
      prefix, log, cache);
  }
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  assert.equal(version, `v${nodeVersions[major]}`);
  return binary;
}

function installedVersion(directory, pkg) {
  return JSON.parse(readFileSync(path.join(directory, 'node_modules', ...pkg.split('/'), 'package.json'), 'utf8')).version;
}

async function verifyCell(cell, tarball, candidate, sha256, runId, output, cache) {
  const directory = path.join(output, 'cells', cell.key);
  const log = path.join(output, 'logs', `${cell.key}.log`);
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  const binary = await resolveNode(cell.major, output, log, cache);
  const version = execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim();
  const stamp = path.join(directory, '.candidate-sha256');
  let reusable = false;
  if (existsSync(stamp)) {
    try {
      const installed = JSON.parse(readFileSync(stamp, 'utf8'));
      reusable = installed.sha256 === sha256 && installed.node === version && installed.host === cell.host
        && installed.plugin === candidate && installedVersion(directory, 'homebridge') === cell.host
        && installedVersion(directory, pluginName) === candidate;
    } catch {
      reusable = false;
    }
  }
  console.log(`${cell.key}: ${reusable ? 'reuse installation' : 'install'} (${version}, Homebridge ${cell.host})`);
  if (!reusable) {
    await npmRun(binary, ['install', '--no-save', '--package-lock=false', `homebridge@${cell.host}`, tarball],
      directory, log, cache);
    writeFileSync(stamp, JSON.stringify({ sha256, node: version, host: cell.host, plugin: candidate }));
  }
  assert.equal(installedVersion(directory, 'homebridge'), cell.host);
  assert.equal(installedVersion(directory, pluginName), candidate);
  copyFileSync(new URL('./host-matrix-smoke.mjs', import.meta.url), path.join(directory, 'smoke.mjs'));
  const dataDirectory = path.join(directory, `state-${runId}`);
  for (const phase of [0, 1, 2]) {
    await runLogged(binary, ['smoke.mjs', String(phase), dataDirectory], { cwd: directory, log, timeoutMs: 60_000 });
  }
  const phases = [0, 1, 2].map((phase) => JSON.parse(readFileSync(path.join(dataDirectory, `phase-${phase}.json`), 'utf8')));
  assert(phases.every((item) => item.plugin === candidate && item.host === cell.host && item.node === version));
  console.log(`${cell.key}: pass`);
  return { key: cell.key, node: version, host: cell.host, plugin: candidate, phases, log, dataDirectory };
}

async function verifyRollback(tarball, candidate, requestedLatest, output, cache) {
  const directory = path.join(output, 'rollback');
  const log = path.join(output, 'logs', 'rollback.log');
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  const latest = requestedLatest || JSON.parse(execFileSync(process.execPath,
    [npmCliPath(), 'view', pluginName, 'dist-tags.latest', '--json'], { encoding: 'utf8', timeout: 30_000 }));
  assert(typeof latest === 'string' && /^\d+\.\d+\.\d+$/.test(latest), 'latest must resolve to an exact stable version');
  const install = (spec) => npmRun(process.execPath,
    ['install', '--no-save', '--package-lock=false', '--legacy-peer-deps', spec], directory, log, cache);
  await install(`${pluginName}@${latest}`);
  assert.equal(installedVersion(directory, pluginName), latest);
  await install(tarball);
  assert.equal(installedVersion(directory, pluginName), candidate);
  await install(`${pluginName}@${latest}`);
  assert.equal(installedVersion(directory, pluginName), latest);
  console.log(`rollback: pass (latest pinned ${latest})`);
  return { latestPinned: latest, sequence: [latest, candidate, latest], log };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log('Usage: node tools/release/verify-host-matrix.mjs --tarball=/absolute/plugin.tgz '
      + '[--output=/tmp/matrix] [--only=24-stable] [--skip-rollback] [--latest-version=x.y.z]');
    return;
  }
  assert(options.tarball, '--tarball is required');
  const tarball = path.resolve(options.tarball);
  assert(existsSync(tarball), `Tarball not found: ${tarball}`);
  const packageJson = JSON.parse(execFileSync('tar', ['-xOf', tarball, 'package/package.json'], { encoding: 'utf8' }));
  const candidate = candidateVersion(packageJson, options.expectedVersion);
  const sha256 = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const output = options.output ? path.resolve(options.output) : mkdtempSync(path.join(os.tmpdir(), 'hej-host-matrix-'));
  mkdirSync(path.join(output, 'logs'), { recursive: true });
  const cache = path.join(output, 'npm-cache');
  const summaryFile = path.join(output, 'summary.json');
  const selected = selectCells(options.only);
  const runId = `${Date.now()}-${process.pid}`;
  const summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8'))
    : { tarball, sha256, candidate, selected: [], results: [], rollback: null, runs: [] };
  assert.equal(summary.sha256, sha256, 'Output directory belongs to a different tarball; use a new --output');
  summary.tarball = tarball;
  summary.selected = [...new Set([...summary.selected, ...selected.map((cell) => cell.key)])];
  summary.runs ??= [];
  const run = { id: runId, selected: selected.map((cell) => cell.key), startedAt: new Date().toISOString(), status: 'running' };
  summary.runs.push(run);
  const save = () => writeFileSync(summaryFile, JSON.stringify(summary, null, 2));
  save();
  try {
    for (const cell of selected) {
      summary.results = summary.results.filter((result) => result.key !== cell.key);
      save();
      summary.results.push(await verifyCell(cell, tarball, candidate, sha256, runId, output, cache));
      save();
    }
    if (!options.skipRollback) {
      summary.rollback = await verifyRollback(tarball, candidate, options.latestVersion, output, cache);
    }
    run.status = 'passed';
    run.completedAt = new Date().toISOString();
    save();
    console.log(`Matrix passed. Evidence: ${path.join(output, 'summary.json')}`);
  } catch (error) {
    run.status = 'failed';
    run.error = error instanceof Error ? error.message : String(error);
    run.completedAt = new Date().toISOString();
    save();
    console.error(`Matrix failed: ${run.error}`);
    console.error(`Evidence: ${path.join(output, 'summary.json')}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
