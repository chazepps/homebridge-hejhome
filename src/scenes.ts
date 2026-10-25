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
  private running = false;
  private resetTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly service: Service;
  private readonly Characteristic: typeof Characteristic;

  constructor(private readonly options: SceneSwitchOptions) {
    const { accessory, hap, scene } = options;
    this.Characteristic = hap.Characteristic;
    accessory.context.scene = { familyId: scene.familyId, sceneId: scene.sceneId, name: scene.name };
    accessory.displayName = scene.name;

    accessory.getService(hap.Service.AccessoryInformation)!
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Hejhome')
      .setCharacteristic(hap.Characteristic.Model, 'Scene')
      .setCharacteristic(hap.Characteristic.SerialNumber, `${scene.familyId}/${scene.sceneId}`);

    this.service = accessory.getService(hap.Service.Switch) ?? accessory.addService(hap.Service.Switch, scene.name);
    this.service.displayName = scene.name;
    for (const characteristic of [hap.Characteristic.Name, hap.Characteristic.ConfiguredName]) {
      if (this.service.testCharacteristic(characteristic)) {
        this.service.updateCharacteristic(characteristic, scene.name);
      }
    }
    this.service.getCharacteristic(hap.Characteristic.On)
      .onGet(() => false)
      .onSet(async (value) => {
        if (this.disposed || (value !== true && value !== 1) || this.running) {
          return;
        }
        this.running = true;
        try {
          await this.options.run(scene);
        } catch {
          throw new hap.HapStatusError(hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
        } finally {
          this.running = false;
        }
        if (this.resetTimer) {
          clearTimeout(this.resetTimer);
        }
        // HAP commits the requested value after onSet resolves, so the reset must come after that.
        this.resetTimer = setTimeout(() => {
          this.resetTimer = null;
          if (!this.disposed) {
            this.service.updateCharacteristic(this.Characteristic.On, false);
          }
        }, 0);
      });
  }

  dispose(): void {
    this.disposed = true;
    if (this.resetTimer) {
      clearTimeout(this.resetTimer);
      this.resetTimer = null;
    }
  }
}
