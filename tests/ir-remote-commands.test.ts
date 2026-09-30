import { describe, expect, test, vi } from 'vitest';

import { createIrRemoteRequirements, executeRemoteCommand } from '../src/media/irRemoteCommands.js';

describe('Hejhome IR remote commands', () => {
  test('encodes the TV volume-up button using the verified vendor field', () => {
    expect(createIrRemoteRequirements('IrTv', { type: 'volume', direction: 'up' })).toEqual({ volume: 'up' });
  });

  test('encodes each verified TV and set-top button without inventing state', () => {
    expect(createIrRemoteRequirements('IrTv', { type: 'volume', direction: 'down' })).toEqual({ volume: 'down' });
    expect(createIrRemoteRequirements('IrTv', { type: 'channel', direction: 'up' })).toEqual({ channel: 'up' });
    expect(createIrRemoteRequirements('IrSettopbox', { type: 'channel', direction: 'down' })).toEqual({ channel: 'down' });
    expect(createIrRemoteRequirements('IrSettopbox', { type: 'setChannel', channel: 0 })).toEqual({ setChannel: 0 });
    expect(createIrRemoteRequirements('IrTv', { type: 'setChannel', channel: 999 })).toEqual({ setChannel: 999 });
    expect(createIrRemoteRequirements('IrTv', { type: 'mute', muted: true })).toEqual({ mute: true });
    expect(createIrRemoteRequirements('IrSettopbox', { type: 'mute', muted: false })).toEqual({ mute: false });
  });

  test('encodes verified fan buttons as momentary pulses', () => {
    expect(createIrRemoteRequirements('IrFan', { type: 'cycleSpeed' })).toEqual({ fanSpeed: true });
    expect(createIrRemoteRequirements('IrFan', { type: 'swing' })).toEqual({ swing: true });
  });

  test.each([
    ['IrSpeaker', { type: 'volume', direction: 'up' }],
    ['IrTvbox', { type: 'volume', direction: 'up' }],
    ['IrTv', { type: 'cycleSpeed' }],
    ['IrFan', { type: 'volume', direction: 'up' }],
    ['IrFan', { type: 'mute', muted: true }],
    ['IrTv', { type: 'power' }],
    ['IrTv', { type: 'input', input: 1 }],
    ['IrTv', { type: 'play' }],
  ])('rejects unsupported model or command: %s %j', (model, command) => {
    expect(() => createIrRemoteRequirements(model, command)).toThrow();
  });

  test.each([
    null,
    [],
    {},
    { type: 'volume', direction: 'left' },
    { type: 'volume', direction: 'up', power: true },
    { type: 'channel', direction: 1 },
    { type: 'setChannel', channel: -1 },
    { type: 'setChannel', channel: 1000 },
    { type: 'setChannel', channel: 1.5 },
    { type: 'setChannel', channel: '42' },
    { type: 'setChannel', channel: NaN },
    { type: 'mute', muted: 'false' },
    { type: 'swing', enabled: false },
  ])('rejects malformed command payload: %j', (command) => {
    const model = (command as { type?: string } | null)?.type === 'swing' ? 'IrFan' : 'IrTv';
    expect(() => createIrRemoteRequirements(model, command)).toThrow();
  });

  test('dispatches only validated requirements and leaves the device state untouched', async () => {
    const device = { id: 'tv-1', deviceType: 'IrTv', deviceState: { power: false } };
    const send = vi.fn(async () => undefined);

    await executeRemoteCommand(device, { type: 'volume', direction: 'up' }, send);

    expect(send).toHaveBeenCalledExactlyOnceWith('tv-1', { volume: 'up' });
    expect(device.deviceState).toEqual({ power: false });
  });

  test('does not send unsupported commands', async () => {
    const send = vi.fn(async () => undefined);
    await expect(executeRemoteCommand({ id: 'speaker-1', deviceType: 'IrSpeaker' }, { type: 'volume', direction: 'up' }, send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });

  test('propagates transport failure instead of reporting command success', async () => {
    const failure = new Error('HTTP 401');
    const send = vi.fn(async () => {
      throw failure;
    });
    await expect(executeRemoteCommand({ id: 'tv-1', deviceType: 'IrTv' }, { type: 'mute', muted: true }, send)).rejects.toBe(failure);
  });

  test('rejects empty device IDs before transport', async () => {
    const send = vi.fn(async () => undefined);
    await expect(executeRemoteCommand({ id: ' ', deviceType: 'IrTv' }, { type: 'mute', muted: true }, send)).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
