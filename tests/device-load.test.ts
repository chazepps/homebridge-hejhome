import { describe, expect, test } from 'vitest';
import { OutletLoadTracker } from '../src/devices/load.js';

describe('calibrated outlet load', () => {
  test('requires two seconds of sustained load and hysteresis', () => {
    const tracker = new OutletLoadTracker({ field: 'curPower', multiplier: 0.1 });
    expect(tracker.read(0)).toBeNull();
    tracker.observe({ curPower: 0 }, 0);
    expect(tracker.read(0)).toBe(false);
    tracker.observe({ curPower: 12 }, 100);
    expect(tracker.read(2099)).toBe(false);
    tracker.observe({ curPower: 12 }, 2100);
    expect(tracker.read(2100)).toBe(true);
    tracker.observe({ curPower: 7 }, 2200);
    expect(tracker.read(2200)).toBe(true);
    tracker.observe({ curPower: 4 }, 2300);
    tracker.observe({ curPower: 4 }, 4300);
    expect(tracker.read(4300)).toBe(false);
  });
  test('does not report missing, invalid or expired readings as no load', () => {
    const tracker = new OutletLoadTracker({ field: 'curPower', multiplier: 1 });
    tracker.observe({ power: true }, 0);
    expect(tracker.read(0)).toBeNull();
    tracker.observe({ curPower: 15 }, 10);
    expect(tracker.read(10)).toBe(true);
    tracker.observe({ power: false }, 20);
    expect(tracker.read(20)).toBe(true);
    expect(tracker.read(300011)).toBeNull();
    for (const value of [null, '', -1, NaN, Infinity, true]) {
      tracker.observe({ curPower: value }, 400000);
      expect(tracker.read(400000)).toBeNull();
    }
  });
});

test('does not restore expired classification from an ambiguous new sample', () => {
  for (const old of [0, 10]) {
    const tracker = new OutletLoadTracker({ field: 'curPower', multiplier: 1 });
    tracker.observe({ curPower: old }, 0);
    expect(tracker.read(300001)).toBeNull();
    tracker.observe({ curPower: 0.7 }, 300002);
    expect(tracker.read(300002)).toBeNull();
  }
});

test('uses the configured freshness duration including its exact boundary', () => {
  const tracker = new OutletLoadTracker({ field: 'curPower', multiplier: 1 }, 600000);
  tracker.observe({ curPower: 3 }, 0);
  expect(tracker.read(300000)).toBe(true);
  expect(tracker.read(599999)).toBe(true);
  expect(tracker.read(600000)).toBeNull();
  tracker.observe({ curPower: 0.7 }, 600000);
  expect(tracker.read(600000)).toBeNull();
});

test('clock rollback and external invalidation cannot revive an old load classification', () => {
  const tracker = new OutletLoadTracker({ field: 'power', multiplier: 1 });
  tracker.observe({ power: 10 }, 1000);
  expect(tracker.read(999)).toBeNull();
  tracker.observe({ power: 0.7 }, 999);
  expect(tracker.read(999)).toBeNull();
  tracker.observe({ power: 10 }, 2000);
  tracker.invalidate();
  tracker.observe({ power: 0.7 }, 2001);
  expect(tracker.read(2001)).toBeNull();
});
