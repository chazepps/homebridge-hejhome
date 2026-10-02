import { useState } from 'react';
import { Callout, Heading, IconButton, Switch, Tabs, Text, TextField } from '@radix-ui/themes';
import { ArrowLeftIcon, CheckIcon, GearIcon, InfoCircledIcon, MixerHorizontalIcon } from '@radix-ui/react-icons';
import { useApp, useDraft } from '../../core';
import { Badge, Button } from '../../core/radix';
import type { Device, DevicePreference } from '../../core/types';
import { Choice, Field } from './Fields';
import { DeviceCommands, type CommandState } from './Commands';
import { DeviceStatus } from './Status';
import { deviceKind, editorValue, remoteTypes, sensorTypes, serializePreference, type DeviceEditorValue } from './model';

export function DeviceInspector({ device, available, onClose, command, updateCommand, onSaved, saved }: {
  device: Device; available: boolean; onClose(): void; command: CommandState; updateCommand(patch: Partial<CommandState>): void;
  onSaved(): void; saved: boolean;
}) {
  const app = useApp();
  const { t } = app;
  const draft = useDraft<DeviceEditorValue>(`device:${device.id}`, editorValue(device.preference));
  const [validation, setValidation] = useState('');
  const value = draft.value;
  const id = (name: string) => `device-${device.id}-${name}`;
  const sensors = (app.diagnostics?.devices ?? []).filter((item) => sensorTypes.has(item.deviceType));
  const supportsCommands = remoteTypes.has(device.deviceType) || ['IrAirconditioner', 'Airpurifier'].includes(device.deviceType);
  const supportsFreshness = sensorTypes.has(device.deviceType) || device.meterProfileApplied || device.deviceType === 'Airpurifier';
  const freshnessActive = sensorTypes.has(device.deviceType) || device.meterProfileApplied
    || device.deviceType === 'Airpurifier' && Number(value.pm25Multiplier) > 0;
  const inactiveFreshness = !freshnessActive && Boolean(value.freshnessMinutes.trim());
  const changedIdentity = value.visibility !== (device.preference?.visibility ?? 'both') || value.role !== (device.preference?.role ?? 'original');
  const update = (patch: Partial<DeviceEditorValue>) => {
    if (!available) {
      return;
    }
    setValidation('');
    const next = { ...value, ...patch };
    if (['matter', 'hidden'].includes(next.visibility)) {
      next.remoteButtons = false;
    }
    if (device.deviceType === 'Airpurifier' && !device.meterProfileApplied && patch.pm25Multiplier?.trim() === '') {
      next.freshnessMinutes = '';
    }
    draft.setValue(next);
  };
  const save = async () => {
    if (!available || !app.writable || draft.pending || !draft.dirty) {
      return;
    }
    setValidation('');
    try {
      await draft.save(async (submitted) => {
        const currentDevice = app.diagnostics?.devices.find((item) => item.id === device.id && item.inScope);
        if (!currentDevice || app.diagnostics?.deviceListAvailable !== true) {
          throw new Error(t('장치 목록을 다시 확인한 뒤 저장해 주세요.', 'Refresh the device list before saving.'));
        }
        const preference = serializePreference(submitted, currentDevice, app.diagnostics?.devices ?? [], t);
        const response = await app.mutate<{ preference?: DevicePreference }>('/save-device-settings',
          { deviceId: device.id, preference }, { key: `device-settings:${device.id}` });
        return editorValue(response.preference ?? preference);
      });
      onSaved();
      app.notify('success', t('저장했습니다. Homebridge를 다시 시작해 주세요.', 'Saved. Please restart Homebridge.'));
      void app.refreshDiagnostics();
    } catch (error) {
      setValidation(error instanceof Error ? error.message : t('저장하지 못했습니다.', 'Could not save.'));
    }
  };
  return <aside className="device-inspector section-card" data-testid="device-detail" data-device-id={device.id} aria-labelledby="deviceDetailTitle">
    <div className="device-inspector-header">
      <IconButton id="backToDevices" size="3" variant="ghost" aria-label={t('장치 목록으로', 'Back to devices')} onClick={onClose}><ArrowLeftIcon /></IconButton>
      <div><Text as="p" size="1" color="gray">{deviceKind(device, t)}</Text><Heading as="h2" size="5" id="deviceDetailTitle">{device.name}</Heading></div>
      {draft.dirty && <Badge highContrast color="amber" id="deviceDirtyNotice">{t('저장 전', 'Unsaved')}</Badge>}
    </div>
    {!available && <Callout.Root color="amber" size="1"><Callout.Icon><InfoCircledIcon /></Callout.Icon><Callout.Text>
      {t('이 장치를 현재 목록에서 확인할 수 없습니다. 작성한 내용은 보관되며, 장치를 다시 확인하면 저장할 수 있습니다.',
        'This device is unavailable in the current list. Your draft is kept until the device is available again.')}
    </Callout.Text></Callout.Root>}
    <DeviceStatus device={device} available={available} />
    <Tabs.Root defaultValue="settings">
      <Tabs.List aria-label={t('장치 상세 메뉴', 'Device detail sections')}>
        <Tabs.Trigger value="settings"><GearIcon />{t('설정', 'Settings')}</Tabs.Trigger>
        {supportsCommands && <Tabs.Trigger value="controls"><MixerHorizontalIcon />{t('조작', 'Controls')}</Tabs.Trigger>}
      </Tabs.List>
      <Tabs.Content value="settings" className="device-settings-content">
        <form onSubmit={(event) => {
          event.preventDefault(); void save();
        }} noValidate>
          <div className="device-settings-grid" id="deviceSettingsList">
            <Field id={id('name')} label={t('표시 이름', 'Display name')} help={t('비워 두면 원래 이름을 사용합니다.', 'Leave blank to use the original name.')}>
              <TextField.Root id={id('name')} size="3" data-device-control="name" maxLength={64} value={value.name}
                placeholder={device.name} disabled={!available}
                onChange={(event) => update({ name: event.target.value })} aria-describedby={`${id('name')}-help`} />
            </Field>
            <Field id={id('visibility')} label={t('연결 방식', 'Connections')}>
              <Choice id={id('visibility')} control="visibility" value={value.visibility} disabled={!available}
                onChange={(next) => update({ visibility: next as DeviceEditorValue['visibility'] })}
                options={[['both', t('Apple Home와 Matter', 'Apple Home and Matter')], ['homekit', t('Apple Home만', 'Apple Home only')],
                  ['matter', t('Matter만', 'Matter only')], ['hidden', t('표시하지 않음', 'Do not show')]]} />
            </Field>
            {device.roleChangeSupported && <Field id={id('role')} label={t('Home 앱에서 보이는 형태', 'Appearance in Home')}>
              <Choice id={id('role')} control="role" value={value.role} disabled={!available}
                onChange={(next) => update({ role: next as DeviceEditorValue['role'] })}
                options={[['original', t('원래 장치 형태', 'Original device type')], ['light', t('조명', 'Light')],
                  ['outlet', t('콘센트', 'Outlet')], ['switch', t('스위치', 'Switch')]]} />
            </Field>}
            {device.deviceType === 'IrAirconditioner' && <Field id={id('sensor')} label={t('현재 온도를 확인할 온도계', 'Thermometer for current temperature')}
              help={t('설정 온도와 별개인 실제 측정값을 사용합니다.', 'Uses measured temperature, separate from the target temperature.')}>
              <Choice id={id('sensor')} control="temperatureSensor" value={value.temperatureSensorId} disabled={!available}
                onChange={(next) => update({ temperatureSensorId: next })}
                options={[['', t('선택하지 않음', 'None')], ...sensors.map((sensor): [string, string] => [sensor.id, sensor.name]),
                  ...(value.temperatureSensorId && !sensors.some((sensor) => sensor.id === value.temperatureSensorId)
                    ? [[value.temperatureSensorId, t('사용할 수 없는 온도계', 'Unavailable thermometer')] as [string, string]] : [])]} />
            </Field>}
            {(supportsFreshness || inactiveFreshness) && <Field id={id('freshness')} label={t('측정값 유효 시간(분)', 'Measurement validity (minutes)')}
              help={inactiveFreshness
                ? t('측정 기능이 꺼져 있어 기존 값의 삭제만 가능합니다. 값을 지운 뒤 저장해 주세요.',
                  'Measurement is disabled, so this existing value can only be cleared. Clear it before saving.')
                : t('자동: 센서·PM2.5 90분, 전력 측정 5분. 직접 설정은 5–1440분입니다.',
                  'Automatic: sensors and PM2.5 90 min; power 5 min. Custom: 5–1440 min.')}>
              <TextField.Root id={id('freshness')} size="3" type="number" min="5" max="1440" step="1"
                data-device-control="freshness" disabled={!available || !freshnessActive}
                value={value.freshnessMinutes} placeholder={t('자동', 'Automatic')} onChange={(event) => update({ freshnessMinutes: event.target.value })}
                aria-describedby={`${id('freshness')}-help`} />
              {inactiveFreshness && <Button type="button" size="2" variant="soft" highContrast disabled={!available}
                onClick={() => update({ freshnessMinutes: '' })}>{t('유효 시간 지우기', 'Clear validity time')}</Button>}
            </Field>}
          </div>
          {remoteTypes.has(device.deviceType) && <label className="device-switch-row" htmlFor={id('remote')}>
            <div><Text as="span" id={id('remote-label')} size="2" weight="medium">
              {t('리모컨 버튼을 Apple Home에 표시', 'Show remote buttons in Apple Home')}</Text>
            <Text as="p" size="1" color="gray">{t('각 버튼은 명령을 한 번 보내며 실제 동작 상태를 표시하지 않습니다.',
              'Each button sends one command without showing physical device state.')}</Text></div>
            <Switch id={id('remote')} size="3" data-device-control="remoteButtons" checked={value.remoteButtons}
              aria-labelledby={id('remote-label')}
              disabled={!available || ['matter', 'hidden'].includes(value.visibility)}
              onCheckedChange={(checked) => update({ remoteButtons: checked })} />
          </label>}
          {device.deviceType === 'Airpurifier' && <details className="device-advanced-settings">
            <summary>{t('고급: PM2.5 측정값 보정', 'Advanced: PM2.5 measurement correction')}</summary>
            <Field id={id('pm25')} label={t('보정 배율', 'Correction factor')} help={t('기기 원본 값 × 배율 = µg/m³. 모델의 원본 단위를 확인한 경우에만 설정하세요.',
              'Raw device value × factor = µg/m³. Set this only when the model’s original unit is known.') + ' '
              + (device.meterProfileApplied
                ? t('비우면 PM2.5 보정을 해제하고 전력 측정 유효 시간은 유지합니다.',
                  'Clearing disables PM2.5 correction and keeps power measurement validity.')
                : t('비우면 PM2.5 보정과 측정값 유효 시간 설정을 함께 해제합니다.',
                  'Clearing disables PM2.5 correction and removes the measurement validity setting.'))}>
              <TextField.Root id={id('pm25')} size="3" type="number" step="any" data-device-control="pm25Multiplier"
                value={value.pm25Multiplier} disabled={!available}
                placeholder={t('사용 안 함', 'Not used')} onChange={(event) => update({ pm25Multiplier: event.target.value })}
                aria-describedby={`${id('pm25')}-help`} />
            </Field>
          </details>}
          {changedIdentity && <Callout.Root color="amber" size="1"><Callout.Icon><InfoCircledIcon /></Callout.Icon><Callout.Text>
            {t('연결 방식이나 장치 형태를 바꾸면 장치가 다시 생성되거나 중복 표시될 수 있으며 Matter를 다시 연결해야 할 수 있습니다.',
              'Changing connections or appearance can recreate devices, show duplicates, or require Matter pairing again.')}
          </Callout.Text></Callout.Root>}
          {['both', 'matter'].includes(value.visibility) && app.status?.features?.matter !== true && <Text as="p" size="1" color="gray">
            {t('Matter는 연결 설정에서 켠 뒤 사용할 수 있습니다.', 'Enable Matter in Connections to use it.')}
          </Text>}
          <Text as="p" size="1" color="gray">{t('표시 이름 변경은 장치 식별자를 유지합니다. 설정 저장 후 Homebridge를 다시 시작해 주세요.',
            'Display-name changes keep the device identity. Restart Homebridge after saving settings.')}</Text>
          {!app.writable && available && <Text as="p" size="2" color="amber">{t('최근 상태와 계정을 확인한 뒤 저장할 수 있습니다. 작성한 내용은 유지됩니다.',
            'Saving requires recent status and a verified account. Your draft is kept.')}</Text>}
          <Text as="p" size="2" color={validation || draft.error ? 'red' : 'jade'} id="deviceSettingsStatus" role="status">
            {validation || draft.error || (saved ? t('저장했습니다. Homebridge를 다시 시작해 주세요.', 'Saved. Please restart Homebridge.') : '')}
          </Text>
          <div className="device-save-bar">
            <Text size="1" color="gray">{draft.pending ? t('저장 중…', 'Saving…')
              : draft.dirty ? t('저장하지 않은 변경사항', 'Unsaved changes') : t('변경사항 없음', 'No changes')}</Text>
            <div className="device-command-actions">
              <Button size="3" variant="ghost" color="gray" type="button" disabled={!draft.dirty || draft.pending} onClick={async () => {
                if (await app.confirm({ title: t('변경사항을 되돌릴까요?', 'Discard changes?'),
                  description: t('이 장치의 저장하지 않은 변경사항을 지웁니다.', 'Unsaved changes for this device will be discarded.'),
                  actionLabel: t('되돌리기', 'Discard'), destructive: true })) {
                  draft.reset(); setValidation('');
                }
              }}>{t('되돌리기', 'Discard')}</Button>
              <Button type="submit" size="3" highContrast disabled={!available || !app.writable || draft.pending || !draft.dirty}>
                <CheckIcon />{t('이 장치 저장', 'Save this device')}</Button>
            </div>
          </div>
        </form>
      </Tabs.Content>
      {supportsCommands && <Tabs.Content value="controls" className="device-controls-content">
        <DeviceCommands device={device} available={available} state={command} update={updateCommand} />
      </Tabs.Content>}
    </Tabs.Root>
  </aside>;
}
