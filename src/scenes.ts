import type { API, Characteristic, PlatformAccessory, Service } from 'homebridge';

export interface SceneContext {
  familyId: number;
  sceneId: string;
  name: string;
}

interface SceneSwitchOptions {
  accessory: PlatformAccessory;
  hap: API['hap'];
  scene: SceneContext;
  run(scene: SceneContext): Promise<void>;
}

/** Scenes have no readable state, so the same family and scene ID always map to one stable accessory. */
export function sceneUuidSeed(scene: Pick<SceneContext, 'familyId' | 'sceneId'>): string {
  return `scene:${scene.familyId}:${scene.sceneId}`;
}

export function cachedScene(accessory: PlatformAccessory): SceneContext | undefined {
  const scene = accessory.context.scene as Partial<SceneContext> | undefined;
  return typeof scene?.familyId === 'number' && typeof scene.sceneId === 'string' && typeof scene.name === 'string'
    ? { familyId: scene.familyId, sceneId: scene.sceneId, name: scene.name } : undefined;
}

/** A momentary switch: turning it on runs the scene, then it returns to off. */
export class HejhomeSceneSwitch {
  private disposed = false;
  private pending: Promise<void> | null = null;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private scene: SceneContext;
  private readonly service: Service;
  private readonly on: Characteristic;

  constructor(private readonly options: SceneSwitchOptions) {
    const { accessory, hap, scene } = options;
    this.scene = scene;
    this.service = accessory.getService(hap.Service.Switch) ?? accessory.addService(hap.Service.Switch, scene.name);
    this.applyMetadata();
    this.on = this.service.getCharacteristic(hap.Characteristic.On)
      .onGet(() => false)
      .onSet(async (value) => {
        if (value !== true && value !== 1) {
          return;
        }
        if (this.disposed) {
          throw this.failure();
        }
        // A request that arrives mid-run shares the same outcome instead of reporting a false success.
        const run = this.pending ??= this.execute();
        try {
          await run;
        } finally {
          if (this.pending === run) {
            this.pending = null;
          }
        }
        // A switch removed or shut down mid-run is gone, so it never reports the run as done.
        if (this.disposed) {
          throw this.failure();
        }
        this.scheduleReset();
      });
  }

  /** Re-discovery keeps this handler (and any run in flight); only the scene metadata is refreshed. */
  update(scene: SceneContext): void {
    this.scene = scene;
    this.applyMetadata();
  }

  /** Settles the switch to off now; nothing changes it afterwards. */
  dispose(): void {
    this.disposed = true;
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
    if (this.on.value !== false) {
      this.on.updateValue(false);
    }
  }

  private applyMetadata(): void {
    const { accessory, hap } = this.options;
    const scene = this.scene;
    accessory.context.scene = { familyId: scene.familyId, sceneId: scene.sceneId, name: scene.name };
    accessory.displayName = scene.name;
    accessory.getService(hap.Service.AccessoryInformation)!
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Hejhome')
      .setCharacteristic(hap.Characteristic.Model, 'Scene')
      .setCharacteristic(hap.Characteristic.SerialNumber, `${scene.familyId}/${scene.sceneId}`);
    this.service.displayName = scene.name;
    for (const characteristic of [hap.Characteristic.Name, hap.Characteristic.ConfiguredName]) {
      if (this.service.testCharacteristic(characteristic)) {
        this.service.updateCharacteristic(characteristic, scene.name);
      }
    }
  }

  private async execute(): Promise<void> {
    try {
      await this.options.run(this.scene);
    } catch {
      throw this.failure();
    }
  }

  private failure(): Error {
    return new this.options.hap.HapStatusError(this.options.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private scheduleReset(): void {
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
    }
    // HAP commits the requested value after onSet resolves, so the reset must come after that.
    this.resetTimer = setTimeout(() => {
      this.resetTimer = null;
      this.on.updateValue(false);
    }, 0);
  }
}
