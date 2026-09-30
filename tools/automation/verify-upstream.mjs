#!/usr/bin/env node
// Exercises the unmodified UI alpha rule modules from the exact upstream tag.
// This is a contract probe, not a second automation engine.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const TAG = 'v6.0.1-alpha.20';
const SHA = 'b85d97ff3777c6f72a451db9ba8c16bd530fab42';
const MODULES = [
  'smart-light-group', 'door-ajar', 'humidity-control', 'average-temperature', 'security-system',
];
const source = process.argv[2] ?? '/tmp/hejhome-ui-alpha20-source';
async function main() {
  let createdSource = false;
  try {
    try {
      execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, stdio: 'pipe' });
    } catch {
      execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', TAG,
        'https://github.com/homebridge/homebridge-config-ui-x.git', source], { stdio: 'inherit' });
      createdSource = true;
    }
    const actualSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: source, encoding: 'utf8' }).trim();
    assert.equal(actualSha, SHA, `UI source must be ${TAG} at ${SHA}`);
    const scratch = await mkdtemp(path.join(os.tmpdir(), 'hejhome-upstream-rule-probe-'));
    try {
      await writeFile(path.join(scratch, 'package.json'), '{"type":"module"}\n');
      for (const name of MODULES) {
        const relativeFile = `src/smart-automation/rules/${name}.rules-engine.ts`;
        const sourceFile = path.join(source, relativeFile);
        // Read the committed blob: a dirty checkout must not change what "official" means.
        const input = execFileSync('git', ['cat-file', 'blob', `${SHA}:${relativeFile}`],
          { cwd: source, encoding: 'utf8' });
        const output = ts.transpileModule(input, {
          compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
          fileName: sourceFile,
          reportDiagnostics: true,
        });
        assert.equal(output.diagnostics?.length, 0, `${name} transpilation`);
        await writeFile(path.join(scratch, `${name}.rules-engine.js`), output.outputText);
      }
      const modules = Object.fromEntries(await Promise.all(MODULES.map(async name => [
        name, await import(pathToFileURL(path.join(scratch, `${name}.rules-engine.js`)).href),
      ])));
      await verify(modules);
      console.log(`PASS official Smart Automation ${TAG} ${SHA}: C1-C5 rule contract`);
      console.log('LIMITATION C1: source changes do not update the published group-light state.');
      console.log('LIMITATION C2/C3: the rule modules do not inspect StatusFault or source age.');
      console.log('LIMITATION C4: after all sources fail, the virtual sensor retains its last published value.');
      console.log('LIMITATION C5: an unresolved input does not prevent arming.');
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  } finally {
    // The user may provide a reusable checkout; only remove the checkout created here.
    if (createdSource) {
      await rm(source, { recursive: true, force: true });
    }
  }
}

function service(uniqueId, type, values, options = {}) {
  const writes = [];
  const characteristics = Object.entries(values).map(([characteristicType, value]) => ({
    type: characteristicType, value, canWrite: options.writable?.includes(characteristicType) ?? false,
    async setValue(next) {
      if (options.failWrite === characteristicType) {
        throw new Error('write refused');
      }
      writes.push([characteristicType, next]);
      this.value = next;
    },
    async getValue() {
      if (options.failRead === characteristicType) {
        throw new Error('read refused');
      }
      return { value: this.value };
    },
  }));
  return {
    uniqueId, type, serviceName: uniqueId, serviceCharacteristics: characteristics, writes,
    getCharacteristic: characteristicType => characteristics.find(c => c.type === characteristicType),
    set(characteristicType, value) {
      this.getCharacteristic(characteristicType).value = value;
    },
  };
}

function sourceOf(services) {
  const listeners = new Set();
  return {
    getServices: async () => services,
    onServicesChanged: listener => {
      listeners.add(listener); return () => listeners.delete(listener);
    },
    changed: async (...ids) => {
      for (const listener of listeners) {
        listener(new Set(ids));
      }
      // Rule event handlers are async; let their microtasks settle.
      await new Promise(resolve => setTimeout(resolve, 0));
    },
  };
}

const log = { debug() {}, info() {}, warn() {} };
const config = (type, ids, extra = {}) => ({ id: `probe-${type}`, name: type, type, uniqueIds: ids, enabled: true, ...extra });

async function verify(m) {
  // C1: the host sends only characteristics each selected light can write;
  // one target failure does not prevent a later target from being written.
  const rgb = service('rgb', 'Lightbulb', { On: false, Brightness: 50, Hue: 100, Saturation: 60 },
    { writable: ['On', 'Brightness', 'Hue', 'Saturation'] });
  const white = service('white', 'Lightbulb', { On: false, Brightness: 40, ColorTemperature: 250 },
    { writable: ['On', 'Brightness', 'ColorTemperature'], failWrite: 'On' });
  const plain = service('plain', 'Lightbulb', { On: false }, { writable: ['On'] });
  const group = new m['smart-light-group'].SmartLightGroupRulesEngine(
    config('smart-light-group', ['rgb', 'white', 'plain'], { lightbulbType: 'colour' }), sourceOf([rgb, white, plain]), log);
  await group.setOn(true);
  await group.setCharacteristic('Hue', 180);
  assert.deepEqual(rgb.writes.at(-1), ['Hue', 180]);
  assert.equal(white.writes.some(([type]) => type === 'Hue'), false);
  assert.equal(plain.writes.some(([type]) => type === 'Hue'), false);
  assert.deepEqual(plain.writes[0], ['On', true]);
  await group.setOn(false);

  // C2: contact 1 starts the timer; close clears it. A missing value is not open.
  let now = 0;
  const contact = service('door', 'ContactSensor', { ContactSensorState: 0 });
  const doors = sourceOf([contact]);
  const alertStates = [];
  const ajar = new m['door-ajar'].DoorAjarRulesEngine(
    config('door-ajar', ['door'], { openMinutes: 1, repeatMinutes: 1 }), doors, log, () => now);
  ajar.start(value => alertStates.push(value));
  await ajar.tick();
  contact.set('ContactSensorState', 1); await ajar.tick();
  now = 59_000; await ajar.tick(); assert.deepEqual(alertStates, [false]);
  now = 60_000; await ajar.tick(); assert.deepEqual(alertStates, [false, true]);
  now = 120_000; await ajar.tick(); assert.deepEqual(alertStates, [false, true, false]);
  await new Promise(resolve => setTimeout(resolve, 1050));
  assert.deepEqual(alertStates, [false, true, false, true]);
  contact.set('ContactSensorState', 0); await ajar.tick();
  assert.deepEqual(alertStates, [false, true, false, true, false]);
  contact.set('ContactSensorState', undefined); await ajar.tick();
  assert.deepEqual(alertStates, [false, true, false, true, false]);
  ajar.stop();
  // A still-cached open value is consumed even when StatusFault says unavailable.
  const staleDoor = service('stale-door', 'ContactSensor', { ContactSensorState: 1, StatusFault: 1 });
  const staleStates = [];
  const staleAjar = new m['door-ajar'].DoorAjarRulesEngine(
    config('door-ajar', ['stale-door'], { openMinutes: 1, repeatMinutes: 1 }), sourceOf([staleDoor]), log, () => now);
  staleAjar.start(value => staleStates.push(value));
  await staleAjar.tick(); now += 60_000; await staleAjar.tick();
  assert.deepEqual(staleStates, [false, true]);
  staleAjar.stop();

  // C3: strict thresholds, hysteresis, manual target changes, no missing reading writes.
  const humidity = service('humidity', 'HumiditySensor', { CurrentRelativeHumidity: 60 });
  const fan = service('fan', 'Switch', { On: false }, { writable: ['On'] });
  const humid = new m['humidity-control'].HumidityControlRulesEngine(
    config('humidity-control', ['humidity'], { targetUniqueId: 'fan', onHumidity: 60, offHumidity: 50 }),
    sourceOf([humidity, fan]), log);
  await humid.tick(); assert.equal(fan.writes.length, 0);
  humidity.set('CurrentRelativeHumidity', 61); await humid.tick();
  assert.deepEqual(fan.writes, [['On', true]]);
  humidity.set('CurrentRelativeHumidity', 55); await humid.tick();
  assert.equal(fan.writes.length, 1);
  humidity.set('CurrentRelativeHumidity', 49); await humid.tick();
  assert.deepEqual(fan.writes.at(-1), ['On', false]);
  fan.set('On', true); await humid.tick();
  assert.deepEqual(fan.writes.at(-1), ['On', false]);
  humidity.set('CurrentRelativeHumidity', undefined); await humid.tick();
  assert.equal(fan.writes.length, 3);
  humidity.set('CurrentRelativeHumidity', 70);
  humidity.serviceCharacteristics.push({ type: 'StatusFault', value: 1, canWrite: false });
  await humid.tick();
  assert.deepEqual(fan.writes.at(-1), ['On', true]);
  const on = fan.getCharacteristic('On');
  const originalSet = on.setValue;
  on.value = false;
  on.setValue = async () => {
    throw new Error('cloud refused');
  };
  const writesBeforeFailure = fan.writes.length;
  await humid.tick();
  assert.equal(fan.writes.length, writesBeforeFailure);
  on.setValue = originalSet;
  await humid.tick();
  assert.deepEqual(fan.writes.at(-1), ['On', true]);

  // C4: only CurrentTemperature, not TargetTemperature; failed fresh read is excluded.
  const t1 = service('t1', 'TemperatureSensor', { CurrentTemperature: 20 });
  const t2 = service('t2', 'Thermostat', { CurrentTemperature: 24, TargetTemperature: 29 });
  const temps = sourceOf([t1, t2]);
  const averages = [];
  const avg = new m['average-temperature'].AverageTemperatureRulesEngine(
    config('average-temperature', ['t1', 't2'], { removeAfterMinutes: 1 }), temps, log, () => now);
  avg.start(value => averages.push(value));
  await avg.tick(); assert.equal(averages.at(-1), 22);
  t2.getCharacteristic('CurrentTemperature').getValue = async () => {
    throw new Error('offline');
  };
  await avg.tick(); assert.equal(averages.at(-1), 20);
  t1.getCharacteristic('CurrentTemperature').getValue = async () => {
    throw new Error('offline');
  };
  const count = averages.length;
  await avg.tick(); assert.equal(averages.length, count);
  assert.equal(averages.at(-1), 20);
  avg.stop();

  // C5: reject open-contact arm without bypass; bypassed contact becomes protected on close.
  const secDoor = service('sec-door', 'ContactSensor', { ContactSensorState: 1 });
  const motion = service('motion', 'MotionSensor', { MotionDetected: false });
  const securitySource = sourceOf([secDoor, motion]);
  const securityStates = [];
  const faults = [];
  const Security = m['security-system'].SecuritySystemRulesEngine;
  const reject = new Security(config('security-system', ['sec-door', 'motion'], { autoBypass: false }), securitySource, log);
  reject.start(value => securityStates.push(value), value => faults.push(value));
  assert.equal(await reject.setTargetState(1), 3);
  assert.equal(faults.at(-1), 1);
  reject.stop();
  const bypass = new Security(config('security-system', ['sec-door', 'motion'], { autoBypass: true }), securitySource, log);
  bypass.start(value => securityStates.push(value), value => faults.push(value));
  assert.equal(await bypass.setTargetState(1), 1);
  await bypass.tick(new Set(['sec-door'])); assert.equal(securityStates.at(-1), 1);
  secDoor.set('ContactSensorState', 0); await bypass.tick(new Set(['sec-door']));
  secDoor.set('ContactSensorState', 1); await bypass.tick(new Set(['sec-door']));
  assert.equal(securityStates.at(-1), 4);
  await bypass.setTargetState(3);
  motion.set('MotionDetected', true); await bypass.tick(new Set(['motion']));
  assert.equal(securityStates.at(-1), 3);
  bypass.stop();
  const unresolved = new Security(config('security-system', ['absent'], { autoBypass: false }), sourceOf([]), log);
  unresolved.start(() => undefined);
  assert.equal(await unresolved.setTargetState(1), 1);
  unresolved.stop();
}

await main();
