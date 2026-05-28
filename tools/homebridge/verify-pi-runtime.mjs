#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const REQUIRED_LOG_EVENTS = [
  'session.loaded',
  'accessory-load.start',
  'snapshot.saved',
  'realtime.subscribe.success',
];

const REQUIRED_DEVICE_TYPES = [
  'LightRgbw5',
  'SensorMo',
  'LightWw3',
  'RelayController',
];

const SWITCH_DEVICE_TYPES = ['ZigbeeSwitch1', 'ZigbeeSwitch2'];
const EXPECTED_LINK_PATH = '/var/lib/homebridge/dev-plugins/homebridge-hejhome';

const REMOTE_NODE_SCRIPT = `PATH=/opt/homebridge/bin:$PATH node --input-type=module <<'NODE'
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

function run(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

function readJson(filePath) {
  try {
    return JSON.parse(readText(filePath));
  } catch {
    return null;
  }
}

function readLocalJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

function readTail(filePath, maxBytes) {
  try {
    const data = readText(filePath);
    return data.slice(-maxBytes);
  } catch {
    return '';
  }
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return run('sudo', ['cat', filePath]);
  }
}

const packageJson = readLocalJson('/var/lib/homebridge/node_modules/homebridge-hejhome/package.json');
const devPluginJson = readLocalJson('/var/lib/homebridge/dev-plugins/homebridge-hejhome/package.json');
const linkedPluginPath = run('readlink', ['/var/lib/homebridge/node_modules/homebridge-hejhome']);
const pluginPath = linkedPluginPath || (devPluginJson ? '/var/lib/homebridge/dev-plugins/homebridge-hejhome' : '');

console.log(JSON.stringify({
  nodeVersion: process.version,
  serviceActive: run('systemctl', ['is-active', 'homebridge']),
  linkedPluginPath: pluginPath,
  packageVersion: packageJson?.version ?? devPluginJson?.version ?? '',
  snapshot: readJson('/var/lib/homebridge/hejhome/devices-snapshot.json'),
  logTail: run('sudo', ['tail', '-c', '60000', '/var/lib/homebridge/hejhome/hejhome.log'])
    || readTail('/var/lib/homebridge/hejhome/hejhome.log', 60000),
}));
NODE`;

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(redact(message));
  process.exit(1);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const remotePayload = loadRemotePayload(args.host);
  const summary = verifyPayload(remotePayload, args.host);

  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log('Pi runtime verification passed');
  console.log(`Host: ${summary.host}`);
  console.log(`Node: ${summary.nodeVersion}`);
  console.log(`Homebridge service: ${summary.serviceActive}`);
  console.log(`Linked plugin: ${summary.linkedPluginPath}`);
  console.log(`Plugin version: ${summary.packageVersion}`);
  console.log(`Families: ${summary.familyCount}, devices: ${summary.deviceCount}`);
  console.log(`Core types: ${summary.coreTypes.join(', ')}`);
  console.log(`Log events: ${summary.logEvents.join(', ')}`);
}

function parseArgs(argv) {
  const args = {
    host: process.env.HEJHOME_PI_HOST ?? 'pi',
    json: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--json') {
      args.json = true;
      continue;
    }
    if (arg === '--host') {
      const value = argv[index + 1];
      if (!value) {
        throw new Error('--host requires a value');
      }
      args.host = value;
      index += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      console.log('Usage: npm run homebridge:pi:verify -- [--host pi] [--json]');
      process.exit(0);
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return args;
}

function loadRemotePayload(host) {
  const fixture = process.env.HEJHOME_PI_VERIFY_REMOTE_JSON;
  if (fixture) {
    return parseJson(fixture, 'remote JSON fixture');
  }

  const output = execFileSync('ssh', [host, REMOTE_NODE_SCRIPT], {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseJson(output, `ssh ${host} verification output`);
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`${label} could not be parsed as JSON`);
  }
}

function verifyPayload(payload, host) {
  const snapshot = payload.snapshot;
  const devices = collectDevices(snapshot);
  const deviceTypes = new Set(devices.map((device) => device.deviceType).filter(Boolean));
  const familyCount = numberOrDefault(snapshot?.familyCount, Array.isArray(snapshot?.families) ? snapshot.families.length : 0);
  const deviceCount = numberOrDefault(snapshot?.deviceCount, devices.length);
  const switchType = SWITCH_DEVICE_TYPES.find((deviceType) => deviceTypes.has(deviceType));
  const missingTypes = REQUIRED_DEVICE_TYPES.filter((deviceType) => !deviceTypes.has(deviceType));
  const missingEvents = REQUIRED_LOG_EVENTS.filter((eventName) => !String(payload.logTail ?? '').includes(eventName));

  const checks = [
    [isSupportedNodeVersion(payload.nodeVersion), `Pi Homebridge Node must be v22 or v24, got ${payload.nodeVersion || 'unknown'}`],
    [String(payload.serviceActive ?? '').trim() === 'active', `Homebridge service must be active, got ${payload.serviceActive || 'unknown'}`],
    [isExpectedPluginPath(payload.linkedPluginPath), `plugin path must point at ${EXPECTED_LINK_PATH}`],
    [Boolean(payload.packageVersion), 'linked plugin package version is missing'],
    [familyCount >= 1, 'device snapshot must contain at least one family'],
    [deviceCount >= 1, 'device snapshot must contain at least one device'],
    [missingTypes.length === 0, `snapshot is missing required device types: ${missingTypes.join(', ')}`],
    [Boolean(switchType), `snapshot is missing one of: ${SWITCH_DEVICE_TYPES.join(', ')}`],
    [missingEvents.length === 0, `plugin log is missing events: ${missingEvents.join(', ')}`],
  ];

  const failed = checks.find(([passed]) => !passed);
  if (failed) {
    throw new Error(String(failed[1]));
  }

  return sanitizeSummary({
    host,
    nodeVersion: String(payload.nodeVersion),
    serviceActive: String(payload.serviceActive),
    linkedPluginPath: String(payload.linkedPluginPath),
    packageVersion: String(payload.packageVersion),
    familyCount,
    deviceCount,
    coreTypes: [
      'LightRgbw5',
      'SensorMo',
      'LightWw3',
      switchType,
      'RelayController',
    ].filter(Boolean),
    logEvents: REQUIRED_LOG_EVENTS,
  });
}

function collectDevices(snapshot) {
  if (!snapshot || !Array.isArray(snapshot.families)) {
    return [];
  }

  return snapshot.families.flatMap((entry) => Array.isArray(entry.devices) ? entry.devices : []);
}

function numberOrDefault(value, fallback) {
  return Number.isFinite(Number(value)) ? Number(value) : fallback;
}

function isSupportedNodeVersion(version) {
  return /^v(?:22|24)\./.test(String(version ?? ''));
}

function isExpectedPluginPath(pluginPath) {
  return String(pluginPath ?? '') === EXPECTED_LINK_PATH
    || String(pluginPath ?? '').endsWith('/dev-plugins/homebridge-hejhome');
}

function sanitizeSummary(summary) {
  return Object.fromEntries(
    Object.entries(summary).map(([key, value]) => [key, redactValue(value)]),
  );
}

function redactValue(value) {
  if (typeof value === 'string') {
    return redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => redactValue(entry));
  }
  return value;
}

function redact(text) {
  return String(text)
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/\bBasic\s+[A-Za-z0-9+/=._-]+/gi, 'Basic [redacted]')
    .replace(/\bJSESSIONID\s*=\s*[^;\s]+/gi, 'JSESSIONID=[redacted]')
    .replace(/\baccessToken\s*=\s*[^&\s]+/gi, 'accessToken=[redacted]')
    .replace(/\bpassword\b\s*[:=]\s*[^,\s]+/gi, 'password=[redacted]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[redacted-email]');
}
