import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { installUiHost, mountUi, publishStatus, requestCalls, type UiDevice } from './host-fixture.js';

// Synthetic model names test UI matching only; they do not claim metering support on real hardware.
const modelDevices: UiDevice[] = [
  { id: 'fixture-plug-1', name: 'First plug', deviceType: 'Plug', modelName: 'SYNTHETIC-METER-01', meterProfileApplied: false },
  { id: 'fixture-plug-2', name: 'Second plug', deviceType: 'Plug', modelName: 'SYNTHETIC-METER-01', meterProfileApplied: false },
  { id: 'fixture-relay', name: 'Rack relay', deviceType: 'RelayController', modelName: 'SYNTHETIC-RELAY-02', meterProfileApplied: false },
  { id: 'fixture-unknown', name: 'No model', deviceType: 'Plug', modelName: null, meterProfileApplied: false },
];
const kinds = ['power', 'voltage', 'current', 'energy'] as const;
const fields = { power: 'curPower', voltage: 'curVoltage', current: 'curCurrent', energy: 'totalWh' };
const units = { power: 'W', voltage: 'V', current: 'A', energy: 'Wh' };
const base = { model: 'BASE', power: { field: 'curPower', multiplier: 1 } };
async function openMeters(page: Page, language: 'ko' | 'en' = 'ko') {
  await page.getByRole('tab', { name: language === 'en' ? 'Help' : '도움말', exact: true }).click();
  await page.getByText(language === 'en' ? 'Advanced: power meter models' : '고급: 전력 측정 모델 설정', { exact: true }).click();
}
async function addRow(page: Page) {
  await page.locator('#addMeter').click();
  return page.getByTestId('meter-row').last();
}
async function fillRow(row: Locator, model: string, kind: typeof kinds[number] = 'power', factor = '1') {
  await row.locator('[data-meter-model]').fill(model);
  await row.locator('[data-meter-kind]').selectOption(kind);
  await row.locator('[data-meter-multiplier]').fill(factor);
}
async function savedMeters(page: Page) {
  return (await requestCalls(page, '/save-features')).at(-1)?.payload;
}
async function settledScrollGeometry(wrapper: Locator) {
  return wrapper.evaluate(async (node) => {
    const snapshot = () => ({ left: node.scrollLeft, width: node.clientWidth, contentWidth: node.scrollWidth });
    let previous = snapshot();
    let unchangedFrames = 0;
    const deadline = performance.now() + 2000;
    while (performance.now() < deadline) {
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
      const current = snapshot();
      unchangedFrames = current.left === previous.left && current.width === previous.width
        && current.contentWidth === previous.contentWidth ? unchangedFrames + 1 : 0;
      if (unchangedFrames >= 3) {
        return current;
      }
      previous = current;
    }
    throw new Error('Native keyboard/focus scrolling did not settle before the state-preservation check.');
  });
}
async function mountSaved(page: Page, meters: unknown[] = [base], language: 'ko' | 'en' = 'ko') {
  await mountUi(page, { language, devices: modelDevices, status: { features: { matter: false, adaptiveLighting: false, meters } } });
  await openMeters(page, language);
}

for (const language of ['ko', 'en'] as const) {
  test(`${language} calculator has six explained columns and a static unsaved reference row`, async ({ page }) => {
    await mountUi(page, { language });
    await openMeters(page, language);
    const table = page.getByTestId('meter-table');
    await expect(table.locator('thead th')).toHaveCount(6);
    const example = page.getByTestId('meter-example-row');
    expect(await table.locator('tbody tr').first().getAttribute('data-testid')).toBe('meter-example-row');
    await expect(example.locator('input, select, button, textarea')).toHaveCount(0);
    await expect(example).toHaveCSS('font-style', 'italic');
    await expect(example).toContainText(language === 'en' ? /fictional|example/i : /가상|예시/);
    for (const cell of await table.locator('th,td').all()) {
      await expect(cell).toHaveCSS('white-space', 'nowrap');
    }
    const explanations = page.locator('#meterDetails dl');
    await expect(explanations).toBeVisible();
    await expect(explanations.locator('dt')).toHaveCount(6);
    for (const unit of Object.values(units)) {
      await expect(explanations).toContainText(unit);
    }
    await expect(page.locator('#meterScrollRange,[data-meter-field]')).toHaveCount(0);
    await page.locator('#saveMeters').click();
    await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [] } });
  });
}

test('a new calculator row has one blank model input with exact observed suggestions and manual entry', async ({ page }) => {
  await mountUi(page, { devices: modelDevices });
  await openMeters(page);
  const row = await addRow(page);
  await expect(row.locator('td')).toHaveCount(6);
  await expect(row.locator('select')).toHaveCount(1);
  await expect(row.locator('[data-meter-kind]')).toHaveValue('');
  for (const input of await row.locator('input').all()) {
    await expect(input).toHaveValue('');
  }
  const model = row.locator('[data-meter-model]');
  const listId = await model.getAttribute('list');
  expect(listId).toBeTruthy();
  const list = page.locator(`datalist[id="${listId}"]`);
  await expect(list.locator('option[value="SYNTHETIC-METER-01"]')).toHaveCount(1);
  expect(await list.locator('option[value="SYNTHETIC-METER-01"]').getAttribute('label')).toMatch(/First plug|Second plug/);
  await fillRow(row, 'SYNTHETIC-METER-01');
  await page.locator('#saveMeters').click();
  await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [{ model: 'SYNTHETIC-METER-01', power: base.power }] } });
  await row.locator('[data-meter-model]').fill('MANUAL-MODEL');
  await page.locator('#saveMeters').click();
  await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [{ model: 'MANUAL-MODEL', power: base.power }] } });
});

test('four stored kinds flatten into four rows and regroup with custom source fields intact', async ({ page }) => {
  const profile = { model: 'OLDER-MODEL', power: { field: 'wattsRaw', multiplier: 0.1 },
    voltage: { field: 'curVoltage', multiplier: 0.1 }, current: { field: 'ampsCustom', multiplier: 0.001 },
    energy: { field: 'historicalWh', multiplier: 1 } };
  await mountSaved(page, [profile]);
  await expect(page.getByTestId('meter-row')).toHaveCount(4);
  expect(await page.locator('[data-meter-kind]').evaluateAll((elements) => elements.map((node) => (node as HTMLSelectElement).value))).toEqual(kinds);
  for (const input of await page.locator('[data-meter-model]').all()) {
    await expect(input).toHaveValue('OLDER-MODEL');
  }
  await page.locator('#saveMeters').click();
  await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [profile] } });
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  await expect.poll(async () => JSON.parse(await page.locator('#meterProfiles').inputValue())).toEqual([profile]);
});

test('same model distinct kinds save one profile and deleting a kind preserves the others', async ({ page }) => {
  await mountUi(page);
  await openMeters(page);
  const expected: Record<string, unknown> = { model: 'ONE-MODEL' };
  for (const kind of kinds) {
    await fillRow(await addRow(page), 'ONE-MODEL', kind, '0.1');
    expected[kind] = { field: fields[kind], multiplier: 0.1 };
  }
  await page.locator('#saveMeters').click();
  await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [expected] } });
  await page.getByTestId('meter-row').nth(1).getByRole('button', { name: '측정 행 삭제' }).click();
  delete expected.voltage;
  await page.locator('#saveMeters').click();
  await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [expected] } });
  while (await page.getByTestId('meter-row').count()) {
    await page.getByTestId('meter-row').first().getByRole('button', { name: '측정 행 삭제' }).click();
  }
  await page.locator('#saveMeters').click();
  await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [] } });
});

for (const invalid of ['model', 'kind', 'factor', 'zero', 'negative', 'duplicate-kind']) {
  test(`invalid ${invalid} configuration is rejected without discarding the calculator row`, async ({ page }) => {
    await mountUi(page);
    await openMeters(page);
    const row = await addRow(page);
    if (invalid !== 'model') {
      await row.locator('[data-meter-model]').fill('MODEL-X');
    }
    if (invalid !== 'kind') {
      await row.locator('[data-meter-kind]').selectOption('power');
    }
    if (invalid !== 'factor') {
      await row.locator('[data-meter-multiplier]').fill(invalid === 'zero' ? '0' : invalid === 'negative' ? '-1' : '1');
    }
    if (invalid === 'duplicate-kind') {
      await fillRow(await addRow(page), 'MODEL-X');
    }
    await page.locator('#saveMeters').click();
    await expect(page.locator('#meterStatus')).toContainText(/확인|입력|중복|배율|행/);
    expect(await requestCalls(page, '/save-features')).toHaveLength(0);
    await expect(page.getByTestId('meter-row')).toHaveCount(invalid === 'duplicate-kind' ? 2 : 1);
  });
}

test('invalid raw JSON and a non-finite multiplier stay unsaved', async ({ page }) => {
  await mountSaved(page, []);
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  for (const raw of ['{broken', '[{"model":"P","power":{"field":"curPower","multiplier":1e400}}]']) {
    await page.locator('#meterProfiles').fill(raw);
    await page.locator('#saveMeters').click();
    await expect(page.locator('#meterStatus')).toContainText(/확인|입력|배율/);
    await expect(page.locator('#meterProfiles')).toHaveValue(raw);
  }
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});

for (const language of ['ko', 'en'] as const) {
  test(`${language} live preview computes unit results without adding preview values to JSON or payload`, async ({ page }) => {
    await mountSaved(page, [], language);
    const row = await addRow(page);
    await row.locator('[data-meter-model]').fill('CALCULATOR');
    for (const [kind, raw, factor, answer] of [
      ['power', '2200', '0.1', '220'], ['voltage', '2200', '0.1', '220'],
      ['current', '1000', '0.001', '1'], ['energy', '1250', '1', '1250'],
    ] as const) {
      await row.locator('[data-meter-kind]').selectOption(kind);
      await row.locator('[data-meter-preview]').fill(raw);
      await row.locator('[data-meter-multiplier]').fill(factor);
      const result = row.locator('output[data-meter-result]');
      await expect(result).toContainText(new RegExp(`${answer}\\s*${units[kind]}`));
      await expect(result.locator('input')).toHaveCount(0);
    }
    await page.locator('#saveMeters').click();
    await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [
      { model: 'CALCULATOR', energy: { field: 'totalWh', multiplier: 1 } },
    ] } });
    await page.getByText(language === 'en' ? 'Expert settings' : '전문가용 원본 설정', { exact: true }).click();
    await expect.poll(async () => JSON.parse(await page.locator('#meterProfiles').inputValue())).toEqual([
      { model: 'CALCULATOR', energy: { field: 'totalWh', multiplier: 1 } },
    ]);
    if (language === 'en') {
      await expect(page.locator('#meterHelpSection')).not.toContainText(/[가-힣]/);
    }
  });
}

test('preview arithmetic handles zero decimal negative and clears blank invalid or overflowing results', async ({ page }) => {
  await mountSaved(page);
  const row = page.getByTestId('meter-row');
  const preview = row.locator('[data-meter-preview]');
  const factor = row.locator('[data-meter-multiplier]');
  const output = row.locator('[data-meter-result]');
  for (const [raw, coefficient, result] of [['0', '0.1', '0'], ['1.5', '0.2', '0.3'], ['-20', '0.5', '-10']]) {
    await preview.fill(raw!); await factor.fill(coefficient!);
    await expect(output).toContainText(new RegExp(`${result}\\s*W`));
  }
  for (const [raw, coefficient] of [['', '1'], ['2', ''], ['2', '0'], ['2', '-1'], ['1e308', '100']]) {
    await preview.fill(raw!); await factor.fill(coefficient!);
    await expect(output).not.toContainText(/\d|NaN|Infinity/);
  }
});

test('preview edits alone do not create a dirty setting or a logout confirmation', async ({ page }) => {
  await mountSaved(page);
  await page.getByTestId('meter-row').locator('[data-meter-preview]').fill('1250');
  await page.getByRole('tab', { name: '연결 설정', exact: true }).click();
  let confirms = 0;
  page.on('dialog', async (dialog) => {
    confirms++; await dialog.dismiss();
  });
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect.poll(() => requestCalls(page, '/logout')).toHaveLength(1);
  expect(confirms).toBe(0);
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});

test('preview survives status updates normal save and unrelated row add or removal', async ({ page }) => {
  await mountSaved(page);
  const original = page.getByTestId('meter-row').first();
  await original.locator('[data-meter-preview]').fill('4321');
  await publishStatus(page);
  await expect(original.locator('[data-meter-preview]')).toHaveValue('4321');
  const extra = await addRow(page);
  await fillRow(extra, 'OTHER', 'current', '0.1');
  await extra.getByRole('button', { name: '측정 행 삭제' }).click();
  await expect(original.locator('[data-meter-preview]')).toHaveValue('4321');
  await page.locator('#saveMeters').click();
  await expect(page.locator('#meterStatus')).toContainText('저장');
  await expect(original.locator('[data-meter-preview]')).toHaveValue('4321');
  await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [base] } });
});

test('preview typed while a normal save waits survives its acknowledgement without becoming a saved field', async ({ page }) => {
  await mountSaved(page);
  const row = page.getByTestId('meter-row');
  await row.locator('[data-meter-preview]').fill('10');
  await row.locator('[data-meter-multiplier]').fill('2');
  await page.evaluate(() => {
    window.__hejHost.holdNext['/save-features'] = 1;
  });
  await page.locator('#saveMeters').click();
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.length)).toBe(1);
  await row.locator('[data-meter-preview]').fill('30');
  await page.evaluate(() => window.__hejHost.pending[0]!.resolve());
  await expect(page.locator('#saveMeters')).toBeEnabled();
  await expect(row.locator('[data-meter-preview]')).toHaveValue('30');
  await expect(row.locator('[data-meter-result]')).toContainText(/60\s*W/);
  await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [{ model: 'BASE', power: { field: 'curPower', multiplier: 2 } }] } });
});

for (const change of ['edit', 'add', 'remove'] as const) {
  test(`pending save preserves a newer calculator configuration ${change}`, async ({ page }) => {
    await mountSaved(page);
    const first = page.getByTestId('meter-row').first();
    await first.locator('[data-meter-multiplier]').fill('2');
    await page.evaluate(() => {
      window.__hejHost.holdNext['/save-features'] = 1;
    });
    await page.locator('#saveMeters').click();
    await expect.poll(() => page.evaluate(() => window.__hejHost.pending.length)).toBe(1);
    if (change === 'edit') {
      await first.locator('[data-meter-multiplier]').fill('3');
    }
    if (change === 'add') {
      await fillRow(await addRow(page), 'NEW', 'voltage', '0.1');
    }
    if (change === 'remove') {
      await first.getByRole('button', { name: '측정 행 삭제' }).click();
    }
    await page.evaluate(() => window.__hejHost.pending[0]!.resolve());
    await expect(page.locator('#saveMeters')).toBeEnabled();
    await expect(page.getByTestId('meter-row')).toHaveCount(change === 'add' ? 2 : change === 'remove' ? 0 : 1);
    await page.locator('#saveMeters').click();
    const meters = change === 'remove' ? [] : change === 'edit' ? [{ ...base, power: { ...base.power, multiplier: 3 } }]
      : [{ ...base, power: { ...base.power, multiplier: 2 } }, { model: 'NEW', voltage: { field: 'curVoltage', multiplier: 0.1 } }];
    await expect.poll(() => savedMeters(page)).toEqual({ features: { meters } });
  });
}

test('raw edits lock table configuration and applying raw replaces only the requested profiles', async ({ page }) => {
  await mountSaved(page);
  await page.getByTestId('meter-row').locator('[data-meter-preview]').fill('111');
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  const raw = [{ model: 'OTHER', current: { field: 'customAmps', multiplier: 0.01 } }];
  await page.locator('#meterProfiles').fill(JSON.stringify(raw));
  await expect(page.getByTestId('meter-row').locator('[data-meter-model]')).toBeDisabled();
  await page.getByRole('button', { name: '원본을 표에 적용', exact: true }).click();
  const row = page.getByTestId('meter-row');
  await expect(row.locator('[data-meter-model]')).toHaveValue('OTHER');
  await expect(row.locator('[data-meter-kind]')).toHaveValue('current');
  await expect(row.locator('[data-meter-preview]')).toHaveValue('');
  await row.locator('[data-meter-multiplier]').fill('0.02');
  await page.locator('#saveMeters').click();
  await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [{ model: 'OTHER', current: { field: 'customAmps', multiplier: 0.02 } }] } });
});

test('raw-to-add preserves stored kinds and invalid raw-to-add leaves the draft for correction', async ({ page }) => {
  await mountSaved(page, []);
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  const raw = [{ model: 'RAW', voltage: { field: 'voltageCustom', multiplier: 0.1 } }];
  await page.locator('#meterProfiles').fill(JSON.stringify(raw));
  await fillRow(await addRow(page), 'RAW', 'power', '1');
  await expect(page.getByTestId('meter-row')).toHaveCount(2);
  await page.locator('#saveMeters').click();
  await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [{ ...raw[0], power: { field: 'curPower', multiplier: 1 } }] } });
  await page.locator('#meterProfiles').fill('{broken');
  await page.locator('#addMeter').click();
  await expect(page.locator('#meterStatus')).toContainText(/확인|형식/);
  await expect(page.locator('#meterProfiles')).toHaveValue('{broken');
});

test('an open expert JSON view follows model kind factor and row removal without including preview', async ({ page }) => {
  await mountSaved(page, []);
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  const row = await addRow(page);
  await fillRow(row, 'SYNC', 'energy', '0.5');
  await row.locator('[data-meter-preview]').fill('900');
  await expect.poll(async () => JSON.parse(await page.locator('#meterProfiles').inputValue())).toEqual([
    { model: 'SYNC', energy: { field: 'totalWh', multiplier: 0.5 } },
  ]);
  await row.getByRole('button', { name: '측정 행 삭제' }).click();
  await expect.poll(async () => JSON.parse(await page.locator('#meterProfiles').inputValue())).toEqual([]);
});

const renderCases = (['ko', 'en'] as const).flatMap((language) => (['light', 'dark'] as const)
  .flatMap((theme) => [375, 1200].map((width) => ({ language, theme, width }))));
for (const { language, theme, width } of renderCases) {
  test(`${language} ${theme} ${width}px calculator stays nowrap and scrolls natively while preserving focus`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mountUi(page, { language, theme, devices: modelDevices });
    await openMeters(page, language);
    const row = await addRow(page);
    await fillRow(row, 'PREVIEW-MODEL', 'energy', '0.1');
    const wrapper = page.getByTestId('meter-table-scroll');
    await expect(page.locator('#meterScrollRange,[data-meter-field]')).toHaveCount(0);
    await wrapper.focus();
    await page.keyboard.press('ArrowRight');
    const geometry = await settledScrollGeometry(wrapper);
    if (width === 375) {
      expect(geometry.contentWidth).toBeGreaterThan(geometry.width);
    }
    if (geometry.contentWidth > geometry.width) {
      expect(geometry.left).toBeGreaterThan(0);
    }
    const kindBox = await row.locator('[data-meter-kind]').boundingBox();
    expect(kindBox!.height).toBeGreaterThanOrEqual(44);
    const preview = row.locator('[data-meter-preview]');
    await preview.focus(); await page.keyboard.type('1250');
    const before = await settledScrollGeometry(wrapper);
    await publishStatus(page);
    await expect(preview).toBeFocused(); await expect(preview).toHaveValue('1250');
    expect(await settledScrollGeometry(wrapper)).toEqual(before);
    await expect(row.locator('[data-meter-result]')).toContainText(/125\s*Wh/);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const wrappedText = await page.getByTestId('meter-table').locator('th,td,label,button,output').evaluateAll((elements) =>
      elements.filter((element) => getComputedStyle(element).whiteSpace !== 'nowrap').map((element) => element.textContent?.trim()));
    expect(wrappedText).toEqual([]);
    const directory = path.resolve('.superpowers/sdd/2026-10-01-meter-calculator/screenshots'); fs.mkdirSync(directory, { recursive: true });
    await wrapper.evaluate((node) => {
      node.scrollLeft = node.scrollWidth - node.clientWidth;
    });
    await settledScrollGeometry(wrapper);
    await wrapper.screenshot({ path: path.join(directory, `${language}-${theme}-${width}-far-right.png`) });
    await wrapper.evaluate((node) => {
      node.scrollLeft = 0;
    });
    await settledScrollGeometry(wrapper);
    await wrapper.screenshot({ path: path.join(directory, `${language}-${theme}-${width}-left.png`) });
    await page.locator('#meterHelpSection').screenshot({ path: path.join(directory, `${language}-${theme}-${width}-section.png`) });
  });
}

for (const language of ['ko', 'en'] as const) {
  test(`${language} icon add and remove actions remain keyboard accessible 44px targets with expert spacing`, async ({ page }) => {
    await mountSaved(page, [], language);
    const addName = language === 'en' ? 'Add measurement row' : '측정 행 추가';
    const removeName = language === 'en' ? 'Remove measurement row' : '측정 행 삭제';
    const add = page.getByRole('button', { name: addName, exact: true });
    await expect(add).toHaveAttribute('title', addName); await expect(add).toHaveText('');
    const box = await add.boundingBox(); expect(box!.height).toBeGreaterThanOrEqual(44); expect(box!.width).toBeGreaterThanOrEqual(44);
    await add.focus(); await page.keyboard.press('Enter');
    const remove = page.getByTestId('meter-row').getByRole('button', { name: removeName, exact: true });
    await expect(remove).toHaveAttribute('title', removeName); await expect(remove).toHaveText('');
    const removeBox = await remove.boundingBox(); expect(removeBox!.height).toBeGreaterThanOrEqual(44); expect(removeBox!.width).toBeGreaterThanOrEqual(44);
    await remove.focus(); await page.keyboard.press('Space'); await expect(page.getByTestId('meter-row')).toHaveCount(0);
    const expertSpacing = await page.locator('#meterDetails > details').evaluate((expert) => ({
      margin: getComputedStyle(expert).marginTop,
      gap: expert.getBoundingClientRect().top - expert.previousElementSibling!.getBoundingClientRect().bottom,
    }));
    expect(expertSpacing.margin).toBe('16px');
    expect(expertSpacing.gap).toBe(16);
  });
}

test('changing the measurement kind intentionally replaces its custom source key with the new default', async ({ page }) => {
  await mountSaved(page, [{ model: 'CUSTOM', power: { field: 'vendorWatts', multiplier: 1 } }]);
  const row = page.getByTestId('meter-row');
  await row.locator('[data-meter-kind]').selectOption('voltage');
  await row.locator('[data-meter-multiplier]').fill('0.1');
  await page.locator('#saveMeters').click();
  await expect.poll(() => savedMeters(page)).toEqual({ features: { meters: [
    { model: 'CUSTOM', voltage: { field: 'curVoltage', multiplier: 0.1 } },
  ] } });
});

test('raw save of the same model and kind preserves the preview but never serializes it', async ({ page }) => {
  await mountSaved(page);
  await page.getByTestId('meter-row').locator('[data-meter-preview]').fill('25');
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  const profile = { model: 'BASE', power: { field: 'curPower', multiplier: 2 } };
  await page.locator('#meterProfiles').fill(JSON.stringify([profile]));
  await page.evaluate(() => {
    window.__hejHost.holdNext['/save-features'] = 1;
  });
  await page.locator('#saveMeters').click();
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.length)).toBe(1);
  await page.evaluate(() => window.__hejHost.pending[0]!.resolve());
  await expect(page.locator('#saveMeters')).toBeEnabled();
  await expect(page.getByTestId('meter-row').locator('[data-meter-preview]')).toHaveValue('25');
  await expect(page.getByTestId('meter-row').locator('[data-meter-result]')).toContainText(/50\s*W/);
  await expect.poll(async () => JSON.parse(await page.locator('#meterProfiles').inputValue())).toEqual([profile]);
});

test('a missing factor error identifies the second measurement row and its kind', async ({ page }) => {
  await mountSaved(page);
  const second = await addRow(page);
  await second.locator('[data-meter-model]').fill('SECOND');
  await second.locator('[data-meter-kind]').selectOption('current');
  await page.locator('#saveMeters').click();
  await expect(page.locator('#meterStatus')).toContainText('2');
  await expect(page.locator('#meterStatus')).toContainText(/전류|Current/);
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});

test('the empty calculator scrolls natively before adding editable rows', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await mountSaved(page, []);
  await expect(page.getByTestId('meter-row')).toHaveCount(0);
  await expect(page.locator('#meterScrollRange,input[type=range]')).toHaveCount(0);
  const wrapper = page.getByTestId('meter-table-scroll');
  await wrapper.focus(); await page.keyboard.press('ArrowRight');
  await expect.poll(() => wrapper.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('preview-only account changes isolate old meter rows immediately and reject late account responses', async ({ page }) => {
  await installUiHost(page, { status: { features: {
    meters: [{ model: 'ACCOUNT-A', power: { field: 'curPower', multiplier: 1 } }],
  } } });
  // The first diagnostics can arrive after the saved settings and a preview edit.
  await page.evaluate(() => {
    window.__hejHost.holdNext['/diagnostics'] = 2;
  });
  await page.setContent(fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8'));
  await openMeters(page);
  await page.getByTestId('meter-row').locator('[data-meter-preview]').fill('777');
  const oldDiagnostics = await page.evaluate(() => structuredClone(window.__hejHost.diagnostics));
  const initialStatusRequests = (await requestCalls(page, '/session-status')).length;
  let dialogs = 0;
  page.on('dialog', async (dialog) => {
    dialogs++;
    await dialog.dismiss();
  });
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.length)).toBe(2);
  await page.evaluate(() => {
    const host = window.__hejHost;
    host.status.uiSessionRevision = 'account-B';
    host.status.features = { meters: [{ model: 'ACCOUNT-B', current: { field: 'curCurrent', multiplier: 0.001 } }] };
    host.diagnostics = { ...host.diagnostics, uiSessionRevision: 'account-B', devices: [] };
    host.holdNext['/session-status'] = 1;
    // Two startup refreshes exist; resolve only the newer request as the first observed account.
    host.pending[1]!.resolve(structuredClone(host.diagnostics));
  });
  await expect(page.getByTestId('meter-row')).toHaveCount(0);
  await expect(page.locator('#meterProfiles')).not.toHaveValue(/ACCOUNT-A/);
  await expect(page.locator('#accountChangeAction')).toHaveCount(0);
  await expect.poll(async () => (await requestCalls(page, '/session-status')).length).toBe(initialStatusRequests + 1);
  const devicesTab = page.getByRole('tab', { name: '내 장치', exact: true });
  await devicesTab.focus();
  await page.keyboard.press('End');
  await expect(devicesTab).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#panel-connections')).toBeHidden();
  await expect(page.locator('#panel-help')).toBeHidden();
  const statusB = await page.evaluate(() => structuredClone(window.__hejHost.status));
  // A second account switch while B's settings are pending exercises the same late-status boundary.
  // Reusing A's exact model/kind also ensures its preview cannot leak through render-time matching.
  await page.evaluate(() => {
    const host = window.__hejHost;
    host.status.uiSessionRevision = 'account-C';
    host.status.features = { meters: [{ model: 'ACCOUNT-A', power: { field: 'customC', multiplier: 2 } }] };
    host.diagnostics = { ...host.diagnostics, uiSessionRevision: 'account-C' };
  });
  await publishStatus(page);
  await expect.poll(async () => (await requestCalls(page, '/session-status')).length).toBe(initialStatusRequests + 2);
  const row = page.getByTestId('meter-row');
  await expect(row.locator('[data-meter-model]')).toHaveValue('ACCOUNT-A');
  await expect(row.locator('[data-meter-multiplier]')).toHaveValue('2');
  await expect(row.locator('[data-meter-preview]')).toHaveValue('');
  await page.evaluate(({ oldDiagnostics, statusB }) => {
    window.__hejHost.pending.find((pending) => pending.route === '/diagnostics')!.resolve(oldDiagnostics);
    window.__hejHost.pending.find((pending) => pending.route === '/session-status')!.resolve(statusB);
  }, { oldDiagnostics, statusB });
  await page.getByRole('tab', { name: '도움말', exact: true }).click();
  await expect(row.locator('[data-meter-model]')).toHaveValue('ACCOUNT-A');
  await expect(row.locator('[data-meter-multiplier]')).toHaveValue('2');
  await expect(row.locator('[data-meter-preview]')).toHaveValue('');
  await expect.poll(async () => JSON.parse(await page.locator('#meterProfiles').inputValue())).toEqual([
    { model: 'ACCOUNT-A', power: { field: 'customC', multiplier: 2 } },
  ]);
  expect(dialogs).toBe(0);
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});

test('an actual meter settings draft still requires confirmation before changing accounts', async ({ page }) => {
  await mountSaved(page, [{ model: 'ACCOUNT-A', power: { field: 'curPower', multiplier: 1 } }]);
  await page.getByTestId('meter-row').locator('[data-meter-multiplier]').fill('3');
  await page.getByTestId('meter-row').locator('[data-meter-preview]').fill('777');
  const initialStatusRequests = (await requestCalls(page, '/session-status')).length;
  await page.evaluate(() => {
    const host = window.__hejHost;
    host.status.uiSessionRevision = 'account-B';
    host.status.features = { meters: [{ model: 'ACCOUNT-B', voltage: { field: 'curVoltage', multiplier: 0.1 } }] };
    host.diagnostics = { ...host.diagnostics, uiSessionRevision: 'account-B', devices: [] };
  });
  await publishStatus(page);
  const review = page.locator('#accountChangeAction');
  await expect(review).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await review.click();
  await expect(review).toBeVisible();
  await expect(page.getByTestId('meter-row').locator('[data-meter-model]')).toHaveValue('ACCOUNT-A');
  await expect(page.getByTestId('meter-row').locator('[data-meter-multiplier]')).toHaveValue('3');
  expect((await requestCalls(page, '/session-status')).length).toBe(initialStatusRequests);
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
  page.once('dialog', (dialog) => dialog.accept());
  await review.click();
  await expect(review).toHaveCount(0);
  await expect(page.getByTestId('meter-row').locator('[data-meter-model]')).toHaveValue('ACCOUNT-B');
  await expect(page.getByTestId('meter-row').locator('[data-meter-multiplier]')).toHaveValue('0.1');
  await expect(page.getByTestId('meter-row').locator('[data-meter-preview]')).toHaveValue('');
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});

test('signing out and into another account never renders the previous calculator preview before diagnostics arrive', async ({ page }) => {
  await mountSaved(page, [{ model: 'SHARED-MODEL', power: { field: 'curPower', multiplier: 1 } }]);
  await page.getByTestId('meter-row').locator('[data-meter-preview]').fill('777');
  await page.getByRole('tab', { name: '연결 설정', exact: true }).click();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByLabel('이메일')).toBeVisible();
  await page.evaluate(() => {
    window.__hejHost.status.features = {
      meters: [{ model: 'SHARED-MODEL', power: { field: 'otherAccountWatts', multiplier: 2 } }],
    };
    window.__hejHost.holdNext['/diagnostics'] = 2;
  });
  await page.getByLabel('이메일').fill('other-account@example.test');
  await page.getByRole('button', { name: '인증번호 전송', exact: true }).click();
  await page.getByLabel('6자리 인증번호 입력').fill('123456');
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await page.getByLabel('비밀번호').fill('fixture-only-password');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.locator('#loginView')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.filter((entry) => entry.route === '/diagnostics').length))
    .toBeGreaterThan(0);
  await page.getByRole('tab', { name: '도움말', exact: true }).click();
  const row = page.getByTestId('meter-row');
  await expect(row.locator('[data-meter-model]')).toHaveValue('SHARED-MODEL');
  await expect(row.locator('[data-meter-multiplier]')).toHaveValue('2');
  await expect(row.locator('[data-meter-preview]')).toHaveValue('');
  await expect(row.locator('[data-meter-result]')).not.toContainText('1554');
  await expect.poll(async () => JSON.parse(await page.locator('#meterProfiles').inputValue())).toEqual([
    { model: 'SHARED-MODEL', power: { field: 'otherAccountWatts', multiplier: 2 } },
  ]);
  expect(await requestCalls(page, '/logout')).toHaveLength(1);
  expect(await requestCalls(page, '/login')).toHaveLength(1);
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});
