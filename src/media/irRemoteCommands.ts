/** Verified button commands from the public Hejhome web UI for these exact device types. */
export type IrRemoteCommand =
  | { type: 'volume'; direction: 'up' | 'down' }
  | { type: 'channel'; direction: 'up' | 'down' }
  | { type: 'setChannel'; channel: number }
  | { type: 'mute'; muted: boolean }
  | { type: 'cycleSpeed' }
  | { type: 'swing' };

export type IrRemoteRequirements =
  | { volume: 'up' | 'down' }
  | { channel: 'up' | 'down' }
  | { setChannel: number }
  | { mute: boolean }
  | { fanSpeed: true }
  | { swing: true };

export type IrRemoteSend = (id: string, requirements: IrRemoteRequirements) => Promise<void>;

export function createIrRemoteRequirements(deviceType: string, command: unknown): IrRemoteRequirements {
  if (deviceType !== 'IrTv' && deviceType !== 'IrSettopbox' && deviceType !== 'IrFan') {
    throw new TypeError('Unsupported IR remote device type.');
  }
  if (!isObject(command) || typeof command.type !== 'string') {
    throw new TypeError('Invalid IR remote command.');
  }

  if (deviceType === 'IrFan') {
    if (command.type === 'cycleSpeed' && hasOnlyKeys(command, 'type')) {
      return { fanSpeed: true };
    }
    if (command.type === 'swing' && hasOnlyKeys(command, 'type')) {
      return { swing: true };
    }
    throw new TypeError('Unsupported IR fan command.');
  }

  if (command.type === 'volume' && isDirection(command.direction) && hasOnlyKeys(command, 'type', 'direction')) {
    return { volume: command.direction };
  }
  if (command.type === 'channel' && isDirection(command.direction) && hasOnlyKeys(command, 'type', 'direction')) {
    return { channel: command.direction };
  }
  if (command.type === 'setChannel' && Number.isInteger(command.channel) &&
      typeof command.channel === 'number' && command.channel >= 0 && command.channel <= 999 &&
      hasOnlyKeys(command, 'type', 'channel')) {
    return { setChannel: command.channel };
  }
  if (command.type === 'mute' && typeof command.muted === 'boolean' && hasOnlyKeys(command, 'type', 'muted')) {
    return { mute: command.muted };
  }
  throw new TypeError('Unsupported IR TV command.');
}

/** Sends one button request without asserting any physical or cached state. */
export async function executeRemoteCommand(
  device: { id: string; deviceType: string },
  command: unknown,
  send: IrRemoteSend,
): Promise<void> {
  if (typeof device?.id !== 'string' || device.id.trim() === '') {
    throw new TypeError('Invalid IR remote device ID.');
  }
  const requirements = createIrRemoteRequirements(device.deviceType, command);
  await send(device.id, requirements);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDirection(value: unknown): value is 'up' | 'down' {
  return value === 'up' || value === 'down';
}

function hasOnlyKeys(value: Record<string, unknown>, ...keys: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}
