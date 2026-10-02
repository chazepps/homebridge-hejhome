import { useEffect, useReducer, useRef, useState } from 'react';
import { Card, Flex, Heading, Text, TextArea, TextField } from '@radix-ui/themes';
import { ChevronDownIcon, InfoCircledIcon, LightningBoltIcon, MixerHorizontalIcon } from '@radix-ui/react-icons';
import { useApp, useDraft } from '../core';
import { Badge, Button } from '../core/radix';
import { errorCode, validateMeters, type Translate } from './settings-helpers';

const fields = ['activeWatts', 'standbyWatts'] as const;
type Field = (typeof fields)[number];
type Watts = Record<Field, number | null>;
type PowerDevice = {
  id: string;
  name?: string;
  modelName?: string;
  inScope?: boolean;
  preference?: { powerSpec?: Partial<Watts> };
  powerEstimateMeterPriority?: boolean;
  powerSpecEligibility?: { supported?: boolean; reason?: string };
};
type PowerRow = {
  device: PowerDevice;
  base: Watts;
  draft: Record<Field, string>;
  invalid: Record<Field, boolean>;
  available: boolean;
  edit: number;
  pendingEdit: number | null;
  preserve: boolean;
};
type PowerDiagnostic = { uiSessionRevision?: string; deviceListAvailable?: boolean; generatedAt?: string; devices?: PowerDevice[] };
type PowerAck = { ok: boolean; uiSessionRevision: string; powerSpecs: ({ deviceId: string } & Watts)[] };
const numberValue = (raw: string) => (raw.trim() === '' ? null : Number(raw));
const rowDirty = (row: PowerRow) =>
  row.preserve ||
  (row.pendingEdit !== null && row.edit !== row.pendingEdit) ||
  fields.some((field) => row.invalid[field] || numberValue(row.draft[field]) !== row.base[field]);
// A capability update must not strand stored values or an in-flight edit.
const emptyUnsupported = (row: PowerRow) =>
  row.device.powerSpecEligibility?.supported === false &&
  fields.every((field) => row.base[field] === null) &&
  !rowDirty(row) && row.pendingEdit === null;
const validWatts = (value: unknown): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1_000_000;
const baseline = (device: PowerDevice): Watts => ({
  activeWatts: validWatts(device.preference?.powerSpec?.activeWatts) ? device.preference.powerSpec.activeWatts : null,
  standbyWatts: validWatts(device.preference?.powerSpec?.standbyWatts) ? device.preference.powerSpec.standbyWatts : null,
});
const draftValues = (watts: Watts) => ({
  activeWatts: watts.activeWatts === null ? '' : String(watts.activeWatts),
  standbyWatts: watts.standbyWatts === null ? '' : String(watts.standbyWatts),
});

function supportLabel(device: PowerDevice, t: Translate) {
  if (device.powerEstimateMeterPriority) {
    return t('실측 프로필 우선 · 사양 추정 미사용', 'Measured profile takes priority · estimates unused');
  }
  if (device.powerSpecEligibility?.supported === true) {
    return t('추정 지원 · 확인된 전원 상태 기준', 'Estimate supported · confirmed power state required');
  }
  if (device.powerSpecEligibility?.supported === false) {
    return device.powerSpecEligibility.reason === 'multiple-loads'
      ? t('추정 미지원 · 여러 부하', 'Unsupported estimate · multiple loads')
      : t('추정 미지원 · 장치 종류', 'Unsupported estimate · device type');
  }
  return t('추정 지원 여부 확인 필요', 'Estimate support unconfirmed');
}

function MeterSettings() {
  const app = useApp();
  const { t } = app;
  const draft = useDraft<string>('feature:meters', JSON.stringify(app.status?.features?.meters ?? [], null, 2));
  const [feedback, setFeedback] = useState('');
  const save = async () => {
    setFeedback('');
    await draft.save(async (raw) => {
      const meters = validateMeters(raw, t);
      const result = await app.mutate<{ ok: boolean; features?: { meters?: unknown[] } }>(
        '/save-features',
        { features: { meters } },
        { requireFresh: false },
      );
      if (!result?.ok) {
        throw new Error(t('전력 측정 설정을 저장하지 못했습니다.', 'Could not save meter settings.'));
      }
      setFeedback(
        t('전력 측정 설정을 저장했습니다. Homebridge를 다시 시작하면 적용됩니다.', 'Meter settings saved. Restart Homebridge to apply.'),
      );
      return JSON.stringify(result.features?.meters ?? meters, null, 2);
    });
  };
  return (
    <Card className="section-card" id="meterHelpSection">
      <details className="guidance-details" id="meterDetails">
        <summary>
          <MixerHorizontalIcon />
          <span>{t('고급: 전력 측정 모델 설정', 'Advanced: power meter models')}</span>
          {draft.dirty && <Badge highContrast color="amber">{t('저장 전', 'Unsaved')}</Badge>}
          <ChevronDownIcon className="disclosure-chevron" aria-hidden="true" />
        </summary>
        <Text as="p" size="2" color="gray">
          {t(
            '실제 측정 프로필의 모델·원본 항목·단위 배율을 편집합니다. 수동 W 사양과 별개이며, 확인된 측정 단위만 입력하세요.',
            'Edit models, source fields and unit multipliers for measured profiles, separate from manual watts. Use confirmed units only.',
          )}
        </Text>
        <Text as="p" size="2" color="gray">
          {t(
            'power는 W, current는 A, voltage는 V, energy는 누적 Wh로 변환합니다. 측정되지 않은 값은 만들지 않습니다.',
            'Convert power to W, current to A, voltage to V and total energy to Wh. Missing readings are not invented.',
          )}
        </Text>
        <Text as="label" htmlFor="meterProfiles" size="2" weight="medium">
          {t('전문가용 원본 설정', 'Expert raw settings')}
        </Text>
        <TextArea
          id="meterProfiles"
          rows={9}
          spellCheck={false}
          value={draft.value}
          onChange={(event) => {
            draft.setValue(event.target.value);
            setFeedback('');
          }}
          disabled={!app.ready || app.accountChangePending}
          className="meter-json"
        />
        <div className="section-footer">
          <Button
            id="saveMeters"
            variant="soft" highContrast
            disabled={!app.ready || app.accountChangePending || !draft.dirty || draft.pending}
            loading={draft.pending}
            onClick={() => void save().catch(() => undefined)}
          >
            {t('전력 측정 설정 저장', 'Save power meter settings')}
          </Button>
        </div>
        <Text as="p" size="2" role="status" id="meterStatus" color={draft.error ? 'red' : 'gray'}>
          {draft.error || feedback}
        </Text>
      </details>
    </Card>
  );
}

export default function Power() {
  const app = useApp();
  const { t } = app;
  const diagnostics = app.diagnostics as PowerDiagnostic | null;
  const rows = useRef(new Map<string, PowerRow>());
  const focused = useRef<string | null>(null);
  const inputs = useRef(new Map<string, HTMLInputElement>());
  const pending = useRef(false);
  const ownerEpoch = useRef(app.accountEpoch);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [failed, setFailed] = useState(false);
  const [, render] = useReducer((value) => value + 1, 0);
  const validList =
    diagnostics?.deviceListAvailable === true &&
    Array.isArray(diagnostics.devices) &&
    Number.isFinite(Date.parse(diagnostics.generatedAt ?? '')) &&
    Boolean(app.revision) &&
    diagnostics.uiSessionRevision === app.revision;
  const canEdit = app.ready && !app.accountChangePending && validList;
  const dirty = [...rows.current.values()].some(rowDirty);
  const unavailableDraft = [...rows.current.values()].some((row) => !row.available && rowDirty(row));

  useEffect(() => {
    if (ownerEpoch.current === app.accountEpoch) {
      return;
    }
    ownerEpoch.current = app.accountEpoch;
    rows.current.clear();
    inputs.current.clear();
    pending.current = false;
    focused.current = null;
    setSaving(false);
    setFeedback('');
    setFailed(false);
    render();
  }, [app.accountEpoch]);

  useEffect(() => {
    if (!validList || app.accountChangePending) {
      return;
    }
    const devices = diagnostics!.devices!.filter((device) => device.inScope === true && typeof device.id === 'string' && device.id);
    const ids = new Set(devices.map((device) => device.id));
    for (const device of devices) {
      const current = rows.current.get(device.id);
      if (!current) {
        const base = baseline(device);
        rows.current.set(device.id, {
          device,
          base,
          draft: draftValues(base),
          invalid: { activeWatts: false, standbyWatts: false },
          available: true,
          edit: 0,
          pendingEdit: null,
          preserve: false,
        });
      } else {
        current.device = device;
        current.available = true;
        if (!pending.current && !rowDirty(current) && focused.current !== device.id) {
          current.base = baseline(device);
          current.draft = draftValues(current.base);
          current.invalid = { activeWatts: false, standbyWatts: false };
        }
      }
    }
    for (const [id, row] of rows.current) {
      if (ids.has(id)) {
        continue;
      }
      if (!rowDirty(row)) {
        rows.current.delete(id);
      } else {
        row.available = false;
      }
    }
    render();
  }, [diagnostics, validList, app.accountChangePending]);

  useEffect(() => {
    app.setDirty('power-specs', dirty);
  }, [dirty, app.setDirty]);
  useEffect(
    () => () => {
      app.setDirty('power-specs', false);
    },
    [app.setDirty],
  );

  const edit = (row: PowerRow, field: Field, raw: string, badInput: boolean) => {
    row.draft[field] = raw;
    row.invalid[field] = badInput || (raw !== '' && !validWatts(Number(raw)));
    row.edit++;
    if (!pending.current) {
      setFeedback('');
      setFailed(false);
    }
    render();
  };

  const save = async () => {
    if (!canEdit || pending.current || unavailableDraft) {
      return;
    }
    const changed = [...rows.current.values()].filter(rowDirty);
    if (!changed.length) {
      return;
    }
    const invalid = changed
      .flatMap((row) => fields.map((field) => ({ row, field })))
      .find(({ row, field }) => row.invalid[field] || (row.draft[field] !== '' && !validWatts(Number(row.draft[field]))));
    if (invalid) {
      setFailed(true);
      setFeedback(
        t('0~1,000,000 W 사이의 숫자를 입력하거나 빈칸으로 두세요.', 'Enter a number from 0 to 1,000,000 W, or leave the field blank.'),
      );
      inputs.current.get(`${invalid.row.device.id}:${invalid.field}`)?.focus();
      return;
    }
    const epoch = app.accountEpoch;
    const revision = app.revision;
    const submissions = changed.map((row) => ({
      row,
      edit: row.edit,
      update: {
        deviceId: row.device.id,
        activeWatts: numberValue(row.draft.activeWatts),
        standbyWatts: numberValue(row.draft.standbyWatts),
        expected: { ...row.base },
      },
    }));
    for (const entry of submissions) {
      entry.row.pendingEdit = entry.edit;
    }
    pending.current = true;
    setSaving(true);
    setFailed(false);
    setFeedback(t('저장 중입니다.', 'Saving.'));
    try {
      const result = await app.mutate<PowerAck>(
        '/save-power-specs',
        { uiSessionRevision: revision, updates: submissions.map((entry) => entry.update) },
        { requireFresh: false },
      );
      if (epoch !== ownerEpoch.current) {
        return;
      }
      if (!result?.ok || result.uiSessionRevision !== revision || !Array.isArray(result.powerSpecs)) {
        throw new Error('Invalid power save response');
      }
      const saved = new Map(result.powerSpecs.map((spec) => [spec.deviceId, spec]));
      if (
        submissions.some(
          ({ row }) =>
            !saved.has(row.device.id) ||
            fields.some((field) => saved.get(row.device.id)![field] !== null && !validWatts(saved.get(row.device.id)![field])),
        )
      ) {
        throw new Error('Incomplete power save response');
      }
      for (const { row, edit } of submissions) {
        const spec = saved.get(row.device.id)!;
        row.base = { activeWatts: spec.activeWatts, standbyWatts: spec.standbyWatts };
        row.pendingEdit = null;
        row.preserve = false;
        if (row.edit === edit) {
          row.draft = draftValues(row.base);
          row.invalid = { activeWatts: false, standbyWatts: false };
        }
      }
      setFeedback(
        [...rows.current.values()].some(rowDirty)
          ? t(
            '전력 설정을 저장했습니다. 저장 중 추가한 변경사항은 아직 저장되지 않았습니다.',
            'Power settings saved. Changes made while saving are still unsaved.',
          )
          : t(
            '전력 설정을 저장했습니다. Matter를 켜고 Homebridge를 다시 시작하면 적용됩니다.',
            'Power settings saved. Enable Matter and restart Homebridge to apply.',
          ),
      );
      void app.refreshDiagnostics();
    } catch (error) {
      if (epoch !== ownerEpoch.current) {
        return;
      }
      for (const { row, edit } of submissions) {
        if (row.edit !== edit) {
          row.preserve = true;
        }
        row.pendingEdit = null;
      }
      setFailed(true);
      setFeedback(
        errorCode(error) === 'power-specs-conflict'
          ? t(
            '다른 곳에서 설정이 변경되어 저장하지 못했습니다. 입력값은 유지됩니다. 최신 설정을 확인한 뒤 다시 열어 주세요.',
            'Settings changed elsewhere. Your entries are kept. Check the latest settings and reopen this page.',
          )
          : t(
            '전력 설정을 저장하지 못했습니다. 입력값은 유지됩니다. 장치 목록과 연결을 확인한 뒤 다시 시도하세요.',
            'Could not save power settings. Entries are kept. Check the device list and connection, then try again.',
          ),
      );
    } finally {
      if (epoch === ownerEpoch.current) {
        pending.current = false;
        setSaving(false);
        render();
      }
    }
  };

  const listMessage = !validList
    ? t(
      '장치 목록을 확인할 수 없어 저장할 수 없습니다. 입력값은 유지됩니다. 집/방 선택을 바꿨다면 Homebridge를 다시 시작한 뒤 확인하세요.',
      'The device list is unavailable, so saving is paused. Entries are kept. If you changed homes or rooms, restart Homebridge and check again.',
    )
    : unavailableDraft
      ? t(
        '변경한 장치가 목록에서 사라졌습니다. 입력값은 유지되며 장치가 돌아오면 저장할 수 있습니다.',
        'A changed device is no longer in the list. Entries are kept; save when the device returns.',
      )
      : !rows.current.size
        ? t('선택한 집과 방에 등록된 장치가 없습니다.', 'No registered devices in the selected homes and rooms.')
        : '';
  return (
    <div className="settings-page">
      <header className="page-header">
        <Text className="page-eyebrow">{t('전력', 'POWER')}</Text>
        <Heading as="h1" className="page-title" size="7" id="powerSpecsTitle">
          {t('장치별 소비전력', 'Power specifications')}
        </Heading>
        <Text as="p" className="page-description" color="gray">
          {t(
            '필요한 장치의 W 사양만 입력하세요. 장치와 모델은 자동으로 표시됩니다.',
            'Enter watt specifications for the devices you need. Devices and models appear automatically.',
          )}
        </Text>
      </header>
      <Card className="section-card">
        <div className="section-header">
          <Flex gap="2" align="center">
            <LightningBoltIcon />
            <Heading as="h2" size="4">
              {t('전력 사양', 'Watt specifications')}
            </Heading>
          </Flex>
          <Badge highContrast variant="soft" color="gray">
            {t('수동 입력 · 추정용', 'Manual · for estimates')}
          </Badge>
        </div>
        <Text as="p" size="2" color="gray" id="powerSpecsGuide">
          {t(
            '소비전력은 켜짐, 대기전력은 꺼짐 상태의 W 사양입니다. 빈칸은 미설정, 0은 0 W이며 입력 범위는 0~1,000,000 W입니다.',
            'Active is the on-state watt specification; standby is the off-state specification. Blank means unset; 0 means 0 W. Range: 0–1,000,000 W.',
          )}
        </Text>
        <div id="powerSpecsScroll" className="power-table-wrap">
          <table id="powerSpecTable" className="power-table" aria-describedby="powerSpecsGuide">
            <thead>
              <tr>
                <th scope="col">{t('장치', 'Device')}</th>
                <th scope="col" id="powerSpecActiveHeader">
                  {t('소비전력', 'Active')}{' '}
                  <Text size="1" color="gray">
                    W
                  </Text>
                </th>
                <th scope="col" id="powerSpecStandbyHeader">
                  {t('대기전력', 'Standby')}{' '}
                  <Text size="1" color="gray">
                    W
                  </Text>
                </th>
              </tr>
            </thead>
            <tbody id="powerSpecTableBody">
              {[...rows.current.values()].map((row) => (
                <tr
                  key={row.device.id}
                  data-testid="power-spec-row"
                  data-power-device-id={row.device.id}
                  data-device-id={row.device.id}
                  data-unavailable={!row.available || undefined}
                  data-estimate-supported={row.device.powerSpecEligibility?.supported}
                  data-estimate-readonly={emptyUnsupported(row) || undefined}
                >
                  <td>
                    <Text as="div" weight="medium" className="power-device-name" title={row.device.name || row.device.id}>
                      {row.device.name || row.device.id}
                    </Text>
                    {row.device.modelName && (
                      <Text as="div" className="power-model" size="1" color="gray" title={row.device.modelName}>
                        {row.device.modelName}
                      </Text>
                    )}
                    <Text as="div" className="power-support" size="1" color="gray">
                      {supportLabel(row.device, t)}
                    </Text>
                    {!row.available && (
                      <Text as="div" size="1" color="amber">
                        {t('현재 목록에 없음', 'Unavailable in current list')}
                      </Text>
                    )}
                  </td>
                  {fields.map((field) => (
                    <td key={field}>
                      <TextField.Root
                        type="number"
                        min="0"
                        max="1000000"
                        step="any"
                        inputMode="decimal"
                        autoComplete="off"
                        data-power-field={field}
                        value={row.draft[field]}
                        aria-invalid={row.invalid[field]}
                        disabled={!canEdit || !row.available || emptyUnsupported(row)}
                        title={emptyUnsupported(row)
                          ? t('이 장치는 전력 추정에 사용하지 않습니다.', 'This device is not used for power estimation.') : undefined}
                        aria-label={`${row.device.name || row.device.id} · ${field === 'activeWatts'
                          ? t('소비전력 (W)', 'Active power (W)') : t('대기전력 (W)', 'Standby power (W)')}`}
                        ref={(input) => {
                          if (input) {
                            inputs.current.set(`${row.device.id}:${field}`, input);
                          } else {
                            inputs.current.delete(`${row.device.id}:${field}`);
                          }
                        }}
                        onFocus={() => {
                          focused.current = row.device.id;
                        }}
                        onBlur={() => {
                          if (focused.current === row.device.id) {
                            focused.current = null;
                          }
                        }}
                        onInput={(event) => edit(row, field, event.currentTarget.value, event.currentTarget.validity.badInput)}
                        onChange={() => undefined}
                      />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <Text as="p" size="2" color="amber" role="status" id="powerSpecsListState">
          {listMessage}
        </Text>
        <div className="section-footer">
          <Button
            id="powerSpecsSave"
            highContrast
            disabled={!canEdit || saving || unavailableDraft || !dirty}
            loading={saving}
            onClick={() => void save().catch(() => undefined)}
          >
            {t('전력 설정 저장', 'Save power settings')}
          </Button>
          {dirty && <Badge highContrast color="amber">{t('저장 전', 'Unsaved')}</Badge>}
          <Text size="1" color="gray">
            {t('변경한 장치만 한 번에 저장합니다.', 'Only changed devices are saved, together.')}
          </Text>
        </div>
        <Text as="p" size="2" role="status" id="powerSpecsFeedback" color={failed ? 'red' : 'gray'}>
          {feedback}
        </Text>
      </Card>
      <Card className="section-card">
        <details className="guidance-details">
          <summary>
            <InfoCircledIcon />
            {t('전력 추정과 적용 방법', 'Estimation and setup')}
            <ChevronDownIcon className="disclosure-chevron" aria-hidden="true" />
          </summary>
          <Text as="p" size="2" color="gray">
            {t(
              '입력한 W 사양과 확인된 전원 상태로 전력·누적 사용량을 추정합니다. 상태 미확인, 연결 끊김과 재시작 공백은 제외하며 실측 전력·전력량 프로필이 있으면 실측을 우선합니다.',
              'Estimate power and energy from watts and confirmed power state. Exclude unknown states and connection/restart gaps. Measurements take priority.',
            )}
          </Text>
          <Text as="p" size="2" color="gray" id="powerSpecsMatterState">
            {app.status?.features?.matter
              ? t(
                '플러그인 Matter가 켜져 있습니다. Homebridge 해당 브리지에서도 Matter를 켜고 저장 후 Homebridge를 다시 시작하세요.',
                'Plugin Matter is on. Enable Matter on this Homebridge bridge too, then save and restart Homebridge.',
              )
              : t(
                '플러그인 Matter가 꺼져 있습니다. 연결 설정과 Homebridge 해당 브리지에서 Matter를 켜고 저장 후 Homebridge를 다시 시작하세요.',
                'Plugin Matter is off. Enable Matter in Connections and on this Homebridge bridge, then save and restart Homebridge.',
              )}
          </Text>
          <Text as="p" size="2" color="gray">
            {t(
              '조명은 원래 종류를 유지합니다. Homebridge 타일이나 Apple Home의 W·에너지 표시는 장치 종류, OS와 컨트롤러 지원에 따라 다릅니다. 미지원 장치의 저장값도 유지되며 비우고 저장하면 해제됩니다.',
              'Display depends on device type, OS and controller. Lights keep their type. Unsupported values are kept; clear and save to remove them.',
            )}
          </Text>
        </details>
      </Card>
      <MeterSettings />
    </div>
  );
}
