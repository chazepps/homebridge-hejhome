import type { HejDevice } from '../types.js';
import { mergeDeviceState } from '../platformAccessory.js';

type State = Record<string, unknown>;

/** Revisions represent received observations, never local optimistic writes. */
export class StateObservations {
  private next = 0;
  private readonly devices = new Map<string, Map<string, number>>();

  record(id: string, patch: State): void {
    const revision = ++this.next;
    const fields = this.devices.get(id) ?? new Map<string, number>();
    const paths = leafPaths(patch);
    // The normalized color command also writes the shared brightness field.
    if (paths.some((parts) => parts.join('.') === 'hsvColor.brightness')) {
      paths.push(['brightness']);
    }
    if (Object.hasOwn(patch, 'brightness')) {
      paths.push(['hsvColor', 'brightness']);
    }
    for (const parts of paths) {
      fields.set(JSON.stringify(parts), revision);
    }
    this.devices.set(id, fields);
  }

  capture(id: string): ReadonlyMap<string, number> {
    return new Map(this.devices.get(id));
  }

  commit(id: string, current: HejDevice, requirements: State, baseline: ReadonlyMap<string, number>): { device: HejDevice; conflicted: boolean } {
    const normalized = mergeDeviceState({ ...current, deviceState: {} }, requirements).deviceState ?? {};
    const device = mergeDeviceState(current, requirements);
    const state: State = structuredClone(device.deviceState ?? {});
    let conflicted = false;
    for (const parts of leafPaths(normalized)) {
      const key = JSON.stringify(parts);
      if ((this.devices.get(id)?.get(key) ?? 0) !== (baseline.get(key) ?? 0)) {
        conflicted = true;
        restorePath(state, parts, current.deviceState ?? {});
      }
    }
    return { device: { ...device, deviceState: state }, conflicted };
  }

  clear(): void {
    this.devices.clear();
  }
  remove(id: string): void {
    this.devices.delete(id);
  }
}

function leafPaths(value: State, prefix: string[] = []): string[][] {
  return Object.entries(value).flatMap(([key, entry]) => {
    const parts = [...prefix, key];
    return entry && typeof entry === 'object' && !Array.isArray(entry) && Object.keys(entry).length
      ? leafPaths(entry as State, parts) : [parts];
  });
}
function restorePath(target: State, parts: string[], current: State): void {
  let cursor = target;
  let source: unknown = current;
  for (const key of parts.slice(0, -1)) {
    const nested = cursor[key];
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) {
      cursor[key] = {};
    }
    cursor = cursor[key] as State;
    source = source && typeof source === 'object' ? (source as State)[key] : undefined;
  }
  const leaf = parts[parts.length - 1]!;
  if (source && typeof source === 'object' && Object.hasOwn(source, leaf)) {
    cursor[leaf] = structuredClone((source as State)[leaf]);
  } else {
    delete cursor[leaf];
  }
}
