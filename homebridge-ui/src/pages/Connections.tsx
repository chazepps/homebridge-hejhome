import { useEffect, useMemo, useRef, useState } from 'react';
import { Card, Checkbox, Flex, Heading, Separator, Switch, Text } from '@radix-ui/themes';
import { ChevronDownIcon, HomeIcon, Link2Icon, PersonIcon, SunIcon } from '@radix-ui/react-icons';
import { useApp, useDraft } from '../core';
import { Badge, Button } from '../core/radix';
import { choicesScope, errorCode, formatDate, scopeChoices, scopeSourceKey, type Family, type Scope } from './settings-helpers';

type ConnectionStatus = {
  configured?: boolean;
  sessionValid?: boolean;
  sessionCheckStatus?: string;
  expiresAtIso?: string;
  refreshRecommendedAtIso?: string;
  scope?: Scope;
  scopeOptions?: { complete?: boolean; families?: Family[]; defaultMode?: Scope['mode'] };
  scopeEditToken?: string | null;
  features?: { matter?: boolean; adaptiveLighting?: boolean };
};

function FeatureCard({ kind }: { kind: 'matter' | 'adaptiveLighting' }) {
  const app = useApp();
  const { t } = app;
  const status = app.status as ConnectionStatus | null;
  const draft = useDraft<boolean>(`feature:${kind}`, status?.features?.[kind] === true);
  const [feedback, setFeedback] = useState('');
  const matter = kind === 'matter';
  const title = matter ? t('Matter 연결', 'Matter connection') : t('적응형 조명', 'Adaptive lighting');
  const save = async () => {
    setFeedback('');
    await draft.save(async (value) => {
      const response = await app.mutate<{ ok: boolean; features?: Record<string, boolean> }>(
        '/save-features',
        { features: { [kind]: value } },
        { requireFresh: false },
      );
      if (!response?.ok) {
        throw new Error(t('설정을 저장하지 못했습니다.', 'Could not save settings.'));
      }
      setFeedback(t('저장했습니다. Homebridge를 다시 시작하면 적용됩니다.', 'Saved. Restart Homebridge to apply.'));
      void app.refreshStatus();
      return response.features?.[kind] ?? value;
    });
  };
  return (
    <Card className="section-card feature-card" id={matter ? 'featureSection' : 'lightingSection'}>
      <div className="section-header">
        <Flex align="center" gap="2">
          {matter ? <Link2Icon /> : <SunIcon />}
          <Heading as="h2" size="4">
            {title}
          </Heading>
        </Flex>
        <label className="feature-switch-target" htmlFor={matter ? 'matterFeature' : 'adaptiveFeature'}>
          <Switch
            id={matter ? 'matterFeature' : 'adaptiveFeature'}
            aria-label={title}
            checked={draft.value}
            disabled={!app.ready || app.accountChangePending}
            onCheckedChange={(value) => {
              draft.setValue(value);
              setFeedback('');
            }}
          />
        </label>
      </div>
      <Text as="p" size="2" color="gray" className="feature-copy">
        {matter
          ? t('Google Home·SmartThings 등에서 사용할 장치를 준비합니다.', 'Prepare devices for Google Home, SmartThings and other apps.')
          : t('지원하는 색온도 조명을 시간대에 맞춰 조절합니다.', 'Adjust supported color-temperature lights throughout the day.')}
      </Text>
      <details className="guidance-details">
        <summary>
          <ChevronDownIcon className="disclosure-chevron" aria-hidden="true" />
          {t('설정 방법과 알아둘 점', 'Setup and details')}
        </summary>
        <Text as="p" size="2" color="gray">
          {matter
            ? t(
              'Homebridge의 해당 브리지에서도 Matter를 켜고 표시된 QR로 연결하세요. 같은 장치를 같은 앱에 HomeKit과 Matter로 모두 추가하면 중복 표시될 수 있습니다. 헤이홈 클라우드는 계속 필요합니다.',
              'Enable Matter on this bridge and pair using its QR code. HomeKit and Matter may duplicate devices in one app. Hejhome cloud is still required.',
            )
            : t(
              'Apple Home에서도 적응형 조명을 켜야 합니다. 주기적으로 클라우드 명령을 보내며 꺼진 조명에도 색온도 요청이 생길 수 있습니다. 수동 색온도·컬러·장면 전환은 자동 조명을 해제할 수 있습니다.',
              'Enable this in Apple Home too. Cloud commands may reach lights that are off. Manual color or scene changes can end automatic lighting.',
            )}
        </Text>
      </details>
      <div className="section-footer">
        <Button
          id={matter ? 'saveFeatures' : 'saveLighting'}
          variant="soft" highContrast
          disabled={!app.ready || app.accountChangePending || !draft.dirty || draft.pending}
          loading={draft.pending}
          onClick={() => void save().catch(() => undefined)}
        >
          {matter ? t('연결 설정 저장', 'Save connection') : t('조명 설정 저장', 'Save lighting')}
        </Button>
        {draft.dirty && <Badge highContrast color="amber">{t('저장 전', 'Unsaved')}</Badge>}
      </div>
      <Text as="p" size="2" role="status" id={matter ? 'featuresStatus' : 'lightingStatus'} color={draft.error ? 'red' : 'gray'}>
        {draft.error || feedback}
      </Text>
    </Card>
  );
}

export default function Connections() {
  const app = useApp();
  const { t, language } = app;
  const status = app.status as ConnectionStatus | null;
  const families = useMemo(() => status?.scopeOptions?.families ?? [], [status?.scopeOptions]);
  const source = useMemo(() => {
    const scope = status?.scope ?? { mode: status?.scopeOptions?.defaultMode ?? 'first-family' };
    return { choices: scopeChoices(scope, families), fingerprint: scopeSourceKey(scope, families),
      families, token: status?.scopeEditToken ?? null };
  }, [status?.scope, status?.scopeOptions, status?.scopeEditToken, families]);
  const baseline = source.choices;
  const draft = useDraft('scope', baseline);
  const [ticket, setTicket] = useState(source);
  const [rejectedToken, setRejectedToken] = useState<string | null>(null);
  const [feedback, setFeedback] = useState('');
  const sourceReady = app.ready && !app.accountChangePending && status?.scopeOptions?.complete === true
    && Boolean(source.token) && source.token !== rejectedToken;
  const latestSource = useRef({ source, ready: sourceReady, accountEpoch: app.accountEpoch });
  latestSource.current = { source, ready: sourceReady, accountEpoch: app.accountEpoch };
  useEffect(() => {
    if (draft.pending || (draft.dirty && (!sourceReady || ticket.fingerprint !== source.fingerprint))) {
      return;
    }
    // Returning to the old baseline cancels the edit; reveal any saved changes received while it was dirty.
    if (!draft.dirty && JSON.stringify(draft.value) !== JSON.stringify(source.choices)) {
      draft.resetTo(source.choices);
    }
    if (source.token !== rejectedToken) {
      setTicket((previous) => previous.token === source.token && previous.fingerprint === source.fingerprint ? previous : source);
    }
  }, [draft, source, sourceReady, ticket.fingerprint, rejectedToken]);
  const scopeConflict = draft.dirty && !draft.pending && status?.scopeOptions?.complete === true
    && ticket.fingerprint !== source.fingerprint;
  const scopeReady = sourceReady && Boolean(ticket.token);
  const resetScope = async () => {
    const epoch = app.accountEpoch;
    if (!await app.confirm({
      title: t('최신 집/방 설정을 불러올까요?', 'Load the latest saved homes and rooms?'),
      description: t('저장하지 않은 집/방 선택을 버리고 최신 저장 내용을 불러옵니다.',
        'Discard your unsaved home and room choices and load the latest saved settings.'),
      actionLabel: t('최신 설정 불러오기', 'Use latest settings'),
      destructive: true,
    })) {
      return;
    }
    const latest = latestSource.current;
    if (latest.accountEpoch !== epoch || !latest.ready) {
      return;
    }
    draft.resetTo(latest.source.choices);
    setTicket(latest.source);
    setRejectedToken(null);
    setFeedback(t('최신 집/방 설정을 불러왔습니다. 필요한 변경을 다시 선택하세요.',
      'Latest homes and rooms loaded. Choose any changes again.'));
  };
  const runtimeExpired = app.fresh && app.diagnostics?.connection?.session === 'expired';
  const valid = status?.sessionValid === true && !runtimeExpired;
  const unavailable = status?.sessionCheckStatus === 'error';
  const badge = valid
    ? t('로그인 정상', 'Signed in')
    : unavailable
      ? t('확인 필요', 'Check connection')
      : t('다시 로그인 필요', 'Sign in again');
  const choose = (family: Family, roomId: number | null, value: boolean) => {
    const id = String(family.familyId);
    const current = draft.value[id] ?? baseline[id] ?? { selected: false, rooms: {} };
    draft.setValue({
      ...draft.value,
      [id]: roomId === null ? { ...current, selected: value } : { ...current, rooms: { ...current.rooms, [roomId]: value } },
    });
    setFeedback('');
  };
  const save = async () => {
    if (!scopeReady || scopeConflict) {
      return;
    }
    setFeedback('');
    await draft.save(async (value) => {
      const scope = choicesScope(value, ticket.families);
      try {
        const response = await app.mutate<{ ok: boolean; scope?: Scope; scopeEditToken?: string }>(
          '/save-scope',
          { scope, scopeEditToken: ticket.token },
          { requireFresh: false },
        );
        if (!response?.ok) {
          throw new Error(t('집과 방 설정을 저장하지 못했습니다.', 'Could not save homes and rooms.'));
        }
        const savedScope = response.scope ?? scope;
        setTicket({ choices: scopeChoices(savedScope, ticket.families), families: ticket.families,
          fingerprint: scopeSourceKey(savedScope, ticket.families), token: response.scopeEditToken ?? null });
        setRejectedToken(null);
        setFeedback(
          t('집/방 설정을 저장했습니다. Homebridge를 다시 시작하면 적용됩니다.', 'Homes and rooms saved. Restart Homebridge to apply.'),
        );
        void app.refreshStatus();
        void app.refreshDiagnostics();
        return scopeChoices(savedScope, ticket.families);
      } catch (error) {
        if (['scope-edit-stale', 'scope-edit-unavailable'].includes(errorCode(error) ?? '')) {
          setRejectedToken(ticket.token);
          setTicket((previous) => ({ ...previous, token: null }));
          void app.refreshStatus();
          throw new Error(
            t(
              '집과 방 목록이 바뀌었습니다. 선택 내용은 유지됩니다. 새 목록을 확인한 뒤 다시 저장하세요.',
              'Homes or rooms changed. Your choices are kept. Review the refreshed list, then save again.',
            ),
            { cause: error },
          );
        }
        throw error;
      }
    });
  };
  return (
    <div className="settings-page">
      <header className="page-header">
        <Text className="page-eyebrow">{t('연결', 'CONNECTIONS')}</Text>
        <Heading as="h1" className="page-title" size="7">
          {t('집을 연결하는 방법', 'Connect your home')}
        </Heading>
        <Text as="p" className="page-description" color="gray">
          {t('계정, 가져올 공간과 스마트홈 연결을 관리하세요.', 'Manage your account, selected spaces and smart-home connections.')}
        </Text>
      </header>
      <div className="settings-grid connection-overview">
        <Card id="accountSection" className="section-card connection-account">
          <Flex align="start" justify="between" gap="3" wrap="wrap">
            <Flex gap="3" align="center">
              <PersonIcon width="22" height="22" />
              <div>
                <Heading as="h2" size="4">
                  {t('헤이홈 계정', 'Hejhome account')}
                </Heading>
                <Text as="p" size="2" color="gray" id="sessionDescription">
                  {valid
                    ? t('이 Homebridge에 로그인 정보가 저장되어 있습니다.', 'Your sign-in is stored on this Homebridge.')
                    : unavailable
                      ? t('저장된 로그인 정보를 확인하지 못했습니다.', 'The saved sign-in could not be checked.')
                      : t('계속 사용하려면 다시 로그인해 주세요.', 'Sign in again to continue.')}
                </Text>
              </div>
            </Flex>
            <Badge id="sessionBadge" size="2" highContrast color={valid ? 'jade' : 'amber'}>
              {badge}
            </Badge>
          </Flex>
          <details className="guidance-details">
            <summary>
              <ChevronDownIcon className="disclosure-chevron" aria-hidden="true" />
              {t('만료 일정 및 계정 관리', 'Expiry and account management')}
            </summary>
            <div className="diagnostics-grid">
              <div>
                <Text as="p" size="1" color="gray">
                  {t('만료 예정 · 한국 시간', 'Expires · Korea time')}
                </Text>
                <Text size="2">{formatDate(status?.expiresAtIso, language, t('확인할 수 없음', 'Unavailable'))}</Text>
              </div>
              <div>
                <Text as="p" size="1" color="gray">
                  {t('권장 갱신 시각 · 한국 시간', 'Recommended renewal · Korea time')}
                </Text>
                <Text size="2">{formatDate(status?.refreshRecommendedAtIso, language, t('확인할 수 없음', 'Unavailable'))}</Text>
              </div>
            </div>
            <Flex gap="2" wrap="wrap" mt="4">
              <Button id="relogin" variant="soft" highContrast onClick={() => void app.beginLogin()}>
                {t('다시 로그인', 'Sign in again')}
              </Button>
              {status?.configured && (
                <Button id="logout" color="red" variant="ghost" onClick={() => void app.logout()}>
                  {t('로그아웃', 'Sign out')}
                </Button>
              )}
            </Flex>
          </details>
          {!valid && (
            <Button mt="3" variant="soft" highContrast onClick={() => void app.beginLogin()}>
              {t('로그인 갱신', 'Renew sign-in')}
            </Button>
          )}
        </Card>
        <Card id="scopeSection" className="section-card">
          <div className="section-header">
            <Flex gap="2" align="center">
              <HomeIcon />
              <Heading as="h2" size="4">
                {t('집과 방', 'Homes and rooms')}
              </Heading>
            </Flex>
            <Badge highContrast id="scopeBadge" color="gray">
              {t(`${families.length}개 집`, `${families.length} homes`)}
            </Badge>
          </div>
          <Text as="p" size="2" color="gray">
            {t(
              'Homebridge로 가져올 공간을 선택하세요. 기본값은 첫 번째 집의 모든 방입니다.',
              'Choose spaces to include in Homebridge. The first home and all its rooms are selected by default.',
            )}
          </Text>
          <div id="scopeList">
            {families.map((family) => {
              const choice = draft.value[family.familyId] ?? baseline[family.familyId];
              return (
                <div className="scope-family" key={family.familyId}>
                  <label className="scope-family-title">
                    <Checkbox
                      data-family-id={String(family.familyId)}
                      checked={choice?.selected ?? false}
                      disabled={!scopeReady}
                      onCheckedChange={(value) => choose(family, null, value === true)}
                    />
                    <Text weight="medium">{family.name}</Text>
                    <Text size="1" color="gray">
                      {t(`${family.rooms?.length ?? 0}개 방`, `${family.rooms?.length ?? 0} rooms`)}
                    </Text>
                  </label>
                  <div className="scope-rooms">
                    {(family.rooms ?? []).map((room) => (
                      <label className="setting-row" key={room.roomId}>
                        <Checkbox
                          data-family-id={String(family.familyId)}
                          data-room-id={String(room.roomId)}
                          checked={choice?.rooms[room.roomId] ?? false}
                          disabled={!scopeReady || !choice?.selected}
                          onCheckedChange={(value) => choose(family, room.roomId, value === true)}
                        />
                        <Text size="2">{room.name}</Text>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
          {!families.length && (
            <p className="empty-state">{t('집과 방 목록을 아직 불러오지 못했습니다.', 'Homes and rooms are not available yet.')}</p>
          )}
          {!scopeReady && (
            <Text as="p" color="amber" size="2">
              {t(
                '집과 방 목록을 모두 확인해야 저장할 수 있습니다. 입력한 선택은 유지됩니다.',
                'Saving requires a complete home and room list. Your choices are kept.',
              )}
            </Text>
          )}
          <Separator size="4" my="3" />
          <div className="section-footer">
            <Button
              id="saveScope"
              highContrast
              disabled={!scopeReady || scopeConflict || !draft.dirty || draft.pending}
              loading={draft.pending}
              onClick={() => void save().catch(() => undefined)}
            >
              {t('집/방 설정 저장', 'Save homes and rooms')}
            </Button>
            {draft.dirty && <Badge highContrast color="amber">{t('저장 전', 'Unsaved')}</Badge>}
            {scopeConflict && <Button id="resetScope" variant="soft" highContrast disabled={!sourceReady || draft.pending}
              onClick={() => void resetScope()}>
              {t('최신 설정으로 되돌리기', 'Use latest saved settings')}
            </Button>}
            {!scopeReady && (
              <Button variant="ghost" onClick={() => void app.refreshStatus()}>
                {t('목록 다시 확인', 'Reload list')}
              </Button>
            )}
          </div>
          <Text as="p" size="2" role="status" id="scopeStatus" color={scopeConflict || draft.error ? 'red' : 'gray'}>
            {scopeConflict ? t('다른 곳에서 집/방 설정 또는 목록이 바뀌었습니다. 입력한 선택은 유지되며 저장은 중지했습니다.',
              'Saved homes, rooms or their list changed elsewhere. Your choices are kept and saving is paused.') : draft.error || feedback}
          </Text>
        </Card>
      </div>
      <div className="settings-grid">
        <FeatureCard kind="matter" />
        <FeatureCard kind="adaptiveLighting" />
      </div>
    </div>
  );
}
