import { useEffect, useState } from 'react';
import { Callout, Flex, IconButton, Spinner, Text, Tooltip } from '@radix-ui/themes';
import {
  ArrowRightIcon, Cross2Icon, DashboardIcon, ExclamationTriangleIcon, LightningBoltIcon,
  Link2Icon, QuestionMarkCircledIcon, ReloadIcon,
} from '@radix-ui/react-icons';
import { useApp } from './core';
import { Badge, Button } from './core/radix';
import Login from './Login';
import Devices from './pages/Devices';
import Connections from './pages/Connections';
import Power from './pages/Power';
import Help from './pages/Help';
import logoUrl from '../../branding/icon.png';

type Destination = 'devices' | 'connections' | 'power' | 'help';

export default function App() {
  const app = useApp();
  const { t } = app;
  const [destination, setDestination] = useState<Destination>('devices');
  const [refreshing, setRefreshing] = useState(false);
  const destinations = [
    { id: 'devices' as const, label: t('장치', 'Devices'), icon: DashboardIcon },
    { id: 'connections' as const, label: t('연결', 'Connections'), icon: Link2Icon },
    { id: 'power' as const, label: t('전력', 'Power'), icon: LightningBoltIcon },
    { id: 'help' as const, label: t('도움말', 'Help'), icon: QuestionMarkCircledIcon },
  ];
  const active = destinations.find((item) => item.id === destination) ?? destinations[0]!;
  const realtimeConnected = app.ready && app.fresh && app.diagnostics?.connection?.realtime === 'connected';
  const deviceCount = app.diagnostics?.deviceListAvailable ? app.diagnostics.devices.filter((device) => device.inScope).length : null;

  useEffect(() => {
    document.documentElement.dataset.hejTheme = app.theme;
    document.documentElement.lang = app.language;
    document.documentElement.style.colorScheme = app.theme;
  }, [app.theme, app.language]);

  const refresh = async () => {
    setRefreshing(true);
    try {
      if (app.phase === 'error') {
        await app.initialize();
      } else {
        await app.refreshStatus();
        await app.refreshDiagnostics();
      }
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="hej-app" data-language={app.language}>
      <div className="app-shell">
        <aside className="app-sidebar" aria-label={t('Hejhome 작업 공간', 'Hejhome workspace')}>
          <div className="brand-lockup">
            <img className="brand-icon" src={logoUrl} alt="" width="34" height="34" />
            <div className="brand-copy"><span className="brand-name">Hejhome</span><span className="brand-caption">Homebridge</span></div>
            <Badge highContrast className="brand-beta" color="gray" variant="soft" size="1">BETA</Badge>
          </div>
          <Text className="sidebar-label" size="1" color="gray">{t('내 스마트 홈', 'YOUR SMART HOME')}</Text>
          <nav className="app-navigation" aria-label={t('설정 탐색', 'Settings navigation')}>
            {destinations.map(({ id, label, icon: Icon }) => (
              <Button key={id} type="button" variant="ghost" color="gray" className="nav-item"
                aria-current={destination === id ? 'page' : undefined} disabled={app.phase !== 'settings'}
                onClick={() => setDestination(id)}>
                <Icon width="18" height="18" /><span>{label}</span>
                {id === 'devices' && deviceCount !== null && <span className="nav-count" aria-hidden="true">{deviceCount}</span>}
              </Button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="workspace-status" id="account-summary">
              <span className={`connection-dot ${realtimeConnected ? 'is-connected' : ''}`} />
              <div><Text as="div" size="2" weight="medium">{app.ready ? t('계정 연결됨', 'Account connected') : t('연결 확인 필요', 'Check connection')}</Text>
                <Text as="div" size="1" color="gray">{realtimeConnected ? t('실시간 상태 수신 중', 'Receiving live updates')
                  : app.fresh ? t('실시간 연결 확인 중', 'Checking live connection') : t('최신 상태 확인 필요', 'Awaiting current status')}</Text></div>
            </div>
            <div className="sidebar-version"><span>Hejhome</span><span>v{__PLUGIN_VERSION__}</span></div>
          </div>
        </aside>

        <div className="app-main">
          <header className="workspace-toolbar">
            <div className="workspace-breadcrumb"><span>Hejhome</span><span className="breadcrumb-slash">/</span>
              <Text weight="medium">{app.phase === 'login' ? t('계정 연결', 'Connect account') : active.label}</Text></div>
            <Flex gap="2" align="center">
              {app.hasDirty && <Badge highContrast variant="soft" color="amber" className="unsaved-badge">{t('저장 전 변경사항', 'Unsaved changes')}</Badge>}
              {app.phase === 'settings' && <Tooltip content={t('상태 새로고침', 'Refresh status')}>
                <IconButton id="refresh-status" variant="ghost" color="gray" aria-label={t('상태 새로고침', 'Refresh status')}
                  disabled={app.busy || refreshing} onClick={() => void refresh()}>
                  <ReloadIcon className={refreshing ? 'is-spinning' : ''} width="18" height="18" />
                </IconButton>
              </Tooltip>}
              <Tooltip content={t('설정 닫기', 'Close settings')}>
                <IconButton id="closeStalledSettings" variant="ghost" color="gray"
                  aria-label={t('설정 닫기', 'Close settings')} onClick={() => void app.close()}>
                  <Cross2Icon width="18" height="18" />
                </IconButton>
              </Tooltip>
            </Flex>
          </header>

          {app.phase === 'initializing' && <div id="startupView" className="startup-state" role="status">
            <Spinner size="3" /><Text size="3" weight="medium">{t('스마트 홈을 불러오고 있어요', 'Loading your smart home')}</Text>
            <Text size="2" color="gray">{t('계정과 장치의 현재 상태를 확인합니다.', 'Checking your account and current device status.')}</Text>
          </div>}

          {app.phase === 'error' && <div id="startupView" className="startup-state">
            <ExclamationTriangleIcon width="28" height="28" /><Text size="4" weight="medium">{t('연결을 확인해 주세요', 'Check your connection')}</Text>
            <Text size="2" color="gray">{app.error}</Text>
            <Button id="retryStartup" highContrast onClick={() => void refresh()} loading={refreshing}>
              <ReloadIcon />{t('다시 시도', 'Try again')}
            </Button>
          </div>}

          <div hidden={app.phase !== 'login'} className="login-container"><Login /></div>

          <main id="settingsView" hidden={app.phase !== 'settings'} className="workspace-content">
            {app.accountChangePending && <Callout.Root id="globalStatus" color="amber" className="workspace-notice">
              <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon>
              <Callout.Text>{t('계정이 변경되었습니다. 변경사항을 확인한 후 새 계정으로 이동해 주세요.',
                'The account has changed. Review your unsaved changes before continuing.')}
              <Button id="accountChangeAction" variant="soft" size="2" onClick={() => void app.resolveAccountChange()}>
                {t('새 계정 확인', 'Review account change')}<ArrowRightIcon /></Button></Callout.Text>
            </Callout.Root>}
            {!app.accountChangePending && app.notice && <Callout.Root id="globalStatus" color="amber" className="workspace-notice">
              <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon><Callout.Text>{app.notice}</Callout.Text>
            </Callout.Root>}
            {!app.accountChangePending && app.error && <Callout.Root id="globalError" color="red" className="workspace-notice" role="alert">
              <Callout.Icon><ExclamationTriangleIcon /></Callout.Icon><Callout.Text>{app.error}</Callout.Text>
            </Callout.Root>}
            <div className="workspace-pages" key={app.accountEpoch}>
              <section hidden={destination !== 'devices'} role="region" aria-label={t('장치', 'Devices')}><Devices /></section>
              <section hidden={destination !== 'connections'} role="region" aria-label={t('연결', 'Connections')}><Connections /></section>
              <section hidden={destination !== 'power'} role="region" aria-label={t('전력', 'Power')}><Power /></section>
              <section hidden={destination !== 'help'} role="region" aria-label={t('도움말', 'Help')}><Help /></section>
            </div>
          </main>
        </div>
      </div>
    </div>
  );
}
