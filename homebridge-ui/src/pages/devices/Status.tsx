import { Text } from '@radix-ui/themes';
import { useApp } from '../../core';
import type { Device } from '../../core/types';

export function DeviceStatus({ device, available }: { device: Device; available: boolean }) {
  const app = useApp();
  const { t } = app;
  const current = available && app.ready && app.fresh && app.diagnostics?.connection?.session === 'valid';
  const visibility = device.preference?.visibility ?? 'both';
  const apple = ['hidden', 'matter'].includes(visibility) ? t('Apple Home에 표시하지 않음', 'Not shown in Apple Home')
    : current && device.homekit ? t('Apple Home 연결용으로 준비됨', 'Prepared for Apple Home')
      : app.hapCache.has(device.id) ? t('Apple Home: 이전에 저장된 장치', 'Apple Home: previously saved device')
        : t('Apple Home: 등록 확인 안 됨', 'Apple Home: registration unconfirmed');
  const matter = ['hidden', 'homekit'].includes(visibility) ? t('Matter에 표시하지 않음', 'Not shown in Matter')
    : current && app.status?.features?.matter === true && device.matter ? t('Matter 연결용으로 준비됨', 'Prepared for Matter')
      : app.matterCache.has(device.id) ? t('Matter: 이전에 저장된 장치', 'Matter: previously saved device')
        : t('Matter: 등록 확인 안 됨', 'Matter: registration unconfirmed');
  const online = !current || typeof device.online !== 'boolean' ? t('최근 연결 상태 확인 불가', 'Recent connection unknown')
    : device.online ? t('장치 연결됨', 'Device connected') : t('장치와 연결되지 않음', 'Device disconnected');
  const lastControl = device.lastControl === 'success' ? t('명령 전송 완료', 'Command sent')
    : device.lastControl === 'failed' ? t('마지막 명령 전송 실패', 'Last command failed') : t('명령 전송 기록 없음', 'No command recorded');
  const stamp = Date.parse(device.lastSeenAt ?? '');
  const lastSeen = Number.isFinite(stamp) ? new Intl.DateTimeFormat(app.language === 'ko' ? 'ko-KR' : 'en', {
    dateStyle: 'short', timeStyle: 'medium',
  }).format(stamp) : t('장치 상태 수신 기록 없음', 'No device update received');
  return <details className="device-advanced-settings device-status-details">
    <summary>{t('상태 및 연결', 'Status and connections')} · {online}</summary>
    <div id="diagnosticsList" className="device-status-list">
      <Text as="p" size="2">{apple}</Text>
      <Text as="p" size="2">{matter}</Text>
      <Text as="p" size="1" color="gray">{t('준비됨은 Apple Home 페어링 완료를 뜻하지 않습니다.', 'Prepared does not confirm Apple Home pairing.')}</Text>
      <Text as="p" size="2">{t('마지막 장치 상태', 'Last device update')}: {lastSeen}</Text>
      <Text as="p" size="2">{t('마지막 명령 기록', 'Last command record')}: {lastControl}</Text>
      <Text as="p" size="1" color="gray">{t('명령 응답은 실제 기기 동작 확인과 다릅니다.', 'A command response does not confirm physical operation.')}</Text>
      <Text as="p" size="2">{device.meterProfileApplied ? t('전력 측정 설정 적용', 'Meter setup applied') : t('전력 측정 설정 없음', 'No meter setup')}</Text>
    </div>
  </details>;
}
