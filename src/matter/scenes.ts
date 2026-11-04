import type { MatterAPI, MatterAccessory } from 'homebridge';
import { cachedScene, sceneUuidSeed, type SceneContext } from '../scenes.js';
import { PLUGIN_NAME, PLATFORM_NAME } from '../settings.js';

// Leave a visible pulse beyond Matter's report batching and the controller's command response.
const RESET_DELAY_MS = 1000;

interface Entry {
  scene: SceneContext;
  accessory: MatterAccessory;
  attached: boolean;
  removed: boolean;
  confirmed: boolean;
  pending: Promise<void> | null;
  reset: ReturnType<typeof setTimeout> | null;
}

/** Recipe endpoints are separate from the physical device inventory and its pruning. */
export class MatterSceneAdapter {
  private readonly entries = new Map<string, Entry>();
  private disposed = false;

  constructor(
    private readonly api: MatterAPI,
    private readonly run: (scene: SceneContext) => Promise<void>,
    private readonly onError: (error: unknown) => void,
  ) {}

  restore(accessory: MatterAccessory): void {
    const scene = cachedScene(accessory);
    if (scene) {
      this.entries.set(accessory.UUID, this.entry(scene, accessory));
    }
  }

  async prune(enabled: boolean): Promise<void> {
    for (const [uuid, entry] of this.entries) {
      if (!enabled) {
        await this.remove(uuid, entry);
      } else {
        entry.confirmed = false;
        try {
          await this.api.updateAccessoryState(uuid, 'bridgedDeviceBasicInformation', { reachable: false });
        } catch (error) {
          // A stale recipe endpoint must never prevent the physical devices from starting.
          this.onError(error);
        }
      }
    }
  }

  async reconcile(scenes: Iterable<SceneContext>, selected: Set<number>, listed: Set<number>,
    confirmed: (scene: SceneContext) => boolean): Promise<void> {
    if (this.disposed) {
      return;
    }
    const wanted = new Map([...scenes].map((scene) => [this.uuid(scene), scene]));
    for (const [uuid, entry] of this.entries) {
      if (!wanted.has(uuid)) {
        if (selected.has(entry.scene.familyId) && !listed.has(entry.scene.familyId)) {
          wanted.set(uuid, entry.scene);
        } else {
          await this.remove(uuid, entry);
        }
      }
    }
    for (const [uuid, scene] of wanted) {
      if (this.disposed) {
        return;
      }
      let entry = this.entries.get(uuid);
      if (entry?.removed) {
        try {
          if (await this.api.getAccessoryState(uuid, 'onOff') !== undefined) {
            // Let an outstanding removal finish before reviving this UUID.
            await this.remove(uuid, entry);
            continue;
          }
        } catch (error) {
          this.onError(error);
          continue;
        }
        // Do not send another removal event for an already-gone endpoint: it could
        // arrive after the replacement registration and delete the new endpoint.
        this.entries.delete(uuid);
        entry = undefined;
      }
      if (!entry) {
        entry = this.entry(scene);
        this.entries.set(uuid, entry);
      }
      entry.scene = scene;
      entry.confirmed = confirmed(scene);
      entry.removed = false;
      entry.accessory = this.build(entry, uuid);
      try {
        if (entry.attached) {
          await this.api.updatePlatformAccessories([entry.accessory]);
        } else {
          await this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [entry.accessory]);
          // Homebridge's event-based public registration can resolve before the endpoint is ready.
          const deadline = Date.now() + 5000;
          while (!await this.api.getAccessoryState(uuid, 'onOff')) {
            if (this.disposed) {
              return;
            }
            if (Date.now() >= deadline) {
              throw new Error(`Timed out registering recipe ${scene.name}`);
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
          entry.attached = true;
        }
        await this.api.updateAccessoryState(uuid, 'onOff', { onOff: false });
        await this.api.updateAccessoryState(uuid, 'bridgedDeviceBasicInformation', { reachable: entry.confirmed });
      } catch (error) {
        this.onError(error);
      }
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const entry of this.entries.values()) {
      this.deactivate(entry);
    }
  }

  private uuid(scene: SceneContext): string {
    return this.api.uuid.generate(`hejhome:matter:${sceneUuidSeed(scene)}`);
  }

  private entry(scene: SceneContext, accessory?: MatterAccessory): Entry {
    return { scene, accessory: accessory!, attached: false, removed: false, confirmed: false, pending: null, reset: null };
  }

  private build(entry: Entry, uuid: string): MatterAccessory {
    // Matter's nodeLabel is limited to 32 UTF-16 code units; preserve surrogate pairs.
    let name = '';
    for (const symbol of entry.scene.name) {
      if (name.length + symbol.length > 32) {
        break;
      }
      name += symbol;
    }
    return { UUID: uuid, displayName: name, deviceType: this.api.deviceTypes.OnOffOutlet,
      manufacturer: 'Hejhome', model: 'Recipe', serialNumber: uuid.replaceAll('-', '').slice(0, 32),
      context: { scene: { ...entry.scene } },
      clusters: { onOff: { onOff: false }, bridgedDeviceBasicInformation: { reachable: entry.confirmed, nodeLabel: name } },
      // Homebridge's native Toggle delegates to its On/Off behavior after this hook.
      // Executing here as well would run the same recipe twice for one command.
      handlers: { onOff: { on: () => this.press(entry), toggle: async () => {}, off: async () => {} } } };
  }

  private async press(entry: Entry): Promise<void> {
    if (this.disposed || entry.removed || !entry.confirmed) {
      throw new this.api.status.Failure('Recipe unavailable.');
    }
    const pending = entry.pending ??= this.run(entry.scene);
    try {
      await pending;
      if (this.disposed || entry.removed || !entry.confirmed) {
        throw new Error('Recipe unavailable.');
      }
    } catch {
      throw new this.api.status.Failure('Recipe execution failed.');
    } finally {
      if (entry.pending === pending) {
        entry.pending = null;
      }
      if (!this.disposed && !entry.removed) {
        if (entry.reset) {
          clearTimeout(entry.reset);
        }
        // A zero-delay reset can coalesce On/Off into one report before Apple Home
        // finishes its optimistic On update, leaving the tile on until a later report.
        entry.reset = setTimeout(() => {
          entry.reset = null;
          void this.api.updateAccessoryState(entry.accessory.UUID, 'onOff', { onOff: false }).catch(this.onError);
        }, RESET_DELAY_MS);
      }
    }
  }

  private deactivate(entry: Entry): void {
    entry.removed = true;
    entry.confirmed = false;
    if (entry.reset) {
      clearTimeout(entry.reset);
    }
    entry.reset = null;
  }

  private async remove(uuid: string, entry: Entry): Promise<void> {
    this.deactivate(entry);
    try {
      await this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [entry.accessory]);
      // Bridged unregister resolves when its event is sent, before native endpoint.close().
      // Keep tracking a still-present endpoint so a later watcher tick can retry a late failure.
      if (await this.api.getAccessoryState(uuid, 'onOff') === undefined) {
        this.entries.delete(uuid);
      }
    } catch (error) {
      this.onError(error);
    }
  }
}
