#!/usr/bin/env node
// Isolated Homebridge core + official UI alpha Smart Automation integration.
// No vendor credentials, devices, operational storage, or global installation.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const UI_VERSION = '6.0.1-alpha.20';
const CORE_VERSION = '2.4.1-beta.11';
const PIN = '031-45-154';
const httpFetch = globalThis.fetch;
const ROOT = path.resolve(import.meta.dirname, '../..');
const installArg = process.argv[2] === '--install-root' ? process.argv[3] : undefined;
if (process.argv.length > (installArg ? 4 : 2) || (process.argv[2] && !installArg)) {
  throw new Error('Usage: node tools/automation/run-host-integration.mjs [--install-root /tmp/existing-install]');
}
if (installArg) {
  const installationReal = await fs.realpath(installArg);
  const allowedTempRoots = await Promise.all([os.tmpdir(), '/tmp'].map(root => fs.realpath(root)));
  if (!allowedTempRoots.some(root => installationReal.startsWith(`${root}${path.sep}`))) {
    throw new Error('The install root must be under the OS temporary directory.');
  }
}
const runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'hejhome-automation-host-'));
const installation = installArg ? path.resolve(installArg) : runtime;
let activeBridge;
let activeClient;
let activeMonitor;
let activeCommand;
let interrupted = false;
const exitSignal = signal => {
  interrupted = true;
  activeMonitor?.finish();
  activeClient?.destroy();
  activeBridge?.child.kill(signal);
  activeCommand?.kill(signal);
  setTimeout(() => activeBridge?.child.kill('SIGKILL'), 4000).unref();
  setTimeout(() => activeCommand?.kill('SIGKILL'), 4000).unref();
};
process.once('SIGINT', () => exitSignal('SIGTERM'));
process.once('SIGTERM', () => exitSignal('SIGTERM'));

try {
  await main();
} finally {
  activeMonitor?.finish();
  activeClient?.destroy();
  if (activeBridge) {
    await stopBridge(activeBridge);
  }
  await fs.rm(runtime, { recursive: true, force: true });
}

async function main() {
  if (!installArg) {
    await installPackages(runtime);
  } else {
    await fs.symlink(path.join(installation, 'node_modules'), path.join(runtime, 'node_modules'), 'dir');
  }
  const modules = path.join(runtime, 'node_modules');
  const uiPackage = JSON.parse(await fs.readFile(path.join(modules, 'homebridge-config-ui-x/package.json')));
  const corePackage = JSON.parse(await fs.readFile(path.join(modules, 'homebridge/package.json')));
  assert.equal(uiPackage.version, UI_VERSION);
  assert.equal(corePackage.version, CORE_VERSION);
  await fs.mkdir(path.join(runtime, 'plugins'));
  await fs.mkdir(path.join(runtime, 'storage'));
  await fs.cp(path.join(ROOT, 'tools/automation/fixture-plugin'), path.join(runtime, 'plugins/homebridge-automation-fixture'), { recursive: true });
  await fs.cp(path.join(ROOT, 'tools/automation/alpha-loopback-adapter'),
    path.join(runtime, 'plugins/homebridge-automation-alpha-adapter'), { recursive: true });

  const hapPort = await freePort();
  const controlPort = await freePort();
  assert.notEqual(hapPort, controlPort);
  const username = `0E:${[...randomBytes(5)].map(byte => byte.toString(16).padStart(2, '0')).join(':')}`.toUpperCase();
  const bridgeName = `Hejhome Synthetic ${username.slice(-5).replace(':', '')}`;
  const context = { runtime, modules, hapPort, controlPort, username, bridgeName };
  const fixtureBlock = { name: 'Fixture', platform: 'AutomationFixture', controlPort,
    stateFile: path.join(runtime, 'fixture-state.json') };

  await writeConfig(context, [fixtureBlock]);
  activeBridge = await startBridge(context, 'source-discovery');
  activeClient = await createClient(context);
  const sources = await activeClient.getAllServices();
  const ids = sourceIds(sources);
  assert.equal(sources.filter(service => service.type === 'Lightbulb').length, 3);
  assert.equal(sources.filter(service => service.type === 'ContactSensor').length, 1);
  assert.equal(sources.filter(service => service.type === 'MotionSensor').length, 1);
  assert.equal(sources.filter(service => service.type === 'TemperatureSensor').length, 2);
  assert.equal(sources.filter(service => service.type === 'HumiditySensor').length, 2);
  assert.equal(sources.filter(service => service.type === 'Switch').length, 1);
  step('C0', `official HAP client read ${sources.length} services and stable uniqueIds from loopback core`);
  activeClient.destroy(); activeClient = null;
  await stopBridge(activeBridge); activeBridge = null;
  await assertClosed(context);

  const rules = makeRules(ids);
  const alphaBlock = { name: 'Automation', platform: 'smart-automation', debug: true,
    fixturePin: PIN, fixtureUsername: username, fixtureBridgeName: bridgeName, fixtureHapPort: hapPort,
    smartAutomations: rules };
  await writeConfig(context, [fixtureBlock, alphaBlock]);
  activeBridge = await startBridge(context, 'alpha-engine', true);
  activeClient = await createClient(context);
  const services = await activeClient.getAllServices();
  assert.equal(find(services, 'rgb', 'Lightbulb').uniqueId, ids.rgb);
  const outputs = outputServices(services);
  assert.equal(Object.keys(outputs).length, 6);
  const events = [];
  activeMonitor = await activeClient.monitorCharacteristics(Object.values(outputs));
  activeMonitor.on('service-update', update => {
    for (const item of Array.isArray(update) ? update : [update]) {
      events.push({ at: Date.now(), name: item.serviceName,
        values: Object.fromEntries(item.serviceCharacteristics.map(c => [c.type, c.value])) });
    }
  });
  step('C0', `official ${UI_VERSION} platform/controller monitoring ${rules.length} rules over actual HAP`);

  await checkC1(context, outputs, events);
  await checkHapClient204(context, services);
  await checkC3(context, outputs, events);
  await checkC4(context, outputs, events);
  await checkC5(context, outputs, events);
  await checkC2(context, outputs, events);

  // A second core process restores the same Homebridge accessory cache and
  // fixture state file; no source or installed package is patched.
  const outputIds = Object.fromEntries(Object.entries(outputs).map(([name, service]) => [name, service.uniqueId]));
  await patchDevice(context, 'door', { open: true });
  await hapWrite(context, outputs.Bypass, 'SecuritySystemTargetState', 1);
  await waitForValue(outputs.Bypass, 'SecuritySystemCurrentState', 1);
  activeMonitor.finish(); activeMonitor = null;
  activeClient.destroy(); activeClient = null;
  await stopBridge(activeBridge); activeBridge = null;
  await assertClosed(context);
  activeBridge = await startBridge(context, 'alpha-restart', true);
  activeClient = await createClient(context);
  const restarted = outputServices(await activeClient.getAllServices());
  for (const [name, uniqueId] of Object.entries(outputIds)) {
    assert.equal(restarted[name].uniqueId, uniqueId);
  }
  assert.equal(Number(await readValue(restarted.Ajar, 'ContactSensorState')), 0);
  assert.equal(Number(await readValue(restarted.Average, 'CurrentTemperature')), 24);
  assert.equal(device(await fixtureState(context), 'fan').state.on, true);
  const securityAfterRestart = Number(await readValue(restarted.Bypass, 'SecuritySystemCurrentState'));
  assert.ok([1, 3].includes(securityAfterRestart));
  step('C0/C2/C3/C4', 'restart retained virtual HAP identities, fixture control state, mean and fresh Ajar timer');
  if (securityAfterRestart === 1) {
    step('C5', 'armed bypass state restored after restart with the same open door');
  } else {
    process.stdout.write('LIMITATION C5: armed bypass state did not restore after restart; virtual security is disarmed.\n');
  }
  await waitForValue(restarted.Ajar, 'ContactSensorState', 1, 70000);
  step('C2', 'persisted open contact tripped again after a fresh post-restart minute');
  activeClient.destroy(); activeClient = null;
  await stopBridge(activeBridge); activeBridge = null;
  await assertClosed(context);
  step('C0', 'all child processes stopped and both TCP listeners closed');
}

async function installPackages(directory) {
  const args = ['install', '--global=false', `--prefix=${directory}`, '--no-save', '--ignore-scripts', '--no-audit', '--no-fund',
    `homebridge@${CORE_VERSION}`, `homebridge-config-ui-x@${UI_VERSION}`];
  await runProcess('npm', args, { cwd: directory, env: { ...process.env, npm_config_global: 'false',
    npm_config_userconfig: '/dev/null', npm_config_globalconfig: '/dev/null', npm_config_prefix: directory } }, 180000);
}

async function runProcess(command, args, options, timeoutMs) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    activeCommand = child;
    let output = '';
    child.stdout.on('data', data => {
      output += data;
    });
    child.stderr.on('data', data => {
      output += data;
    });
    const timeout = setTimeout(() => {
      child.kill('SIGKILL'); reject(new Error(`${command} timed out: ${output.slice(-2000)}`));
    }, timeoutMs);
    child.on('error', reject);
    child.on('exit', code => {
      if (activeCommand === child) {
        activeCommand = null;
      }
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} exited ${code}: ${output.slice(-2000)}`));
      }
    });
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function writeConfig(context, platforms) {
  const config = { bridge: { name: context.bridgeName, username: context.username, port: context.hapPort,
    pin: PIN, bind: ['127.0.0.1'] }, accessories: [], platforms };
  await fs.writeFile(path.join(context.runtime, 'storage/config.json'), `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

async function startBridge(context, phase, alpha = false) {
  const logFile = createWriteStream(path.join(context.runtime, `${phase}.log`), { mode: 0o600 });
  const child = spawn(process.execPath, ['--import', path.join(ROOT, 'tools/automation/loopback-listen.mjs'),
    path.join(context.modules, 'homebridge/bin/homebridge.js'), '-P', path.join(context.runtime, 'plugins'),
    '--strict-plugin-resolution', '-U', path.join(context.runtime, 'storage'), '-I', '-Q'], {
    cwd: context.runtime,
    env: { ...process.env, HEJ_AUTOMATION_HAP_PORT: String(context.hapPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const bridge = { child, logFile, output: '', exited: false };
  for (const stream of [child.stdout, child.stderr]) {
    stream.on('data', data => {
      bridge.output += data.toString();
      logFile.write(data);
    });
  }
  child.on('exit', () => {
    bridge.exited = true;
  });
  try {
    await poll(() => bridge.output.includes('FIXTURE_HAP_LOOPBACK')
      && bridge.output.includes('FIXTURE_READY')
      && (!alpha || bridge.output.includes('Engine ready;')), 35000, 100, () => {
      if (bridge.exited) {
        throw new Error(`${phase} exited: ${bridge.output.slice(-3000)}`);
      }
    });
    assert.equal(await connects(context.hapPort), true);
    assert.equal(await connects(context.controlPort), true);
    return bridge;
  } catch (error) {
    await stopBridge(bridge);
    throw error;
  }
}

async function stopBridge(bridge) {
  if (!bridge) {
    return;
  }
  if (!bridge.exited) {
    bridge.child.kill('SIGTERM');
    await Promise.race([new Promise(resolve => bridge.child.once('exit', resolve)),
      new Promise(resolve => setTimeout(resolve, 5000))]);
    if (!bridge.exited) {
      bridge.child.kill('SIGKILL');
      await new Promise(resolve => bridge.child.once('exit', resolve));
    }
  }
  await new Promise(resolve => bridge.logFile.end(resolve));
}

async function connects(port) {
  return await new Promise(resolve => {
    const socket = net.connect({ port, host: '127.0.0.1' });
    socket.setTimeout(500);
    socket.once('connect', () => {
      socket.destroy(); resolve(true);
    });
    socket.once('error', () => {
      socket.destroy(); resolve(false);
    });
    socket.once('timeout', () => {
      socket.destroy(); resolve(false);
    });
  });
}

async function assertClosed(context) {
  await poll(async () => !(await connects(context.hapPort)) && !(await connects(context.controlPort)), 5000, 100);
}

async function createClient(context) {
  const { HapClient } = await import(pathToFileURL(path.join(context.modules, '@homebridge/hap-client/dist/index.js')).href);
  const client = new HapClient({ pin: PIN, config: { autoStartDiscovery: false, instanceAllowList: [context.username] },
    logger: { debug() {}, info() {}, warn() {}, error() {} } });
  client.instances.push({ name: context.bridgeName, ipAddress: '127.0.0.1', port: context.hapPort,
    username: context.username, services: [], connectionFailedCount: 0, configurationNumber: 1 });
  return client;
}

function sourceIds(services) {
  const id = (name, type) => find(services, name, type).uniqueId;
  return { rgb: id('rgb', 'Lightbulb'), white: id('white', 'Lightbulb'), fragile: id('fragile', 'Lightbulb'),
    door: id('door', 'ContactSensor'), motion: id('motion', 'MotionSensor'),
    t1: id('th1 temperature', 'TemperatureSensor'), t2: id('th2 temperature', 'TemperatureSensor'),
    h1: id('th1 humidity', 'HumiditySensor'), fan: id('fan', 'Switch') };
}

function makeRules(ids) {
  return [
    { id: 'group', name: 'Group', type: 'smart-light-group', uniqueIds: [ids.rgb, ids.white, ids.fragile], lightbulbType: 'colour', enabled: true },
    { id: 'ajar', name: 'Ajar', type: 'door-ajar', uniqueIds: [ids.door], openMinutes: 1, repeatMinutes: 1, enabled: true },
    { id: 'humidity', name: 'Humidity control', type: 'humidity-control', uniqueIds: [ids.h1], targetUniqueId: ids.fan,
      onHumidity: 65, offHumidity: 55, enabled: true },
    { id: 'average', name: 'Average', type: 'average-temperature', uniqueIds: [ids.t1, ids.t2], removeAfterMinutes: 1, enabled: true },
    { id: 'security', name: 'Security', type: 'security-system', uniqueIds: [ids.door, ids.motion], autoBypass: false, enabled: true },
    { id: 'bypass', name: 'Security bypass', type: 'security-system', uniqueIds: [ids.door, ids.motion], autoBypass: true, enabled: true },
    { id: 'missing', name: 'Security missing', type: 'security-system', uniqueIds: ['missing-hap-id'], autoBypass: false, enabled: true },
  ];
}

function find(services, name, type) {
  const service = services.find(item => item.serviceName === name && item.type === type);
  assert.ok(service, `missing HAP service ${name}/${type}`);
  return service;
}

function outputServices(services) {
  return { Group: find(services, 'Group', 'Lightbulb'), Ajar: find(services, 'Ajar', 'ContactSensor'),
    Average: find(services, 'Average', 'TemperatureSensor'), Security: find(services, 'Security', 'SecuritySystem'),
    Bypass: find(services, 'Security bypass', 'SecuritySystem'), Missing: find(services, 'Security missing', 'SecuritySystem') };
}

async function readValue(service, type) {
  const characteristic = service.getCharacteristic(type);
  assert.ok(characteristic, `${service.serviceName}.${type} absent`);
  const response = await characteristic.getValue();
  return response?.value;
}

async function hapWrite(context, service, type, value) {
  const characteristic = service.getCharacteristic(type);
  assert.ok(characteristic, `${service.serviceName}.${type} absent`);
  const response = await httpFetch(`http://127.0.0.1:${context.hapPort}/characteristics`, {
    method: 'PUT', headers: { Authorization: PIN, 'Content-Type': 'application/json' },
    body: JSON.stringify({ characteristics: [{ aid: service.aid, iid: characteristic.iid, value }] }),
  });
  assert.equal(response.status, 204, `${service.serviceName}.${type} HAP response ${response.status}`);
  assert.equal(await response.text(), '');
}

async function fixtureState(context) {
  const response = await httpFetch(`http://127.0.0.1:${context.controlPort}/state`);
  assert.equal(response.status, 200);
  return await response.json();
}

async function patchDevice(context, id, patch = {}, failWrite) {
  const response = await httpFetch(`http://127.0.0.1:${context.controlPort}/device`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, patch, failWrite }),
  });
  assert.equal(response.status, 200, `fixture patch ${id}`);
}

function device(state, id) {
  const result = state.devices.find(item => item.id === id);
  assert.ok(result, `fixture ${id} missing`);
  return result;
}

async function waitForValue(service, type, expected, timeoutMs = 5000) {
  await poll(async () => Number(await readValue(service, type)) === expected, timeoutMs, 500);
}

async function poll(check, timeoutMs, intervalMs, before) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (interrupted) {
      throw new Error('Integration run interrupted; child processes are being stopped.');
    }
    before?.();
    if (await check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs));
  }
  throw new Error(`Timed out after ${timeoutMs}ms`);
}

function step(label, result) {
  process.stdout.write(`PASS ${label}: ${result}\n`);
}

async function checkC1(context, outputs, events) {
  await patchDevice(context, 'fragile', {}, true);
  const before = (await fixtureState(context)).writes.length;
  await hapWrite(context, outputs.Group, 'On', true);
  await poll(async () => {
    const state = await fixtureState(context);
    return device(state, 'rgb').state.on && device(state, 'white').state.on;
  }, 5000, 100);
  const state = await fixtureState(context);
  assert.equal(device(state, 'fragile').state.on, false);
  assert.ok(state.writes.slice(before).some(write => write.id === 'fragile' && !write.success));
  assert.ok(state.writes.slice(before).some(write => write.id === 'rgb' && write.key === 'hue'));
  assert.equal(state.writes.slice(before).some(write => write.id === 'white' && write.key === 'hue'), false);
  const count = state.writes.length;
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal((await fixtureState(context)).writes.length, count, 'C1 event loop caused extra writes');
  await patchDevice(context, 'rgb', { on: false });
  assert.equal(Number(await readValue(outputs.Group, 'On')), 1, 'upstream virtual group does not reverse-sync');
  await hapWrite(context, outputs.Group, 'On', false);
  assert.ok(events.some(event => event.name === 'Group'));
  step('C1', 'group propagated compatible HAP writes, isolated one target failure, no loop; reverse sync absent');
}

async function checkHapClient204(context, services) {
  const fan = find(services, 'fan', 'Switch');
  await assert.rejects(fan.getCharacteristic('On').setValue(true), /Unexpected end of JSON input/);
  assert.equal(device(await fixtureState(context), 'fan').state.on, true);
  await patchDevice(context, 'fan', { on: false });
  step('HOST', 'alpha hap-client reported a successful 204 write as failure; fixture state committed');
}

async function checkC3(context) {
  await patchDevice(context, 'th1', { humidity: 66 });
  await poll(async () => device(await fixtureState(context), 'fan').state.on === true, 5000, 100);
  const first = (await fixtureState(context)).writes.filter(write => write.id === 'fan').length;
  await patchDevice(context, 'th1', { humidity: 67 });
  await new Promise(resolve => setTimeout(resolve, 750));
  const next = (await fixtureState(context)).writes.filter(write => write.id === 'fan').length;
  assert.ok(next <= first + 1, `C3 duplicate control count ${first} -> ${next}`);
  await patchDevice(context, 'th1', { humidity: 60 });
  await patchDevice(context, 'fan', { on: false });
  await new Promise(resolve => setTimeout(resolve, 500));
  assert.equal(device(await fixtureState(context), 'fan').state.on, false, 'hysteresis band must hold manual state');
  await patchDevice(context, 'fan', { on: true });
  await patchDevice(context, 'th1', { humidity: 54 });
  await poll(async () => device(await fixtureState(context), 'fan').state.on === false, 5000, 100);
  await patchDevice(context, 'fan', {}, true);
  await patchDevice(context, 'th1', { humidity: 66 });
  await poll(async () => (await fixtureState(context)).writes.some(write => write.id === 'fan' && !write.success), 5000, 100);
  assert.equal(device(await fixtureState(context), 'fan').state.on, false);
  await patchDevice(context, 'fan', {}, false);
  await patchDevice(context, 'th1', { humidity: 67 });
  await poll(async () => device(await fixtureState(context), 'fan').state.on === true, 5000, 100);
  await patchDevice(context, 'fan', { on: false });
  await patchDevice(context, 'th1', { humidity: 72, online: false });
  await poll(async () => device(await fixtureState(context), 'fan').state.on === true, 5000, 100);
  const services = await activeClient.getAllServices();
  const humidity = find(services, 'th1 humidity', 'HumiditySensor');
  assert.equal(Number(await readValue(humidity, 'StatusFault')), 1);
  await patchDevice(context, 'th1', { humidity: 60, online: true });
  step('C3', 'strict thresholds/hold/failed write/retry verified; alpha consumed stale humidity despite StatusFault');
}

async function checkC4(context, outputs) {
  await waitForValue(outputs.Average, 'CurrentTemperature', 22);
  await patchDevice(context, 'th2', { online: false });
  await waitForValue(outputs.Average, 'CurrentTemperature', 20);
  await patchDevice(context, 'th1', { online: false });
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(Number(await readValue(outputs.Average, 'CurrentTemperature')), 20,
    'all failed sources leave last virtual value (upstream limitation)');
  await patchDevice(context, 'th1', { online: true, temperature: 22 });
  await patchDevice(context, 'th2', { online: true, temperature: 26 });
  await waitForValue(outputs.Average, 'CurrentTemperature', 24);
  step('C4', '20/24 mean=22, failed source excluded, all-failed cached output retained, reconnect mean=24');
}

async function checkC5(context, outputs) {
  await patchDevice(context, 'door', { open: true });
  await hapWrite(context, outputs.Security, 'SecuritySystemTargetState', 1);
  await waitForValue(outputs.Security, 'SecuritySystemCurrentState', 3);
  await waitForValue(outputs.Security, 'StatusFault', 1);
  await hapWrite(context, outputs.Bypass, 'SecuritySystemTargetState', 1);
  await waitForValue(outputs.Bypass, 'SecuritySystemCurrentState', 1);
  await patchDevice(context, 'door', { open: false });
  await patchDevice(context, 'door', { open: true });
  await waitForValue(outputs.Bypass, 'SecuritySystemCurrentState', 4);
  await hapWrite(context, outputs.Bypass, 'SecuritySystemTargetState', 3);
  await waitForValue(outputs.Bypass, 'SecuritySystemCurrentState', 3);
  await hapWrite(context, outputs.Missing, 'SecuritySystemTargetState', 1);
  await waitForValue(outputs.Missing, 'SecuritySystemCurrentState', 1);
  await patchDevice(context, 'door', { open: false });
  await hapWrite(context, outputs.Security, 'SecuritySystemTargetState', 1);
  await waitForValue(outputs.Security, 'SecuritySystemCurrentState', 1);
  await patchDevice(context, 'motion', { detected: true });
  await waitForValue(outputs.Security, 'SecuritySystemCurrentState', 4);
  await hapWrite(context, outputs.Security, 'SecuritySystemTargetState', 3);
  await waitForValue(outputs.Security, 'SecuritySystemCurrentState', 3);
  await patchDevice(context, 'motion', { detected: false });
  step('C5', 'armed/rejected/bypass/motion/disarm verified; missing-only sensor still armed (upstream limitation)');
}

async function checkC2(context, outputs, events) {
  await patchDevice(context, 'door', { open: false });
  await waitForValue(outputs.Ajar, 'ContactSensorState', 0);
  await patchDevice(context, 'door', { open: true });
  await new Promise(resolve => setTimeout(resolve, 1000));
  assert.equal(Number(await readValue(outputs.Ajar, 'ContactSensorState')), 0);
  await waitForValue(outputs.Ajar, 'ContactSensorState', 1, 70000);
  step('C2', 'actual one-minute open deadline tripped virtual contact');
  const openedAt = Date.now();
  await poll(() => events.some(event => event.name === 'Ajar' && Number(event.values.ContactSensorState) === 0
    && event.at > openedAt), 70000, 200);
  await poll(() => events.some(event => event.name === 'Ajar' && Number(event.values.ContactSensorState) === 1
    && event.at > openedAt), 5000, 200);
  await patchDevice(context, 'door', { open: false });
  await waitForValue(outputs.Ajar, 'ContactSensorState', 0);
  step('C2', 'repeat pulse and close reset observed as HAP events; no user notification is implied');
  await patchDevice(context, 'door', { open: true, online: false });
  const offlineDoor = find(await activeClient.getAllServices(), 'door', 'ContactSensor');
  assert.equal(Number(await readValue(offlineDoor, 'StatusFault')), 1);
  await waitForValue(outputs.Ajar, 'ContactSensorState', 1, 70000);
  process.stdout.write('LIMITATION C2: alpha tripped on cached open contact despite StatusFault=1.\n');
  await patchDevice(context, 'door', { open: false, online: true });
  await waitForValue(outputs.Ajar, 'ContactSensorState', 0);
}
