import path from 'node:path';

export function homebridgeLogPath(storagePath) {
  return path.join(storagePath, 'homebridge.log');
}

export function createHomebridgeArgs({ pluginPath, storagePath }) {
  return [
    '-C',
    '-Q',
    '-I',
    '-U',
    storagePath,
    '-P',
    pluginPath,
    '--strict-plugin-resolution',
    '-D',
  ];
}

export function createLauncherLogLine(event, data = {}) {
  return `${new Date().toISOString()} INFO launcher.${event} ${JSON.stringify(data)}\n`;
}
