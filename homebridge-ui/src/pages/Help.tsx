import { useMemo, useState } from 'react';
import { Card, Flex, Heading, Link, Text } from '@radix-ui/themes';
import {
  CheckCircledIcon,
  ChevronDownIcon,
  CopyIcon,
  ExternalLinkIcon,
  FileTextIcon,
  InfoCircledIcon,
  ReloadIcon,
} from '@radix-ui/react-icons';
import { useApp } from '../core';
import { Badge, Button } from '../core/radix';
import { formatDate, type Translate } from './settings-helpers';

type SupportModel = {
  deviceType: string;
  label?: string;
  homeKitService?: string;
  homeKitServices?: string[];
  supportStatus?: string;
  note?: string;
};
type SupportSummary = {
  registeredCount?: number;
  supportedCount?: number;
  partialCount?: number;
  deferredCount?: number;
  unsupportedCount?: number;
  generatedAt?: string;
  unsupportedProducts?: { modelName?: string; count?: number }[];
};
type SupportStatus = { supportedModels?: SupportModel[]; deviceSummary?: SupportSummary; issueTemplate?: { title: string; body: string } };
const repository = 'https://github.com/chazepps/homebridge-hejhome';
const serviceLabels: Record<string, [string, string]> = {
  BatteryService: ['배터리', 'Battery'],
  Camera: ['카메라', 'Camera'],
  ContactSensor: ['문 열림 센서', 'Contact sensor'],
  Fan: ['선풍기', 'Fan'],
  HumiditySensor: ['습도', 'Humidity'],
  LeakSensor: ['누수', 'Leak sensor'],
  Lightbulb: ['조명', 'Light'],
  MotionSensor: ['모션', 'Motion sensor'],
  Outlet: ['콘센트', 'Outlet'],
  SmokeSensor: ['연기', 'Smoke sensor'],
  Switch: ['스위치', 'Switch'],
  TemperatureSensor: ['온도', 'Temperature'],
  Thermostat: ['온도 조절', 'Thermostat'],
  WindowCovering: ['커튼·블라인드', 'Curtain or blind'],
  StatelessProgrammableSwitch: ['버튼', 'Button'],
};
function services(model: SupportModel, t: Translate) {
  if (model.deviceType === 'IrFan') {
    return t('선풍기 또는 전원 버튼', 'Fan or power button');
  }
  return [...new Set(model.homeKitServices ?? [model.homeKitService ?? ''])]
    .filter(Boolean)
    .map((service) => (serviceLabels[service] ? t(...serviceLabels[service]) : service))
    .join(' · ');
}
function modelNote(types: string[], t: Translate) {
  if (types.includes('ZigbeeDoorlock')) {
    return t(
      '문 열림만 표시합니다. 잠금 상태와 잠금·해제 조작은 제공하지 않습니다.',
      'Shows door open/closed only. Lock status and lock/unlock controls are unavailable.',
    );
  }
  if (types.includes('IrFan')) {
    return t(
      '전원 상태가 확인되면 선풍기, 그렇지 않으면 전원 버튼입니다. 풍량·회전 상태는 표시하지 않습니다.',
      'Shows a fan when power is known; otherwise a power button. Fan speed and swing state are not shown.',
    );
  }
  if (types.includes('IrAirconditioner')) {
    return t(
      '확인된 전원과 설정 화면 조작을 제공합니다. 실제 운전 상태를 추정하지 않습니다.',
      'Provides confirmed power and settings-page commands. Actual operating state is not inferred.',
    );
  }
  return '';
}

export default function Help() {
  const app = useApp();
  const { t } = app;
  const status = app.status as unknown as SupportStatus | null;
  const summary = status?.deviceSummary;
  const [report, setReport] = useState('');
  const [loading, setLoading] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const models = useMemo(() => {
    const grouped = new Map<string, { label: string; service: string; status: string; types: string[] }>();
    for (const model of status?.supportedModels ?? []) {
      const service = services(model, t);
      const support =
        model.supportStatus === 'deferred' || model.deviceType === 'LedStripRgbw2'
          ? 'deferred'
          : model.supportStatus === 'partial'
            ? 'partial'
            : 'supported';
      const label = app.language === 'ko' ? model.label || service || model.deviceType : service || model.deviceType;
      const key = `${support}:${label}:${service}:${['ZigbeeDoorlock', 'IrFan', 'IrAirconditioner'].includes(model.deviceType) ? model.deviceType : ''}`;
      const entry = grouped.get(key);
      if (entry) {
        if (!entry.types.includes(model.deviceType)) {
          entry.types.push(model.deviceType);
        }
      } else {
        grouped.set(key, { label, service, status: support, types: [model.deviceType] });
      }
    }
    return [...grouped.values()];
  }, [status?.supportedModels, app.language, t]);
  const fresh = app.fresh;
  const connection = app.diagnostics?.connection;
  const session = fresh ? connection?.session : undefined;
  const realtime = fresh ? connection?.realtime : undefined;
  const sessionText =
    session === 'valid'
      ? t('로그인 정상', 'Signed in')
      : session === 'expired'
        ? t('로그인 만료', 'Sign-in expired')
        : session === 'missing'
          ? t('로그인 필요', 'Sign-in required')
          : t('현재 상태 확인 불가', 'Current status unavailable');
  const realtimeText =
    realtime === 'connected'
      ? t('상태 수신 중', 'Receiving updates')
      : realtime === 'connecting'
        ? t('연결 중', 'Connecting')
        : realtime === 'disconnected'
          ? t('연결 끊김', 'Disconnected')
          : t('현재 상태 확인 불가', 'Current status unavailable');
  const discoveryAt = Date.parse(app.diagnostics?.generatedAt ?? '');
  const discoveryFresh =
    Number.isFinite(discoveryAt) && Date.now() - discoveryAt <= 300_000 && app.diagnostics?.deviceListAvailable === true;
  const devices = app.diagnostics?.devices ?? [];
  const scoped = devices.filter((device) => device.inScope);
  const preparedHap = scoped.filter((device) => device.homekit).length;
  const preparedMatter = scoped.filter((device) => device.matter).length;
  const copy = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setFeedback(t('복사했습니다.', 'Copied.'));
    } catch {
      setFeedback(
        t(
          '자동 복사를 사용할 수 없습니다. 아래 내용을 직접 선택해 복사하세요.',
          'Automatic copy is unavailable. Select and copy the text below.',
        ),
      );
      document.getElementById('diagnosticsExport')?.focus();
    }
  };
  const exportReport = async () => {
    setLoading(true);
    setFeedback('');
    try {
      const response = await app.request<unknown>('/diagnostics-export', {}, { timeoutMs: 10_000 });
      setReport(JSON.stringify(response, null, 2));
    } catch {
      setFeedback(t('진단 내용을 불러오지 못했습니다. 다시 시도해 주세요.', 'Could not load diagnostics. Please try again.'));
    } finally {
      setLoading(false);
    }
  };
  const refresh = async () => {
    setRefreshing(true);
    try {
      await app.refreshDiagnostics();
    } finally {
      setRefreshing(false);
    }
  };
  const template = status?.issueTemplate ? `${status.issueTemplate.title}\n\n${status.issueTemplate.body}` : '';
  return (
    <div className="settings-page">
      <header className="page-header">
        <Text className="page-eyebrow">{t('도움말', 'HELP')}</Text>
        <Heading as="h1" size="7" className="page-title">
          {t('연결을 이해하고 해결하기', 'Understand your connection')}
        </Heading>
        <Text as="p" className="page-description" color="gray">
          {t(
            '최근 연결 상태, 지원 범위와 문제 확인에 필요한 정보를 모았습니다.',
            'Recent connection status, device support and information for troubleshooting.',
          )}
        </Text>
      </header>
      <Card id="diagnosticsSection" className="section-card">
        <div className="section-header">
          <Heading as="h2" size="4">
            {t('연결 상태', 'Connection status')}
          </Heading>
          <Button variant="ghost" size="2" loading={refreshing} onClick={() => void refresh()}>
            <ReloadIcon />
            {t('새로 확인', 'Refresh')}
          </Button>
        </div>
        <div className="diagnostics-grid">
          <div className="diagnostic-item">
            <Text size="1" color="gray">
              {t('클라우드 로그인', 'Cloud sign-in')}
            </Text>
            <Text as="p" weight="medium">
              {sessionText}
            </Text>
            <Badge highContrast color={session === 'valid' ? 'jade' : 'gray'}>
              {session === 'valid' ? t('확인됨', 'Confirmed') : t('확인 필요', 'Needs checking')}
            </Badge>
          </div>
          <div className="diagnostic-item">
            <Text size="1" color="gray">
              {t('실시간 장치 상태', 'Live device updates')}
            </Text>
            <Text as="p" weight="medium" id="diagnosticsBadge">
              {realtimeText}
            </Text>
            <Text size="1" color="gray">
              {formatDate(app.diagnostics?.updatedAt, app.language, t('최근 수신 기록 없음', 'No recent update'))}
            </Text>
          </div>
          <div className="diagnostic-item">
            <Text size="1" color="gray">
              {t('장치 목록', 'Device discovery')}
            </Text>
            <Text as="p" weight="medium">
              {discoveryFresh
                ? t(`${scoped.length}개 장치 확인`, `${scoped.length} devices found`)
                : t('최근 목록 확인 필요', 'Recent list unavailable')}
            </Text>
            <Text size="1" color="gray">
              {formatDate(app.diagnostics?.generatedAt, app.language, t('조회 기록 없음', 'No discovery record'))}
            </Text>
          </div>
        </div>
        <Text as="p" size="2" color="gray" id="helpConnectionSummary">
          {sessionText} · {realtimeText}
        </Text>
        <details className="guidance-details">
          <summary>
            <ChevronDownIcon className="disclosure-chevron" aria-hidden="true" />
            {t('앱 연결 준비는 페어링 완료와 다릅니다', 'App preparation and pairing are separate')}
          </summary>
          <Text as="p" size="2" color="gray">
            {t(
              'Homebridge에서 Apple Home·Matter용으로 준비했거나 이전에 저장한 장치가 있어도 실제 앱에 연결됐다는 뜻은 아닙니다. 페어링 상태는 해당 스마트홈 앱에서 확인하세요.',
              'Being prepared for Apple Home or Matter, or stored in Homebridge, does not confirm app pairing. Check pairing in the smart-home app.',
            )}
          </Text>
          <Text as="p" size="2" color="gray">
            {fresh
              ? t(
                `현재 준비된 장치: Apple Home ${preparedHap}개 · Matter ${preparedMatter}개`,
                `Currently prepared: Apple Home ${preparedHap} · Matter ${preparedMatter}`,
              )
              : t('최근 준비 상태를 확인할 수 없습니다.', 'Recent preparation status is unavailable.')}
          </Text>
        </details>
      </Card>
      <div className="settings-grid">
        <Card className="section-card">
          <div className="section-header">
            <Flex align="center" gap="2">
              <FileTextIcon />
              <Heading as="h2" size="4">
                {t('개인 정보 없는 진단', 'Anonymous diagnostics')}
              </Heading>
            </Flex>
          </div>
          <Text as="p" size="2" color="gray">
            {t(
              '계정·비밀번호·토큰·장치 이름·식별자를 제외한 보고서를 확인하세요. 개발자에게 자동 전송하지 않습니다.',
              'Review a report without accounts, passwords, tokens, device names or identifiers. Nothing is sent to the developer automatically.',
            )}
          </Text>
          <Flex gap="2" wrap="wrap" mt="4">
            <Button id="exportDiagnostics" variant="soft" highContrast loading={loading} onClick={() => void exportReport()}>
              {t('진단 내용 보기', 'View diagnostics')}
            </Button>
            {report && (
              <Button id="copyDiagnostics" variant="outline" onClick={() => void copy(report)}>
                <CopyIcon />
                {t('복사', 'Copy')}
              </Button>
            )}
          </Flex>
          <Text as="p" role="status" size="2" color="gray">
            {feedback}
          </Text>
        </Card>
        <Card className="section-card" id="upgradeSection">
          <div className="section-header">
            <Flex gap="2" align="center">
              <InfoCircledIcon />
              <Heading as="h2" size="4">
                {t('Hejhome 3.0 사용 안내', 'Your guide to Hejhome 3.0')}
              </Heading>
            </Flex>
            <Badge highContrast color={__PLUGIN_VERSION__.includes('-') ? 'iris' : 'green'}>
              {__PLUGIN_VERSION__.includes('-') ? 'BETA' : t('정식', 'Stable')}
            </Badge>
          </div>
          <Text as="p" size="2" color="gray">
            {t(
              '장치별 설정, Matter 연결, 소비전력 설정 등 3.0의 기능과 사용 방법을 확인하세요. 2.x에서 업데이트했다면 변경된 센서·에어컨·리모컨 표시와 관련 자동화도 확인해 주세요.',
              'Explore device settings, Matter connections and power settings in 3.0. '
              + 'If upgrading from 2.x, review changes to sensors, air conditioners and remote buttons, along with related automations.',
            )}
          </Text>
          <Flex gap="4" wrap="wrap" mt="4">
            <Link href={`${repository}/blob/main/docs/product-specs/3.0-beta-guide.md`} target="_blank" rel="noopener noreferrer">
              {t('사용 안내', 'User guide')} <ExternalLinkIcon />
            </Link>
            <Link href={`${repository}/blob/main/docs/product-specs/smart-automation-guide.md`} target="_blank" rel="noopener noreferrer">
              {t('자동화 안내', 'Automation guide')} <ExternalLinkIcon />
            </Link>
          </Flex>
        </Card>
      </div>
      {report && (
        <Card className="section-card">
          <Heading as="h2" size="3">
            {t('진단 보고서', 'Diagnostics report')}
          </Heading>
          <pre id="diagnosticsExport" className="code-block" tabIndex={0}>
            {report}
          </pre>
        </Card>
      )}
      <Card id="supportSection" className="section-card">
        <div className="section-header">
          <Flex gap="2" align="center">
            <CheckCircledIcon />
            <Heading as="h2" size="4">
              {t('장비 및 지원 현황', 'Device support')}
            </Heading>
          </Flex>
          <Badge highContrast id="snapshotBadge" color="gray">
            {summary?.generatedAt ? t('저장된 장비 목록 기준', 'Based on saved device list') : t('목록 없음', 'No device list')}
          </Badge>
        </div>
        <Flex gap="3" wrap="wrap" mb="4" id="supportStats">
          <Badge highContrast color="gray">
            {t('등록', 'Registered')} <span id="registeredCount">{summary?.registeredCount ?? 0}</span>
          </Badge>
          <Badge highContrast color="jade">
            {t('지원 가능', 'Supported')} <span id="supportedCount">{summary?.supportedCount ?? 0}</span>
          </Badge>
          <Badge highContrast color="amber">
            {t('미지원', 'Unsupported')} <span id="unsupportedCount">{summary?.unsupportedCount ?? 0}</span>
          </Badge>
        </Flex>
        <div id="supportedModels">
          {(['supported', 'partial', 'deferred'] as const).map((group) => {
            const items = models.filter((model) => model.status === group);
            return (
              items.length > 0 && (
                <details key={group} className="guidance-details support-group" open={group === 'partial'}>
                  <summary>
                    <ChevronDownIcon className="disclosure-chevron" aria-hidden="true" />
                    {group === 'supported'
                      ? t('지원하는 모델', 'Supported models')
                      : group === 'partial'
                        ? t('일부 기능 지원', 'Limited support')
                        : t('아직 사용할 수 없음', 'Not available yet')}
                    <Badge highContrast color={group === 'supported' ? 'jade' : 'amber'}>
                      {items.reduce((total, model) => total + model.types.length, 0)}
                    </Badge>
                  </summary>
                  <div className="model-grid">
                    {items.map((model) => (
                      <div className="model-item" key={`${model.label}:${model.types.join(':')}`}>
                        <Text weight="medium" size="2">
                          {model.label}
                        </Text>
                        {model.service && model.service !== model.label && (
                          <Text as="p" size="1" color="gray">
                            {model.service}
                          </Text>
                        )}
                        <Text as="p" size="1" color="gray">
                          {model.types.join(' · ')}
                        </Text>
                        {modelNote(model.types, t) && (
                          <Text as="p" size="1" color="gray">
                            {modelNote(model.types, t)}
                          </Text>
                        )}
                      </div>
                    ))}
                  </div>
                </details>
              )
            );
          })}
        </div>
        {!models.length && (
          <Text as="p" size="2" color="gray">
            {t('모델 지원 정보를 아직 불러오지 못했습니다.', 'Model support information is unavailable.')}
          </Text>
        )}
        {(summary?.unsupportedProducts?.length ?? 0) > 0 && (
          <details className="guidance-details">
            <summary>
              <ChevronDownIcon className="disclosure-chevron" aria-hidden="true" />
              {t('발견된 미지원 제품과 지원 요청', 'Unsupported products and support requests')}
            </summary>
            <div id="unsupportedProducts" className="model-grid">
              {summary!.unsupportedProducts!.map((product, index) => (
                <div className="model-item" key={`${product.modelName}:${index}`}>
                  <Text size="2" weight="medium">
                    {product.modelName || t('알 수 없는 제품', 'Unknown product')}
                  </Text>
                  <Badge highContrast color="amber">{t(`${product.count ?? 0}개 발견`, `${product.count ?? 0} found`)}</Badge>
                </div>
              ))}
            </div>
            {template && (
              <div id="issueSection">
                <Text as="p" size="2" color="gray">
                  {t(
                    '아래 모델 정보를 GitHub 이슈에 붙여 지원을 요청할 수 있습니다.',
                    'Paste this model information into a GitHub issue to request support.',
                  )}
                </Text>
                <pre id="issueTemplate" className="code-block" tabIndex={0}>
                  {template}
                </pre>
                <Flex gap="3" wrap="wrap">
                  <Button variant="soft" highContrast onClick={() => void copy(template)}>
                    <CopyIcon />
                    {t('요청 양식 복사', 'Copy request template')}
                  </Button>
                  <Link href={`${repository}/issues`} target="_blank" rel="noopener noreferrer">
                    {t('GitHub 지원 요청', 'GitHub support')} <ExternalLinkIcon />
                  </Link>
                </Flex>
              </div>
            )}
          </details>
        )}
      </Card>
    </div>
  );
}
