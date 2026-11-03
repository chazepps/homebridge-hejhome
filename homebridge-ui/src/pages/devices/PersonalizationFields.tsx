import { Switch, Text, TextField } from '@radix-ui/themes';
import { Button } from '../../core/radix';
import { useApp } from '../../core';
import type { Device } from '../../core/types';
import { nameablePowerChannels } from '../../../../src/devices/personalization';
import type { DeviceEditorValue } from './model';
import { Field } from './Fields';

export function PersonalizationFields({ device, value, update, disabled }: {
  device: Device; value: DeviceEditorValue; update(patch: Partial<DeviceEditorValue>): void; disabled: boolean;
}) {
  const { t } = useApp();
  const favorites = value.favoriteChannels;
  const supportsFavorites = ['IrTv', 'IrSettopbox'].includes(device.deviceType);
  const channels = [...new Set([...(device.powerChannels ?? nameablePowerChannels(device)), ...Object.keys(value.channelNames)])];
  const editFavorite = (index: number, patch: Partial<DeviceEditorValue['favoriteChannels'][number]>) => {
    update({ favoriteChannels: favorites.map((item, n) => n === index ? { ...item, ...patch } : item) });
  };
  const addFavorite = () => {
    let id: string;
    do {
      id = `channel-${Array.from(crypto.getRandomValues(new Uint32Array(2)), (n) => n.toString(16).padStart(8, '0')).join('')}`;
    } while (favorites.some((item) => item.id === id));
    update({ favoriteChannels: [...favorites, { id, name: '', channel: '' }] });
  };
  const hapDisabled = ['matter', 'hidden'].includes(value.visibility);
  return <>
    {(supportsFavorites || favorites.length > 0) && <div className="device-personalization-group">
      <Text as="p" size="2" weight="medium">{t('즐겨찾기 채널', 'Favorite channels')}</Text>
      <Text as="p" size="1" color="gray">{t('최대 8개. Apple Home 버튼을 누르면 채널 번호를 한 번 전송합니다.',
        'Up to 8. Each Apple Home button sends its channel number once.')}</Text>
      {!supportsFavorites && <Text as="p" size="1" color="amber">{t('장치 종류가 바뀌어 사용할 수 없는 설정입니다. 기존 항목을 삭제한 뒤 저장해 주세요.',
        'These settings no longer match the device type. Delete the old entries before saving.')}</Text>}
      {favorites.map((item, index) => <div key={item.id} className="device-personalization-entry">
        <div className="device-settings-grid">
          <Field id={`favorite-${device.id}-${item.id}-name`} label={t(`즐겨찾기 ${index + 1} 이름`, `Favorite ${index + 1} name`)}>
            <TextField.Root id={`favorite-${device.id}-${item.id}-name`} value={item.name} maxLength={32} disabled={disabled || !supportsFavorites}
              onChange={(event) => editFavorite(index, { name: event.target.value })} />
          </Field>
          <Field id={`favorite-${device.id}-${item.id}-channel`} label={t(`즐겨찾기 ${index + 1} 채널 번호`, `Favorite ${index + 1} channel`)}>
            <TextField.Root id={`favorite-${device.id}-${item.id}-channel`} value={item.channel} inputMode="numeric" maxLength={3}
              disabled={disabled || !supportsFavorites} onChange={(event) => editFavorite(index, { channel: event.target.value })} />
          </Field>
        </div>
        <Button type="button" size="2" variant="soft" color="gray" disabled={disabled}
          aria-label={t(`즐겨찾기 ${index + 1} 삭제`, `Delete favorite ${index + 1}`)}
          onClick={() => update({ favoriteChannels: favorites.filter((_, n) => n !== index) })}>{t('삭제', 'Delete')}</Button>
      </div>)}
      <Button type="button" size="2" variant="soft" disabled={disabled || !supportsFavorites || favorites.length >= 8}
        onClick={addFavorite}>{t('즐겨찾기 채널 추가', 'Add favorite channel')}</Button>
      {hapDisabled && <Text as="p" size="1" color="gray">{t('설정은 보관됩니다. Apple Home 연결을 선택하면 버튼을 사용할 수 있습니다.',
        'Settings are kept. Select an Apple Home connection to use these buttons.')}</Text>}
    </div>}
    {(device.deviceType === 'Airpurifier' || value.purifierModeButtons) && <div className="device-personalization-group">
      <label className="device-switch-row" htmlFor={`purifier-modes-${device.id}`}>
        <div><Text as="span" id={`purifier-modes-label-${device.id}`} size="2" weight="medium">
          {t('모드 버튼을 Apple Home에 표시', 'Show mode buttons in Apple Home')}</Text>
        <Text as="p" size="1" color="gray">{t('자동·수동·취침을 요청하는 버튼입니다. 실제 운전 상태를 표시하지 않습니다.',
          'Buttons request auto, manual or sleep mode without showing operating state.')}</Text></div>
        <Switch id={`purifier-modes-${device.id}`} checked={value.purifierModeButtons} disabled={disabled}
          aria-labelledby={`purifier-modes-label-${device.id}`} onCheckedChange={(checked) => update({ purifierModeButtons: checked })} />
      </label>
      {device.deviceType !== 'Airpurifier' && <Text as="p" size="1" color="amber">{t('장치 종류가 바뀌어 사용할 수 없는 설정입니다. 모드 버튼을 끄고 저장해 주세요.',
        'This setting no longer matches the device type. Turn off mode buttons before saving.')}</Text>}
      {hapDisabled && <Text as="p" size="1" color="gray">{t('설정은 보관되며, Apple Home 연결에서만 버튼이 표시됩니다.',
        'The setting is kept; buttons appear only with an Apple Home connection.')}</Text>}
    </div>}
    {channels.length > 0 && <div className="device-personalization-group">
      <Text as="p" size="2" weight="medium">{t('포트별 이름', 'Port names')}</Text>
      <Text as="p" size="1" color="gray">{t('비워 두면 기본 이름으로 돌아갑니다. 포트 식별자는 유지됩니다.',
        'Leave blank to restore the default name. Port identities stay the same.')}</Text>
      <div className="device-settings-grid">{channels.map((key) => <Field key={key} id={`port-${device.id}-${key}`}
        label={t(`포트 ${key.slice(5)} 이름`, `Port ${key.slice(5)} name`)}>
        <TextField.Root id={`port-${device.id}-${key}`} value={value.channelNames[key] ?? ''} maxLength={64}
          disabled={disabled} onChange={(event) => update({ channelNames: { ...value.channelNames, [key]: event.target.value } })} />
      </Field>)}</div>
    </div>}
  </>;
}
