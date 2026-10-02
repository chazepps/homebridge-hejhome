export type Translate = (ko: string, en: string) => string;
export type Scope = {
  mode: 'all' | 'first-family' | 'custom';
  includedFamilyIds?: number[];
  includedRoomsByFamilyId?: Record<string, number[]>;
};
export type Family = { familyId: number; name: string; rooms?: { roomId: number; name: string }[] };
export type ScopeChoices = Record<string, { selected: boolean; rooms: Record<string, boolean> }>;

/** A scope ticket may renew only against this same saved selection and room inventory. */
export function scopeSourceKey(scope: Scope, families: Family[]): string {
  return JSON.stringify({
    mode: scope.mode,
    familyIds: [...(scope.includedFamilyIds ?? [])].sort((a, b) => a - b),
    rooms: Object.entries(scope.includedRoomsByFamilyId ?? {}).sort(([a], [b]) => a.localeCompare(b))
      .map(([id, rooms]) => [id, [...rooms].sort((a, b) => a - b)]),
    families: families.map((family) => [family.familyId, (family.rooms ?? []).map((room) => room.roomId).sort((a, b) => a - b)]),
  });
}

export function scopeChoices(scope: Scope, families: Family[]): ScopeChoices {
  return Object.fromEntries(
    families.map((family, index) => {
      const selected =
        scope.mode === 'all' ||
        (scope.mode === 'first-family' && index === 0) ||
        (scope.mode === 'custom' && (scope.includedFamilyIds ?? []).includes(Number(family.familyId)));
      const rooms = scope.includedRoomsByFamilyId?.[String(family.familyId)];
      return [
        String(family.familyId),
        {
          selected,
          rooms: Object.fromEntries(
            (family.rooms ?? []).map((room) => [
              String(room.roomId),
              selected && (scope.mode !== 'custom' || !rooms || rooms.includes(Number(room.roomId))),
            ]),
          ),
        },
      ];
    }),
  );
}

export function choicesScope(choices: ScopeChoices, families: Family[]): Scope {
  const ids = families.filter((family) => choices[family.familyId]?.selected).map((family) => Number(family.familyId));
  const allRooms = (family: Family) => (family.rooms ?? []).every((room) => choices[family.familyId]?.rooms[room.roomId]);
  if (families.length && ids.length === families.length && families.every(allRooms)) {
    return { mode: 'all' };
  }
  if (ids.length === 1 && ids[0] === Number(families[0]?.familyId) && families[0] && allRooms(families[0])) {
    return { mode: 'first-family' };
  }
  return {
    mode: 'custom',
    includedFamilyIds: ids,
    includedRoomsByFamilyId: Object.fromEntries(
      families
        .filter((family) => ids.includes(Number(family.familyId)) && !allRooms(family))
        .map((family) => [
          String(family.familyId),
          (family.rooms ?? []).filter((room) => choices[family.familyId]?.rooms[room.roomId]).map((room) => Number(room.roomId)),
        ]),
    ),
  };
}

export function errorCode(error: unknown): string | undefined {
  const item = error as { code?: string; error?: { code?: string }; requestError?: { code?: string } };
  return item?.requestError?.code ?? item?.error?.code ?? item?.code;
}

export function formatDate(value: unknown, language: string, fallback: string): string {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value))) {
    return fallback;
  }
  return new Intl.DateTimeFormat(language === 'en' ? 'en-US' : 'ko-KR', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'Asia/Seoul',
  }).format(new Date(value));
}

export function validateMeters(raw: string, t: Translate): unknown[] {
  let profiles: unknown;
  try {
    profiles = JSON.parse(raw);
  } catch {
    throw new Error(t('원본 JSON 형식을 확인해 주세요.', 'Check the raw JSON format.'));
  }
  if (!Array.isArray(profiles)) {
    throw new Error(t('측정 모델 목록은 배열이어야 합니다.', 'Meter profiles must be an array.'));
  }
  const known = new Set<string>();
  const reserved = new Set([
    'brightness',
    'lightMode',
    'hsvColor',
    'sceneValues',
    'temperature',
    'humidity',
    'pm25',
    'battery',
    'motionDetected',
    'lastMotionAt',
    'state',
    'doorOpened',
    'alarm',
    'alarmSwitch',
    'percentState',
    'percentControl',
    'control',
    'workState',
    'fanSpeed',
    'mode',
    'action',
    'event',
    'button',
    'buttonEvent',
    'gesture',
  ]);
  for (const [index, rawProfile] of profiles.entries()) {
    const profile = rawProfile as Record<string, unknown> | null;
    if (!profile || typeof profile.model !== 'string' || !profile.model.trim() || known.has(profile.model)) {
      throw new Error(t(`${index + 1}행: 중복되지 않는 모델명을 입력해 주세요.`, `Row ${index + 1}: enter a unique model name.`));
    }
    known.add(profile.model);
    let measurements = 0;
    for (const kind of ['power', 'current', 'voltage', 'energy']) {
      if (profile[kind] === undefined) {
        continue;
      }
      const pair = profile[kind] as { field?: string; multiplier?: number } | null;
      if (
        !pair ||
        typeof pair.field !== 'string' ||
        !/^[a-zA-Z][a-zA-Z0-9_]*$/.test(pair.field) ||
        /^power\d*$/.test(pair.field) ||
        reserved.has(pair.field) ||
        typeof pair.multiplier !== 'number' ||
        !Number.isFinite(pair.multiplier) ||
        pair.multiplier <= 0
      ) {
        throw new Error(
          t(
            `${index + 1}행 ${kind}: 원본 항목 이름과 0보다 큰 배율을 입력해 주세요.`,
            `Row ${index + 1} ${kind}: enter a source field and a positive multiplier.`,
          ),
        );
      }
      measurements++;
    }
    if (!measurements) {
      throw new Error(t(`${index + 1}행: 측정 항목이 필요합니다.`, `Row ${index + 1}: add at least one measurement.`));
    }
  }
  return profiles;
}
