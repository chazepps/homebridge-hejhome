import type { Characteristic, PlatformAccessory, Service } from 'homebridge';
import type { IrRemoteCommand } from './irRemoteCommands.js';

interface IrHapButtonsOptions {
  accessory: PlatformAccessory;
  Service: typeof Service;
  Characteristic: typeof Characteristic;
  deviceType: string;
  enabled: boolean;
  send(command: IrRemoteCommand): Promise<void>;
  ensureAvailable?(): void;
}

interface Button {
  subtype: string;
  name: string;
  command: IrRemoteCommand;
}

const TV_BUTTONS: readonly Button[] = [
  { subtype: 'remote-volume-up', name: '소리 크게', command: { type: 'volume', direction: 'up' } },
  { subtype: 'remote-volume-down', name: '소리 작게', command: { type: 'volume', direction: 'down' } },
  { subtype: 'remote-channel-up', name: '다음 채널', command: { type: 'channel', direction: 'up' } },
  { subtype: 'remote-channel-down', name: '이전 채널', command: { type: 'channel', direction: 'down' } },
  { subtype: 'remote-mute-on', name: '소리 끄기', command: { type: 'mute', muted: true } },
  { subtype: 'remote-mute-off', name: '소리 켜기', command: { type: 'mute', muted: false } },
];

const FAN_BUTTONS: readonly Button[] = [
  { subtype: 'remote-fan-speed', name: '바람 세기 버튼', command: { type: 'cycleSpeed' } },
  { subtype: 'remote-fan-swing', name: '회전 버튼', command: { type: 'swing' } },
];

const ALL_BUTTONS = [...TV_BUTTONS, ...FAN_BUTTONS];

/** Adds commandable momentary switches to the existing bridged accessory. */
export class IrHapButtons {
  private static readonly owners = new WeakMap<Service, IrHapButtons>();
  private disposed = false;
  private readonly resetTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly ownedServices = new Set<Service>();

  constructor(private readonly options: IrHapButtonsOptions) {
    const { accessory, Service, Characteristic, deviceType, enabled } = options;
    const buttons = !enabled ? [] : deviceType === 'IrTv' || deviceType === 'IrSettopbox'
      ? TV_BUTTONS : deviceType === 'IrFan' ? FAN_BUTTONS : [];
    const wanted = new Set(buttons.map((button) => button.subtype));

    for (const button of ALL_BUTTONS) {
      const cached = accessory.getServiceById(Service.Switch, button.subtype);
      if (cached && !wanted.has(button.subtype)) {
        accessory.removeService(cached);
      }
    }

    for (const button of buttons) {
      const name = `${accessory.displayName} ${button.name}`;
      const service = accessory.getServiceById(Service.Switch, button.subtype)
        ?? accessory.addService(Service.Switch, name, button.subtype);
      IrHapButtons.owners.set(service, this);
      this.ownedServices.add(service);
      service.displayName = name;
      for (const characteristic of [Characteristic.Name, Characteristic.ConfiguredName]) {
        if (service.testCharacteristic(characteristic)) {
          service.updateCharacteristic(characteristic, name);
        }
      }
      service.getCharacteristic(Characteristic.On)
        .onGet(() => {
          this.assertActive();
          this.options.ensureAvailable?.();
          return false;
        })
        .onSet(async (value) => {
          this.assertActive();
          if (value !== true && value !== 1) {
            return;
          }
          this.options.ensureAvailable?.();
          await this.options.send(button.command);
          this.assertActive();
          const previous = this.resetTimers.get(button.subtype);
          if (previous) {
            clearTimeout(previous);
          }
          // HAP commits the requested value after onSet resolves.
          this.resetTimers.set(button.subtype, setTimeout(() => {
            this.resetTimers.delete(button.subtype);
            if (!this.disposed) {
              service.updateCharacteristic(Characteristic.On, false);
            }
          }, 0));
        });
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.resetTimers.values()) {
      clearTimeout(timer);
    }
    this.resetTimers.clear();
    for (const service of this.ownedServices) {
      if (IrHapButtons.owners.get(service) === this) {
        service.updateCharacteristic(this.options.Characteristic.On, false);
        IrHapButtons.owners.delete(service);
      }
    }
    this.ownedServices.clear();
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error('IR remote button is no longer available.');
    }
  }
}
