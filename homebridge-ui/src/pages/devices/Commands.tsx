import { useRef } from 'react';
import { Callout, Text, TextField } from '@radix-ui/themes';
import { InfoCircledIcon, SpeakerLoudIcon, SpeakerQuietIcon, SpeakerOffIcon, ChevronUpIcon, ChevronDownIcon } from '@radix-ui/react-icons';
import { useApp } from '../../core';
import { Button } from '../../core/radix';
import type { Device } from '../../core/types';
import { Choice, Field } from './Fields';
import { remoteTypes } from './model';

export interface CommandState {
  values: Record<string, string>;
  pending: boolean;
  message: string;
  failed: boolean;
}

export const emptyCommandState: CommandState = { values: {}, pending: false, message: '', failed: false };

export function DeviceCommands({ device, available, state, update }: {
  device: Device; available: boolean; state: CommandState; update(patch: Partial<CommandState>): void;
}) {
  const app = useApp();
  const { t } = app;
  const sending = useRef(false);
  const epoch = useRef(app.accountEpoch);
  epoch.current = app.accountEpoch;
  const remote = remoteTypes.has(device.deviceType);
  const hvac = device.deviceType === 'IrAirconditioner';
  const purifier = device.deviceType === 'Airpurifier';
  if (!remote && !hvac && !purifier) {
    return null;
  }
  const canSend = available && app.controlsReady && device.online !== false && !state.pending;
  const input = (key: string, value: string) => update({ values: { ...state.values, [key]: value } });
  const send = async (command: Record<string, unknown>) => {
    if (!canSend || sending.current) {
      return;
    }
    const owner = app.accountEpoch;
    sending.current = true;
    update({ pending: true, failed: false, message: t('명령을 보내고 있어요…', 'Sending command…') });
    try {
      await app.mutate(remote ? '/remote-command' : hvac ? '/air-conditioner-command' : '/purifier-command',
        { deviceId: device.id, command }, { key: `device-command:${device.id}`, requireControls: true });
      if (epoch.current === owner) {
        update({ failed: false, message: t('명령 전송 완료 · 실제 기기 동작은 확인되지 않았습니다.',
          'Command sent · physical operation is not confirmed.') });
      }
    } catch (error) {
      if (epoch.current === owner) {
        update({ failed: true, message: error instanceof Error ? error.message : t('명령 전송에 실패했습니다.', 'Could not send the command.') });
      }
    } finally {
      sending.current = false;
      if (epoch.current === owner) {
        update({ pending: false });
      }
    }
  };
  const reject = (message: string) => update({ message, failed: true });
  const button = (label: string, key: string, command: Record<string, unknown>) => <Button
    key={key} size="3" variant="soft" type="button" disabled={!canSend} data-command-key={key} onClick={() => void send(command)}>{label}</Button>;
  const unknown = t('확인할 수 없음', 'Unknown');
  const power = (value: unknown) => value === true ? t('켜짐', 'On') : value === false ? t('꺼짐', 'Off') : unknown;
  const modes: Array<[string, string]> = hvac
    ? [['cool', t('냉방', 'Cool')], ['heat', t('난방', 'Heat')], ['auto', t('자동', 'Auto')], ['fan', t('송풍', 'Fan')], ['dry', t('제습', 'Dry')]]
    : [['auto', t('자동', 'Auto')], ['manual', t('수동', 'Manual')], ['sleep', t('취침', 'Sleep')]];
  const speeds: Array<[string, string]> = [['auto', t('자동', 'Auto')], ['low', t('약', 'Low')], ['medium', t('중', 'Medium')], ['high', t('강', 'High')]];
  const showReported = available && app.ready && app.fresh && app.diagnostics?.connection?.session === 'valid';
  const reported = showReported ? (hvac ? device.hvacSettings : device.purifierSettings) : null;
  const reading = (label: string, value: string) => <div key={label} className="device-reading">
    <Text size="1" color="gray">{label}</Text><Text weight="medium">{value}</Text></div>;

  return <div id="deviceActionMount" data-device-id={device.id} className="device-command-panel">
    <Callout.Root size="1" color="gray"><Callout.Icon><InfoCircledIcon /></Callout.Icon><Callout.Text>
      {t('버튼을 누를 때 명령을 한 번 보냅니다. 응답은 실제 동작을 보장하지 않으며, 시간 초과 시 자동 재전송하지 않습니다.',
        'Each button sends one command. A response does not confirm physical operation. Timed-out commands are not retried automatically.')}
    </Callout.Text></Callout.Root>
    {!canSend && !state.pending && <Text as="p" color="amber" size="2">{t('최근 상태와 Homebridge 연결을 확인한 뒤 조작할 수 있습니다.',
      'Controls become available after recent device status and the Homebridge connection are confirmed.')}</Text>}
    {(hvac || purifier) && <div className="device-reported-settings">
      <Text as="p" size="2" weight="medium">{t('마지막으로 읽은 설정', 'Last reported settings')}</Text>
      <div className="device-reading-grid" data-hvac-device-id={hvac ? device.id : undefined} data-purifier-device-id={purifier ? device.id : undefined}>
        {reading(t('전원', 'Power'), power(reported?.power))}
        {reading(t('운전 방식', 'Mode'), modes.find(([key]) => key === reported?.mode)?.[1] ?? unknown)}
        {hvac && reading(t('설정 온도', 'Target temperature'), Number.isInteger(reported?.targetTemperature) ? `${reported?.targetTemperature} °C` : unknown)}
        {hvac && reading(t('바람 세기', 'Fan speed'), speeds.find(([key]) => key === reported?.fanSpeed)?.[1] ?? unknown)}
      </div>
      {hvac && <Text as="p" size="2" data-temperature-device-id={device.id}>{t('현재 온도', 'Current temperature')}:
        {' '}{showReported && typeof device.temperatureCelsius === 'number'
        && Number.isFinite(device.temperatureCelsius) ? `${device.temperatureCelsius} °C` : unknown}
        <Text as="span" size="1" color="gray">{t(' · 연결한 온도계의 측정값', ' · measured by the linked thermometer')}</Text></Text>}
    </div>}
    {remote && <div className="device-command-grid">
      {device.deviceType === 'IrFan' ? <>
        {button(t('회전 버튼', 'Swing button'), 'swing', { type: 'swing' })}
        {button(t('바람 세기 버튼', 'Fan speed button'), 'cycleSpeed', { type: 'cycleSpeed' })}
      </> : <>
        <Button size="3" type="button" variant="soft" disabled={!canSend} data-command-key="volume:up"
          onClick={() => void send({ type: 'volume', direction: 'up' })}><SpeakerLoudIcon />{t('소리 크게', 'Volume up')}</Button>
        <Button size="3" type="button" variant="soft" disabled={!canSend} data-command-key="volume:down"
          onClick={() => void send({ type: 'volume', direction: 'down' })}><SpeakerQuietIcon />{t('소리 작게', 'Volume down')}</Button>
        <Button size="3" type="button" variant="soft" disabled={!canSend} data-command-key="channel:up"
          onClick={() => void send({ type: 'channel', direction: 'up' })}><ChevronUpIcon />{t('다음 채널', 'Next channel')}</Button>
        <Button size="3" type="button" variant="soft" disabled={!canSend} data-command-key="channel:down"
          onClick={() => void send({ type: 'channel', direction: 'down' })}><ChevronDownIcon />{t('이전 채널', 'Previous channel')}</Button>
        <Button size="3" type="button" variant="soft" disabled={!canSend} data-command-key="mute:true"
          onClick={() => void send({ type: 'mute', muted: true })}><SpeakerOffIcon />{t('소리 끄기', 'Mute')}</Button>
        {button(t('소리 켜기', 'Unmute'), 'mute:false', { type: 'mute', muted: false })}
      </>}
    </div>}
    {remote && device.deviceType !== 'IrFan' && <div className="device-command-row">
      <Field id={`channel-${device.id}`} label={t('채널 번호', 'Channel number')}>
        <TextField.Root id={`channel-${device.id}`} size="3" type="number" min="0" max="999" step="1"
          data-device-control="channel" value={state.values.channel ?? ''} onChange={(event) => input('channel', event.target.value)} /></Field>
      <Button type="button" size="3" highContrast disabled={!canSend} data-command-key="setChannel" onClick={() => {
        const value = state.values.channel ?? '';
        if (!/^\d{1,3}$/.test(value) || Number(value) > 999) {
          reject(t('0부터 999까지의 채널 번호를 입력해 주세요.', 'Enter a channel number from 0 to 999.'));
          return;
        }
        void send({ type: 'setChannel', channel: Number(value) });
      }}>{t('채널 이동', 'Go to channel')}</Button>
    </div>}
    {(hvac || purifier) && <>
      <div className="device-command-actions">
        {button(hvac ? t('에어컨 켜기', 'Turn on AC') : t('공기청정기 켜기', 'Turn on purifier'), 'power:true', { power: true })}
        {button(hvac ? t('에어컨 끄기', 'Turn off AC') : t('공기청정기 끄기', 'Turn off purifier'), 'power:false', { power: false })}
      </div>
      {hvac && <div className="device-command-row">
        <Field id={`temperature-${device.id}`} label={t('바꿀 설정 온도(°C)', 'New target temperature (°C)')}>
          <TextField.Root id={`temperature-${device.id}`} size="3" type="number"
            min="16" max="30" step="1" data-device-control="targetTemperature" value={state.values.targetTemperature ?? ''}
            onChange={(event) => input('targetTemperature', event.target.value)} /></Field>
        <Button size="3" type="button" highContrast disabled={!canSend} data-command-key="temperature" onClick={() => {
          const raw = state.values.targetTemperature ?? '';
          const temperature = Number(raw);
          if (!raw.trim() || !Number.isInteger(temperature) || temperature < 16 || temperature > 30) {
            reject(t('16도부터 30도까지의 정수를 입력해 주세요.', 'Enter a whole number from 16 to 30 degrees.'));
            return;
          }
          void send({ temperature });
        }}>{t('온도 설정', 'Set temperature')}</Button>
      </div>}
      <div className="device-command-row">
        <Field id={`mode-${device.id}`} label={t('바꿀 운전 방식', 'New mode')}><Choice id={`mode-${device.id}`} control={hvac ? 'hvacMode' : 'purifierMode'}
          value={state.values.mode ?? (hvac ? 'cool' : 'auto')} options={modes} onChange={(value) => input('mode', value)} /></Field>
        <Button size="3" type="button" highContrast disabled={!canSend} data-command-key="mode"
          onClick={() => void send({ mode: state.values.mode ?? (hvac ? 'cool' : 'auto') })}>{t('운전 방식 설정', 'Set mode')}</Button>
      </div>
      {hvac && <div className="device-command-row">
        <Field id={`speed-${device.id}`} label={t('바꿀 바람 세기', 'New fan speed')}><Choice id={`speed-${device.id}`} control="hvacFanSpeed"
          value={state.values.fanSpeed ?? 'auto'} options={speeds} onChange={(value) => input('fanSpeed', value)} /></Field>
        <Button size="3" type="button" highContrast disabled={!canSend} data-command-key="fanSpeed"
          onClick={() => void send({ fanSpeed: state.values.fanSpeed ?? 'auto' })}>{t('바람 세기 설정', 'Set fan speed')}</Button>
      </div>}
    </>}
    <Text as="p" role="status" aria-live="polite" color={state.failed ? 'red' : 'gray'} size="2" data-command-status="true">{state.message}</Text>
  </div>;
}
