import { useEffect, useRef, useState } from 'react';
import { Heading, SegmentedControl, Text, TextField } from '@radix-ui/themes';
import { CubeIcon, DesktopIcon, LightningBoltIcon, MagnifyingGlassIcon, MixerHorizontalIcon, SunIcon } from '@radix-ui/react-icons';
import { useApp, useDraft } from '../core';
import { Badge } from '../core/radix';
import type { Device } from '../core/types';
import { DeviceInspector } from './devices/Inspector';
import { emptyCommandState, type CommandState } from './devices/Commands';
import { deviceKind, deviceNeedsAttention, deviceSearchText, editorValue } from './devices/model';
import { afterStableLayout } from './devices/navigation';

function DeviceIcon({ type }: { type: string }) {
  if (/IrTv|IrSettopbox/.test(type)) {
    return <DesktopIcon />;
  }
  if (/light|bulb|dimmer/i.test(type)) {
    return <SunIcon />;
  }
  if (/Plug|Relay|Switch/.test(type)) {
    return <LightningBoltIcon />;
  }
  if (/Air|Fan/.test(type)) {
    return <MixerHorizontalIcon />;
  }
  return <CubeIcon />;
}

function DeviceCard({ device, selected, saved, onSelect, register }: {
  device: Device; selected: boolean; saved: boolean; onSelect(): void; register(node: HTMLButtonElement | null): void;
}) {
  const app = useApp();
  const { t } = app;
  const draft = useDraft(`device:${device.id}`, editorValue(device.preference));
  const visibility = device.preference?.visibility ?? 'both';
  const hidden = visibility === 'hidden';
  const fresh = app.fresh && app.ready && app.diagnostics?.deviceListAvailable === true
    && app.diagnostics.connection?.session === 'valid';
  const status = !fresh ? t('최근 상태 없음', 'Status unavailable') : device.online === false ? t('연결 끊김', 'Disconnected')
    : device.lastControl === 'failed' ? t('명령 실패', 'Command failed') : device.online !== true || !device.lastSeenAt
      ? t('상태 대기 중', 'Awaiting status') : t('상태 수신', 'Update received');
  const tone = !fresh || device.online !== true || !device.lastSeenAt ? 'gray' : device.lastControl === 'failed' ? 'amber' : 'jade';
  const homekit = fresh && device.homekit && !['hidden', 'matter'].includes(visibility);
  const matter = fresh && app.status?.features?.matter === true && device.matter && !['hidden', 'homekit'].includes(visibility);
  return <article className={`device-card${selected ? ' is-selected' : ''}`} data-testid="device-row" data-device-id={device.id}>
    <button type="button" className="device-card-button" aria-pressed={selected} aria-label={`${device.name} · ${t('상세 보기', 'Details')}`}
      onClick={onSelect} ref={register}>
      <div className="device-card-heading"><span className="device-card-icon"><DeviceIcon type={device.deviceType} /></span><div>
        <Text as="p" size="3" weight="medium">{device.name}</Text><Text as="p" size="1" color="gray">{deviceKind(device, t)}</Text>
      </div></div>
      <div className="device-card-status"><Badge color={tone} variant="soft" highContrast>{status}</Badge>
        {draft.dirty && <Badge color="amber" highContrast>{t('저장 전', 'Unsaved')}</Badge>}
        {saved && !draft.dirty && <Badge color="iris" highContrast>{t('재시작 필요', 'Restart needed')}</Badge>}
      </div>
      <div className="device-card-meta">
        {hidden ? <Text size="1" color="gray">{t('앱에 표시하지 않음', 'Hidden from apps')}</Text> : homekit || matter
          ? <Text size="1" color="gray">{homekit && matter ? t('Apple Home · Matter 준비됨', 'Apple Home · Matter prepared')
            : homekit ? t('Apple Home용으로 준비됨', 'Prepared for Apple Home') : t('Matter 연결 준비됨', 'Prepared for Matter')}</Text>
          : <Text size="1" color="gray">{visibility === 'matter' && app.status?.features?.matter !== true
            ? t('Matter 꺼짐', 'Matter disabled') : t('연결 준비 확인 필요', 'Readiness unconfirmed')}</Text>}
      </div>
    </button>
  </article>;
}

export default function Devices() {
  const app = useApp();
  const { t } = app;
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const [selection, setSelection] = useState<Device | null>(null);
  const [saved, setSaved] = useState<Set<string>>(() => new Set());
  const [commands, setCommands] = useState<Record<string, CommandState>>({});
  const cardButtons = useRef(new Map<string, HTMLButtonElement>());
  const search = useRef<HTMLInputElement>(null);
  const listPosition = useRef({ left: 0, top: 0 });
  const navigationGeneration = useRef(0);
  useEffect(() => () => {
    navigationGeneration.current++;
  }, []);
  const devices = app.diagnostics?.devices ?? [];
  const scoped = devices.filter((device) => device.inScope);
  const visible = scoped.filter((device) => {
    const matchesQuery = deviceSearchText(device, t).toLocaleLowerCase(app.language).includes(query.toLocaleLowerCase(app.language).trim());
    const hidden = device.preference?.visibility === 'hidden';
    return matchesQuery && (filter === 'hidden' ? hidden : filter === 'attention' ? !hidden
      && deviceNeedsAttention(device, app.fresh && app.ready && app.diagnostics?.deviceListAvailable === true,
        app.diagnostics?.connection?.session, app.status?.features?.matter === true) : true);
  });
  const current = selection ? scoped.find((device) => device.id === selection.id) : undefined;
  const selected = current ?? selection;
  const afterLayout = (generation: number, action: () => void) => {
    requestAnimationFrame(() => {
      if (generation !== navigationGeneration.current) {
        return;
      }
      window.homebridge?.fixScrollHeight?.();
      // Resizing an iframe can trigger another host resize. Restore only when that chain settles.
      afterStableLayout(action, () => generation === navigationGeneration.current);
    });
  };
  const openInspector = (device: Device) => {
    listPosition.current = { left: window.scrollX, top: window.scrollY };
    const generation = ++navigationGeneration.current;
    setSelection(device);
    afterLayout(generation, () => {
      const back = document.getElementById('backToDevices');
      back?.focus({ preventScroll: true });
      back?.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    });
  };
  const closeInspector = () => {
    const id = selection?.id;
    const generation = ++navigationGeneration.current;
    setSelection(null);
    afterLayout(generation, () => {
      const trigger = id && cardButtons.current.get(id) || search.current;
      window.scrollTo({ ...listPosition.current, behavior: 'instant' });
      trigger?.focus({ preventScroll: true });
      if (window.parent !== window) {
        // scrollIntoView crosses iframe boundaries without requiring access to the parent's document.
        trigger?.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      }
    });
  };
  return <div className="devices-page">
    <header className="page-header">
      <div><Text as="p" className="page-eyebrow">{t('나의 스마트 홈', 'YOUR SMART HOME')}</Text>
        <Heading as="h1" className="page-title" size="7">{t('장치', 'Devices')}</Heading>
        <Text as="p" className="page-description" color="gray">{t('장치의 연결 상태와 Home 앱 표시 방식을 관리합니다.',
          'Manage device connections and how they appear in Home.')}</Text>
      </div>
    </header>
    <div className={`device-workspace${selected ? ' has-selection' : ''}`}>
      <div className="device-browser" id="deviceListView">
        <div className="devices-toolbar">
          <TextField.Root id="deviceSearch" size="3" placeholder={t('이름 또는 종류로 검색', 'Search name or type')} aria-label={t('장치 검색', 'Search devices')}
            value={query} onChange={(event) => setQuery(event.target.value)} ref={search}>
            <TextField.Slot><MagnifyingGlassIcon /></TextField.Slot>
          </TextField.Root>
          <SegmentedControl.Root value={filter} onValueChange={setFilter} size="2" aria-label={t('장치 필터', 'Device filter')}>
            <SegmentedControl.Item value="all">{t('전체', 'All')}</SegmentedControl.Item>
            <SegmentedControl.Item value="attention">{t('확인 필요', 'Needs attention')}</SegmentedControl.Item>
            <SegmentedControl.Item value="hidden">{t('숨김', 'Hidden')}</SegmentedControl.Item>
          </SegmentedControl.Root>
        </div>
        <div className="device-list-summary"><Text size="2" color="gray" id="deviceCount">{t(`${visible.length}개 장치`, `${visible.length} devices`)}</Text>
          <Text size="1" color="gray">{t('준비됨은 Apple Home 페어링 완료를 의미하지 않습니다.', 'Prepared does not confirm Apple Home pairing.')}</Text></div>
        <div className="device-grid" id="deviceList">
          {visible.map((device) => <DeviceCard key={device.id} device={device} selected={selected?.id === device.id} saved={saved.has(device.id)}
            onSelect={() => openInspector(device)} register={(node) => {
              if (node) {
                cardButtons.current.set(device.id, node);
              } else {
                cardButtons.current.delete(device.id);
              }
            }} />)}
        </div>
        {!visible.length && <div className="empty-state"><CubeIcon /><Heading as="h2" size="4">{t('표시할 장치가 없습니다', 'No devices to show')}</Heading>
          <Text color="gray">{scoped.length ? t('검색어 또는 필터를 바꿔 보세요.', 'Try a different search or filter.')
            : app.status?.configured ? t('연결 설정에서 가져올 집과 방을 확인해 주세요.', 'Choose homes and rooms in Connections.')
              : t('로그인하면 장치 목록을 확인할 수 있습니다.', 'Sign in to see your devices.')}</Text></div>}
      </div>
      {selected && <DeviceInspector key={selected.id} device={selected} available={Boolean(current) && app.diagnostics?.deviceListAvailable === true}
        onClose={closeInspector} saved={saved.has(selected.id)} onSaved={() => setSaved((previous) => new Set(previous).add(selected.id))}
        command={commands[selected.id] ?? emptyCommandState} updateCommand={(patch) => setCommands((previous) => ({
          ...previous, [selected.id]: { ...(previous[selected.id] ?? emptyCommandState), ...patch },
        }))} />}
    </div>
  </div>;
}
