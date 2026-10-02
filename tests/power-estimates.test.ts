import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, test, vi } from 'vitest';
import { PowerEstimates, powerEstimateSupport } from '../src/runtime/powerEstimates.js';
import { EstimatedEnergyStore, estimatedEnergyOwner } from '../src/storage/estimatedEnergyStore.js';
import type { HejDevice } from '../src/types.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) {
    await fn();
  }
});
const lamp = (power: unknown = true): HejDevice => ({ id: 'lamp', name: 'Lamp', deviceType: 'LightRgbw5', deviceState: { power } });
async function fixture(spec = { activeWatts: 10, standbyWatts: 0.1 }, meters = []) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'hej-estimated-energy-'));
  let time = 0;
  const store = new EstimatedEnergyStore(dir);
  const engine = new PowerEstimates({ lamp: { powerSpec: spec } }, meters, store, vi.fn(), () => time);
  cleanup.push(async () => {
    engine.setConnected(false); await engine.flush(); await fs.rm(dir, { recursive: true, force: true });
  });
  await engine.loadAccount('owner-a');
  engine.setConnected(true);
  const advance = (ms: number) => {
    for (let left = ms; left > 0;) {
      const step = Math.min(left, 2000); time += step; engine.tick(); left -= step;
    }
  };
  return { engine, store, dir, advance, setTime: (value: number) => {
    time = value;
  } };
}

test('native single loads are eligible while IR, DC relay and ambiguous loads are rejected', () => {
  for (const deviceType of ['LightRgbw5', 'LightWw1', 'Plug', 'Switch1', 'ZigbeeSwitch1', 'RelayController', 'Airpurifier']) {
    expect(powerEstimateSupport({ ...lamp(), deviceType }).supported).toBe(true);
  }
  for (const deviceType of ['IrAirconditioner', 'IrTv', 'Curtain', 'SensorTh', 'Switch2', 'ZigbeeSwitch2', 'PowerStrip', 'RelayControllerDc']) {
    expect(powerEstimateSupport({ ...lamp(), deviceType }).supported).toBe(false);
  }
  expect(powerEstimateSupport({ ...lamp(), deviceType: 'RelayController', deviceState: { power1: true, power2: false } }).supported).toBe(false);
});

test('integrates only verified active and standby intervals in mWh without brightness scaling', async () => {
  const { engine, advance } = await fixture();
  expect(engine.project(lamp())).toMatchObject({ activePower: null, cumulativeEnergyImported: null });
  engine.observe(lamp(), lamp().deviceState!);
  expect(engine.project(lamp())).toMatchObject({ activePower: 10000, cumulativeEnergyImported: 0 });
  advance(3600000);
  expect(engine.project(lamp())?.cumulativeEnergyImported).toBe(10000);
  engine.observe(lamp(false), { power: false });
  advance(3600000);
  expect(engine.project(lamp(false))).toMatchObject({ activePower: 100, cumulativeEnergyImported: 10100 });
});

test('missing specification or unverified power is unknown, including after command suspension', async () => {
  const { engine, advance } = await fixture({ activeWatts: 10 } as never);
  engine.observe(lamp(), { power: true }); advance(3600);
  engine.suspend('lamp');
  advance(3600000);
  engine.observe(lamp(), { brightness: 80 });
  expect(engine.project(lamp())).toMatchObject({ activePower: null, cumulativeEnergyImported: 10 });
  engine.observe(lamp(false), { power: false }); advance(3600000);
  expect(engine.project(lamp(false))).toMatchObject({ activePower: null, cumulativeEnergyImported: 10 });
});

test('stale in-flight discovery cannot resume a command or disconnected interval', async () => {
  const { engine, advance } = await fixture();
  engine.observe(lamp(), { power: true }); advance(3600);
  const beforeCommand = engine.capture();
  engine.suspend('lamp');
  engine.observe(lamp(), { power: true }, beforeCommand);
  expect(engine.project(lamp())?.activePower).toBeNull();
  engine.observe(lamp(false), { power: false }, engine.capture());
  advance(3600);
  expect(engine.project(lamp(false))?.cumulativeEnergyImported).toBe(10);
  const beforeDisconnect = engine.capture();
  engine.setConnected(false); advance(3600000); engine.setConnected(true);
  engine.observe(lamp(), { power: true }, beforeDisconnect);
  expect(engine.project(lamp())?.activePower).toBeNull();
  engine.observe(lamp(), { power: true }); advance(3600);
  expect(engine.project(lamp())?.cumulativeEnergyImported).toBe(20);
});

test('offline and clock discontinuities pause integration without inventing a resume', async () => {
  const { engine, advance, setTime } = await fixture();
  engine.observe(lamp(), { power: true }); advance(3600);
  engine.observe({ ...lamp(), online: false }, {}); advance(3600);
  expect(engine.project(lamp())?.activePower).toBeNull();
  engine.observe(lamp(), { power: true }); setTime(1); engine.tick();
  expect(engine.project(lamp())?.activePower).toBeNull();
  engine.observe(lamp(), { power: true }); setTime(99999999); engine.tick();
  expect(engine.project(lamp())).toMatchObject({ activePower: null, cumulativeEnergyImported: 10 });
});

test('stores only cumulative totals, reloads before observation, and isolates stable accounts', async () => {
  const { engine, advance, store, dir } = await fixture();
  engine.observe(lamp(), { power: true }); advance(3600); await engine.flush();
  const next = new PowerEstimates({ lamp: { powerSpec: { activeWatts: 10 } } }, [], store, vi.fn(), () => 99999999);
  await next.loadAccount('owner-a'); next.setConnected(true);
  expect(next.project(lamp())).toMatchObject({ activePower: null, cumulativeEnergyImported: 10 });
  await next.loadAccount('owner-b');
  expect(next.project(lamp())?.cumulativeEnergyImported).toBeNull();
  await next.loadAccount('owner-a');
  expect(next.project(lamp())?.cumulativeEnergyImported).toBe(10);
  expect(estimatedEnergyOwner('owner-a')).not.toBe(estimatedEnergyOwner('owner-b'));
  const files = await fs.readdir(path.join(dir, 'hejhome'));
  const data = await fs.readFile(path.join(dir, 'hejhome', files.find((f) => f.endsWith('.json'))!), 'utf8');
  expect(data).not.toContain('owner-a');
  expect(data).not.toContain('activePower');
});

test('meter profiles suppress manual fallback even when the measured state is missing', async () => {
  const { dir } = await fixture();
  for (const measurement of ['power', 'energy']) {
    const engine = new PowerEstimates({ lamp: { powerSpec: { activeWatts: 10 } } }, [{ model: 'meter', [measurement]: { field: 'reading', multiplier: 1 } }],
      new EstimatedEnergyStore(dir), vi.fn());
    await engine.loadAccount('owner-a'); engine.setConnected(true);
    const device = { ...lamp(), modelName: 'meter' };
    engine.observe(device, { power: true });
    expect(engine.project(device)).toBeUndefined();
  }
});

test('energy storage rejects corrupt, out-of-range and cross-owner payloads', async () => {
  const { dir, store } = await fixture();
  const file = path.join(dir, 'hejhome', `estimated-energy-${estimatedEnergyOwner('owner-a')}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  for (const data of ['not json', JSON.stringify({ version: 1, owner: estimatedEnergyOwner('owner-b'), totals: { lamp: 8 } }),
    JSON.stringify({ version: 1, owner: estimatedEnergyOwner('owner-a'), totals: { lamp: -1 } }),
    JSON.stringify({ version: 1, owner: estimatedEnergyOwner('owner-a'), totals: { lamp: 1e20 } })]) {
    await fs.writeFile(file, data);
    expect(await store.load('owner-a')).toEqual({});
  }
});

test('coalesces durable writes to a minute and flushes the final observed interval', async () => {
  const { engine, advance, dir } = await fixture();
  engine.observe(lamp(), { power: true }); advance(58000);
  expect(await fs.readdir(path.join(dir, 'hejhome')).catch(() => [])).toEqual([]);
  advance(2000); await engine.flush();
  const file = path.join(dir, 'hejhome', `estimated-energy-${estimatedEnergyOwner('owner-a')}.json`);
  const first = await fs.readFile(file, 'utf8'); advance(58000);
  expect(await fs.readFile(file, 'utf8')).toBe(first);
  engine.setConnected(false); await engine.flush();
  expect((await new EstimatedEnergyStore(dir).load('owner-a')).lamp).toBeCloseTo(327.7777777778);
});


test('unknown native purifier power cannot be treated as standby', async () => {
  const { engine } = await fixture();
  const purifier = { ...lamp(), deviceType: 'Airpurifier', deviceState: {} };
  expect(powerEstimateSupport(purifier).powerField).toBe('power');
  engine.observe(purifier, { power: 'unrecognized' });
  expect(engine.project(purifier)?.activePower).toBeNull();
  engine.observe(purifier, { power: 'false' });
  expect(engine.project(purifier)?.activePower).toBe(100);
});

test('losing single-load eligibility ends the old power interval immediately', async () => {
  const { engine, advance } = await fixture();
  engine.observe(lamp(), { power: true }); advance(3600);
  engine.observe({ ...lamp(), deviceState: { power: true, power2: false } }, { power2: false });
  advance(3600);
  expect(engine.project(lamp())).toMatchObject({ activePower: null, cumulativeEnergyImported: 10 });
});

test('a discovery begun before a newer native power report cannot replace that report', async () => {
  const { engine } = await fixture();
  const snapshotStarted = engine.capture();
  engine.observe(lamp(false), { power: false });
  engine.observe(lamp(), { power: true }, snapshotStarted);
  expect(engine.project(lamp())?.activePower).toBe(100);
});

test('a failed durable write can be retried after the filesystem recovers', async () => {
  const { engine, store, dir } = await fixture();
  engine.observe(lamp(), { power: true });
  const destination = path.join(dir, 'hejhome');
  await fs.writeFile(destination, 'blocks-directory');
  await expect(engine.flush()).rejects.toThrow();
  await fs.unlink(destination);
  expect(await store.load('owner-a')).toEqual({});
  await engine.flush();
  expect(await store.load('owner-a')).toEqual({ lamp: 0 });
});

test('invalid energy data emits a recovery warning instead of claiming retained history', async () => {
  const { dir } = await fixture();
  const warnings: unknown[] = [];
  const store = new EstimatedEnergyStore(dir, (error) => warnings.push(error));
  const file = path.join(dir, 'hejhome', `estimated-energy-${estimatedEnergyOwner('owner-a')}.json`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, 'broken JSON');
  expect(await store.load('owner-a')).toEqual({});
  expect(warnings).toHaveLength(1);
  expect(String(warnings[0])).toContain('previous cumulative history is unavailable');
});

test('cumulative energy saturates inside the declared safe range', async () => {
  const { engine, store, advance } = await fixture();
  await store.save('owner-a', { lamp: 999999999999999 });
  await engine.loadAccount('owner-a'); engine.setConnected(true);
  engine.observe(lamp(), { power: true }); advance(3600);
  expect(engine.project(lamp())?.cumulativeEnergyImported).toBe(1000000000000000);
});

test('an account-load I/O failure hides previous-owner energy while keeping the old total recoverable', async () => {
  const { engine, store, dir, advance } = await fixture();
  engine.observe(lamp(), { power: true }); advance(3600); await engine.flush();
  const nextFile = path.join(dir, 'hejhome', `estimated-energy-${estimatedEnergyOwner('owner-b')}.json`);
  await fs.mkdir(nextFile);
  await expect(engine.loadAccount('owner-b')).rejects.toThrow();
  engine.setConnected(true); engine.observe(lamp(), { power: true }); advance(3600);
  expect(engine.project(lamp())).toMatchObject({ activePower: null, cumulativeEnergyImported: null });
  await fs.rmdir(nextFile);
  await engine.loadAccount('owner-a');
  expect(engine.project(lamp())?.cumulativeEnergyImported).toBe(10);
  expect(await store.load('owner-a')).toMatchObject({ lamp: 10 });
});
