#!/usr/bin/env node
import { fork } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { createHomebridgeArgs, createLauncherLogLine, homebridgeLogPath } from './dev-ui-logging.mjs';

await import('./prepare-dev-plugins.mjs');

const root = path.resolve(import.meta.dirname, '../..');
const configPath = path.join(root, 'test/hbConfig/config.json');
const storagePath = path.join(root, 'test/hbConfig');
const pluginPath = path.join(root, 'test/plugins');
const homebridgeBin = path.join(root, 'node_modules/.bin', process.platform === 'win32' ? 'homebridge.cmd' : 'homebridge');
const logPath = homebridgeLogPath(storagePath);

await fs.promises.mkdir(storagePath, { recursive: true });
await fs.promises.appendFile(logPath, '', { mode: 0o600 });
const logStream = fs.createWriteStream(logPath, { flags: 'a', mode: 0o600 });
teeProcessOutput(logStream);

process.env.UIX_CONFIG_PATH = configPath;
process.env.UIX_STORAGE_PATH = storagePath;
process.env.UIX_CUSTOM_PLUGIN_PATH = pluginPath;
process.env.UIX_STRICT_PLUGIN_RESOLUTION = '1';
process.env.UIX_INSECURE_MODE = '1';

let shuttingDown = false;
let homebridge = null;
let restartTimer = null;

writeLauncherLog('started', { configPath, storagePath, pluginPath, logPath });

const main = await import('../../node_modules/homebridge-config-ui-x/dist/main.js');
const ui = await main.app;
const ipcService = ui.get(main.HomebridgeIpcService);

startHomebridge();

process.on('SIGINT', () => shutdown(130));
process.on('SIGTERM', () => shutdown(143));

function startHomebridge() {
  if (shuttingDown) {
    return;
  }

  const args = createHomebridgeArgs({ pluginPath, storagePath });
  writeLauncherLog('homebridge-child.start', { homebridgeBin, args });

  homebridge = fork(homebridgeBin, args, {
    cwd: root,
    env: process.env,
    silent: true,
  });

  ipcService.setHomebridgeProcess(homebridge);

  homebridge.stdout?.on('data', (data) => {
    process.stdout.write(data);
  });
  homebridge.stderr?.on('data', (data) => {
    process.stderr.write(data);
  });

  homebridge.on('close', (code, signal) => {
    if (shuttingDown) {
      return;
    }
    writeLauncherLog('homebridge-child.restart', {
      code: code ?? null,
      signal: signal ?? null,
      delayMs: 2000,
    });
    restartTimer = setTimeout(startHomebridge, 2000);
  });
}

function shutdown(exitCode) {
  shuttingDown = true;
  writeLauncherLog('shutdown', { exitCode: typeof exitCode === 'number' ? exitCode : 1 });
  if (restartTimer) {
    clearTimeout(restartTimer);
  }
  if (homebridge && !homebridge.killed) {
    homebridge.kill('SIGTERM');
  }

  setTimeout(() => {
    logStream.end();
    process.exit(typeof exitCode === 'number' ? exitCode : 1);
  }, 500);
}

function teeProcessOutput(stream) {
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk, encoding, callback) => {
    stream.write(chunk);
    return stdoutWrite(chunk, encoding, callback);
  };

  process.stderr.write = (chunk, encoding, callback) => {
    stream.write(chunk);
    return stderrWrite(chunk, encoding, callback);
  };
}

function writeLauncherLog(event, data = {}) {
  process.stdout.write(createLauncherLogLine(event, data));
}
