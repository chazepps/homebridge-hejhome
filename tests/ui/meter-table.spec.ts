import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { mountUi, publishStatus, requestCalls, type UiDevice } from './host-fixture.js';

// Model names are synthetic UI fixtures, not claims about the user's registered hardware.
const modelDevices: UiDevice[] = [
  { id: 'fixture-plug-1', name: 'First plug', deviceType: 'Plug', modelName: 'SYNTHETIC-METER-01', meterProfileApplied: false },
  { id: 'fixture-plug-2', name: 'Second plug', deviceType: 'Plug', modelName: 'SYNTHETIC-METER-01', meterProfileApplied: false },
  { id: 'fixture-relay', name: 'Rack relay', deviceType: 'RelayController', modelName: 'SYNTHETIC-RELAY-02', meterProfileApplied: false },
  { id: 'fixture-unknown', name: 'No model', deviceType: 'Plug', modelName: null, meterProfileApplied: false },
];
const units = ['power', 'voltage', 'current', 'energy'] as const;
async function openMeters(page: Page, language: 'ko' | 'en' = 'ko') {
  await page.getByRole('tab', { name: language === 'en' ? 'Help' : '도움말', exact: true }).click();
  await page.getByText(language === 'en' ? 'Advanced: power meter models' : '고급: 전력 측정 모델 설정', { exact: true }).click();
}
async function addRow(page: Page) {
  await page.locator('#addMeter').click();
  return page.getByTestId('meter-row').last();
}
async function fillPower(row: Locator, model: string, multiplier = '0.1') {
  await row.locator('[data-meter-model]').fill(model);
  await row.locator('[data-meter-field="power"]').fill('curPower');
  await row.locator('[data-meter-multiplier="power"]').fill(multiplier);
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

for (const language of ['ko', 'en'] as const) {
  test(`${language} static first reference row explains all units but is never saved`, async ({ page }) => {
    await mountUi(page, { language, devices: modelDevices });
    await openMeters(page, language);
    const table = page.getByTestId('meter-table');
    const example = page.getByTestId('meter-example-row');
    await expect(table).toBeVisible();
    await expect(example).toHaveCount(1);
    expect(await table.locator('tbody tr').first().getAttribute('data-testid')).toBe('meter-example-row');
    await expect(example.locator('input, select, button, textarea')).toHaveCount(0);
    await expect(example).toHaveCSS('font-style', 'italic');
    for (const text of ['curPower', 'curVoltage', 'curCurrent', 'totalWh', '0.1', '0.001', '2200', '220', '1000', '1250', '1.25', 'kWh']) {
      await expect(example).toContainText(text);
    }
    for (const unit of ['W', 'V', 'A', 'Wh']) {
      await expect(table).toContainText(unit);
    }
    await expect(example).toContainText(language === 'en' ? /reference|example/i : /참고|예시/);
    await expect(example).toContainText(language === 'en' ? /fictional|illustrative/i : /가상/);
    await page.locator('#saveMeters').click();
    await expect.poll(async () => (await requestCalls(page, '/save-features')).at(-1)?.payload).toEqual({ features: { meters: [] } });
  });
}

test('new rows stay empty with unit-labelled placeholders and selecting a unique observed model saves its exact name', async ({ page }) => {
  await mountUi(page, { devices: modelDevices });
  await openMeters(page);
  const row = await addRow(page);
  for (const input of await row.locator('input').all()) {
    await expect(input).toHaveValue('');
    await expect(input).toHaveAttribute('placeholder', /.+/);
  }
  const picker = row.getByLabel('모델 선택', { exact: true });
  await expect(picker.locator('option[value="SYNTHETIC-METER-01"]')).toHaveCount(1);
  await expect(picker.locator('option[value="SYNTHETIC-RELAY-02"]')).toHaveCount(1);
  await expect(picker).not.toContainText('No model');
  await picker.selectOption('SYNTHETIC-METER-01');
  await expect(row.locator('[data-meter-model]')).toHaveValue('SYNTHETIC-METER-01');
  await row.locator('[data-meter-field="power"]').fill('curPower');
  await row.locator('[data-meter-multiplier="power"]').fill('0.1');
  await page.locator('#saveMeters').click();
  await expect.poll(async () => (await requestCalls(page, '/save-features')).at(-1)?.payload).toEqual({ features: { meters: [
    { model: 'SYNTHETIC-METER-01', power: { field: 'curPower', multiplier: 0.1 } },
  ] } });
});

test('manual and previously saved unknown models remain editable without fabricating discovered models', async ({ page }) => {
  await mountUi(page, { devices: modelDevices, status: { features: { matter: false, adaptiveLighting: false,
    meters: [{ model: 'OLDER-MODEL', power: { field: 'wattsRaw', multiplier: 1 } }] } } });
  await openMeters(page);
  await expect(page.getByTestId('meter-row').first().locator('[data-meter-model]')).toHaveValue('OLDER-MODEL');
  const row = await addRow(page);
  await fillPower(row, 'MY-MANUAL-MODEL', '1');
  await page.locator('#saveMeters').click();
  await expect.poll(async () => (await requestCalls(page, '/save-features')).at(-1)?.payload).toEqual({ features: { meters: [
    { model: 'OLDER-MODEL', power: { field: 'wattsRaw', multiplier: 1 } },
    { model: 'MY-MANUAL-MODEL', power: { field: 'curPower', multiplier: 1 } },
  ] } });
});

for (const invalid of ['blank-model', 'no-fields', 'half-pair', 'half-multiplier', 'zero', 'negative', 'duplicate']) {
  test(`rejects ${invalid} meter profiles without sending or discarding the draft`, async ({ page }) => {
    await mountUi(page, { devices: modelDevices });
    await openMeters(page);
    const row = await addRow(page);
    if (invalid !== 'blank-model') {
      await row.locator('[data-meter-model]').fill('MODEL-X');
    }
    if (invalid !== 'no-fields') {
      if (invalid !== 'half-multiplier') {
        await row.locator('[data-meter-field="power"]').fill('curPower');
      }
      if (invalid !== 'half-pair') {
        await row.locator('[data-meter-multiplier="power"]').fill(invalid === 'zero' ? '0' : invalid === 'negative' ? '-1' : '1');
      }
    }
    if (invalid === 'duplicate') {
      await fillPower(await addRow(page), 'MODEL-X', '1');
    }
    await page.locator('#saveMeters').click();
    await expect(page.locator('#meterStatus')).toContainText(/확인|입력|같|중복|0보다|설정/);
    expect(await requestCalls(page, '/save-features')).toHaveLength(0);
    await expect(page.getByTestId('meter-row').first().locator('[data-meter-model]')).toHaveValue(invalid === 'blank-model' ? '' : 'MODEL-X');
  });
}

test('raw malformed JSON and non-finite factors cannot be saved', async ({ page }) => {
  await mountUi(page);
  await openMeters(page);
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  for (const raw of ['{invalid', '[{"model":"P1","power":{"field":"curPower","multiplier":1e400}}]']) {
    await page.locator('#meterProfiles').fill(raw);
    await page.locator('#saveMeters').click();
    await expect(page.locator('#meterStatus')).toContainText(/확인|입력|숫자/);
    await expect(page.locator('#meterProfiles')).toHaveValue(raw);
  }
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});

for (const [language, theme, width] of [['ko', 'light', 375], ['en', 'dark', 375], ['ko', 'dark', 1200], ['en', 'light', 1200]] as const) {
  test(`${language} ${theme} ${width}px meter table scrolls internally and keeps keyboard edits through status updates`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mountUi(page, { language, theme, devices: modelDevices });
    await openMeters(page, language);
    await page.locator('#addMeter').click();
    const row = page.getByTestId('meter-row').last();
    const model = row.locator('[data-meter-model]');
    await model.fill('DRAFT-MODEL');
    const wrapper = page.getByTestId('meter-table-scroll');
    await wrapper.focus();
    await page.keyboard.press('ArrowRight');
    await expect.poll(() => wrapper.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
    const scrollbar = page.getByLabel(language === 'en' ? 'Scroll table horizontally' : '표 가로 이동', { exact: true });
    await expect(scrollbar).toBeVisible();
    expect(await scrollbar.getAttribute('type')).toBe('range');
    await scrollbar.focus();
    await page.keyboard.press('End');
    await expect.poll(() => wrapper.evaluate((node) => Math.abs(node.scrollLeft - (node.scrollWidth - node.clientWidth)))).toBeLessThan(2);
    await wrapper.evaluate((node) => {
      node.scrollLeft = 10;
    });
    await expect.poll(async () => Math.abs(Number(await scrollbar.inputValue()) - await wrapper.evaluate((node) => node.scrollLeft)))
      .toBeLessThan(2);
    const energy = row.locator('[data-meter-field="energy"]');
    await energy.focus();
    await page.keyboard.type('totalWh');
    // Arrow-key and focus scrolling can finish after typing; compare settled layouts, not an in-flight animation frame.
    const before = await settledScrollGeometry(wrapper);
    await publishStatus(page);
    await expect(energy).toBeFocused();
    await expect(energy).toHaveValue('totalWh');
    await expect(model).toHaveValue('DRAFT-MODEL');
    expect(await settledScrollGeometry(wrapper)).toEqual(before);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    const box = await wrapper.boundingBox();
    expect(box!.width).toBeLessThanOrEqual(width);
    for (const kind of units) {
      const field = row.locator(`[data-meter-field="${kind}"]`);
      await expect(field).toHaveAccessibleName(/.+/);
      await expect(row.locator(`[data-meter-multiplier="${kind}"]`)).toHaveAccessibleName(/.+/);
    }
    const directory = path.resolve('.superpowers/sdd/2026-10-01-meter-table/screenshots');
    fs.mkdirSync(directory, { recursive: true });
    await wrapper.screenshot({ path: path.join(directory, `${language}-${theme}-${width}-table-right.png`) });
    await scrollbar.focus();
    await page.keyboard.press('Home');
    await expect.poll(() => wrapper.evaluate((node) => node.scrollLeft)).toBe(0);
    await wrapper.screenshot({ path: path.join(directory, `${language}-${theme}-${width}-table-left.png`) });
    if (language === 'ko') {
      await page.locator('#meterHelpSection').screenshot({ path: path.join(directory, `${language}-${theme}-${width}-section.png`) });
    }
  });
}


test('four measurement columns save only their model, source field and SI multiplier', async ({ page }) => {
  await mountUi(page, { devices: modelDevices });
  await openMeters(page);
  const row = await addRow(page);
  await row.locator('[data-meter-model]').fill('MANUAL-FOUR-CHANNEL');
  const values = { power: { field: 'curPower', multiplier: 0.1 }, voltage: { field: 'curVoltage', multiplier: 0.1 },
    current: { field: 'curCurrent', multiplier: 0.001 }, energy: { field: 'totalWh', multiplier: 1 } };
  for (const [kind, value] of Object.entries(values)) {
    await row.locator(`[data-meter-field="${kind}"]`).fill(value.field);
    await row.locator(`[data-meter-multiplier="${kind}"]`).fill(String(value.multiplier));
  }
  await page.locator('#saveMeters').click();
  await expect.poll(async () => (await requestCalls(page, '/save-features')).at(-1)?.payload).toEqual({ features: {
    meters: [{ model: 'MANUAL-FOUR-CHANNEL', ...values }],
  } });
  expect(await page.evaluate(() => window.__hejHost.diagnostics.devices.every((device) => device.meterProfileApplied === false))).toBe(true);
});

test('adding a table row after raw JSON editing retains the raw profiles before adding a blank row', async ({ page }) => {
  await mountUi(page);
  await openMeters(page);
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  const raw = [{ model: 'RAW-PROFILE', current: { field: 'curCurrent', multiplier: 0.001 } }];
  await page.locator('#meterProfiles').fill(JSON.stringify(raw));
  const added = await addRow(page);
  await expect(page.getByTestId('meter-row')).toHaveCount(2);
  await expect(page.getByTestId('meter-row').first().locator('[data-meter-model]')).toHaveValue('RAW-PROFILE');
  await expect(page.getByTestId('meter-row').first().locator('[data-meter-field="current"]')).toHaveValue('curCurrent');
  await fillPower(added, 'ADDED-MODEL', '0.1');
  await page.locator('#saveMeters').click();
  await expect.poll(async () => (await requestCalls(page, '/save-features')).at(-1)?.payload).toEqual({ features: { meters: [
    ...raw, { model: 'ADDED-MODEL', power: { field: 'curPower', multiplier: 0.1 } },
  ] } });
});

test('adding a row from invalid raw JSON shows an error and does not lose the raw draft', async ({ page }) => {
  await mountUi(page);
  await openMeters(page);
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  await page.locator('#meterProfiles').fill('{broken-json');
  await page.locator('#addMeter').click();
  await expect(page.locator('#meterStatus')).toContainText(/확인|JSON|설정/);
  await expect(page.locator('#meterProfiles')).toHaveValue('{broken-json');
  await expect(page.getByTestId('meter-row')).toHaveCount(0);
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});

test('editing a selected model manually resets the picker to manual entry', async ({ page }) => {
  await mountUi(page, { devices: modelDevices });
  await openMeters(page);
  const row = await addRow(page);
  const picker = row.getByLabel('모델 선택', { exact: true });
  await picker.selectOption('SYNTHETIC-METER-01');
  await row.locator('[data-meter-model]').fill('MANUALLY-CHANGED-MODEL');
  await expect(picker).toHaveValue('');
  await expect(picker.locator('option:checked')).toContainText(/직접|수동/);
  await row.locator('[data-meter-field="power"]').fill('curPower');
  await row.locator('[data-meter-multiplier="power"]').fill('0.1');
  await page.locator('#saveMeters').click();
  await expect.poll(async () => (await requestCalls(page, '/save-features')).at(-1)?.payload).toEqual({ features: { meters: [
    { model: 'MANUALLY-CHANGED-MODEL', power: { field: 'curPower', multiplier: 0.1 } },
  ] } });
});

test('opening an empty meter table enables its scrollbar before any row is added', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await mountUi(page);
  await openMeters(page);
  await expect(page.getByTestId('meter-row')).toHaveCount(0);
  const scrollbar = page.getByLabel('표 가로 이동', { exact: true });
  await expect(scrollbar).toBeEnabled();
  await expect.poll(async () => Number(await scrollbar.getAttribute('max'))).toBeGreaterThan(0);
  await scrollbar.focus();
  await page.keyboard.press('End');
  const wrapper = page.getByTestId('meter-table-scroll');
  await expect.poll(() => wrapper.evaluate((node) => node.scrollLeft)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});


for (const change of ['edit', 'add', 'remove'] as const) {
  test(`a pending save cannot overwrite newer table ${change} changes`, async ({ page }) => {
    const saved = [{ model: 'BASE', power: { field: 'curPower', multiplier: 1 } }];
    await mountUi(page, { status: { features: { matter: false, adaptiveLighting: false, meters: saved } } });
    await openMeters(page);
    const first = page.getByTestId('meter-row').first();
    await first.locator('[data-meter-multiplier="power"]').fill('2');
    await page.evaluate(() => {
      window.__hejHost.holdNext['/save-features'] = 1;
    });
    await page.locator('#saveMeters').click();
    await expect.poll(() => page.evaluate(() => window.__hejHost.pending.length)).toBe(1);
    if (change === 'edit') {
      await first.locator('[data-meter-multiplier="power"]').fill('3');
    }
    if (change === 'add') {
      await fillPower(await addRow(page), 'NEW-DRAFT', '0.1');
    }
    if (change === 'remove') {
      await first.getByRole('button', { name: '이 모델 삭제' }).click();
    }
    await page.evaluate(() => window.__hejHost.pending[0]!.resolve());
    await expect(page.locator('#saveMeters')).toBeEnabled();
    await expect(page.getByTestId('meter-row')).toHaveCount(change === 'add' ? 2 : change === 'remove' ? 0 : 1);
    if (change === 'edit') {
      await expect(first.locator('[data-meter-multiplier="power"]')).toHaveValue('3');
    }
    if (change === 'add') {
      await expect(page.getByTestId('meter-row').last().locator('[data-meter-model]')).toHaveValue('NEW-DRAFT');
    }
    await page.locator('#saveMeters').click();
    const expected = change === 'remove' ? [] : change === 'edit'
      ? [{ model: 'BASE', power: { field: 'curPower', multiplier: 3 } }]
      : [{ model: 'BASE', power: { field: 'curPower', multiplier: 2 } }, { model: 'NEW-DRAFT', power: { field: 'curPower', multiplier: 0.1 } }];
    await expect.poll(async () => (await requestCalls(page, '/save-features')).at(-1)?.payload).toEqual({ features: { meters: expected } });
  });
}

test('validation explains which row and measurement need correction', async ({ page }) => {
  await mountUi(page);
  await openMeters(page);
  await fillPower(await addRow(page), 'VALID', '1');
  const second = await addRow(page);
  await second.locator('[data-meter-model]').fill('BROKEN');
  await second.locator('[data-meter-field="current"]').fill('curCurrent');
  await page.locator('#saveMeters').click();
  await expect(page.locator('#meterStatus')).toContainText(/2/);
  await expect(page.locator('#meterStatus')).toContainText(/전류|current/);
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});

test('editing raw JSON locks stale table inputs until explicit validated application', async ({ page }) => {
  await mountUi(page, { status: { features: { matter: false, adaptiveLighting: false,
    meters: [{ model: 'OLD-TABLE', power: { field: 'curPower', multiplier: 1 } }] } } });
  await openMeters(page);
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  const raw = [{ model: 'NEW-RAW', voltage: { field: 'curVoltage', multiplier: 0.1 } }];
  await page.locator('#meterProfiles').fill(JSON.stringify(raw));
  await expect(page.getByTestId('meter-row').first().locator('[data-meter-model]')).toBeDisabled();
  await page.getByRole('button', { name: '원본을 표에 적용', exact: true }).click();
  const row = page.getByTestId('meter-row').first();
  await expect(row.locator('[data-meter-model]')).toBeEnabled();
  await expect(row.locator('[data-meter-model]')).toHaveValue('NEW-RAW');
  await expect(row.locator('[data-meter-field="voltage"]')).toHaveValue('curVoltage');
  await row.locator('[data-meter-multiplier="voltage"]').fill('0.2');
  await page.locator('#saveMeters').click();
  await expect.poll(async () => (await requestCalls(page, '/save-features')).at(-1)?.payload).toEqual({ features: { meters: [
    { model: 'NEW-RAW', voltage: { field: 'curVoltage', multiplier: 0.2 } },
  ] } });
});

test('opening raw editing preserves the latest table draft instead of showing an older saved model', async ({ page }) => {
  await mountUi(page, { status: { features: { matter: false, adaptiveLighting: false,
    meters: [{ model: 'SAVED', power: { field: 'curPower', multiplier: 1 } }] } } });
  await openMeters(page);
  const row = page.getByTestId('meter-row').first();
  await row.locator('[data-meter-model]').fill('TABLE-DRAFT');
  await row.locator('[data-meter-multiplier="power"]').fill('2');
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  await expect.poll(async () => JSON.parse(await page.locator('#meterProfiles').inputValue())).toEqual([
    { model: 'TABLE-DRAFT', power: { field: 'curPower', multiplier: 2 } },
  ]);
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});

test('an already-open raw editor follows table add, model selection and row removal', async ({ page }) => {
  await mountUi(page, { devices: modelDevices });
  await openMeters(page);
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  const row = await addRow(page);
  await expect.poll(async () => JSON.parse(await page.locator('#meterProfiles').inputValue())).toEqual([{ model: '' }]);
  await row.getByLabel('모델 선택', { exact: true }).selectOption('SYNTHETIC-METER-01');
  await expect.poll(async () => JSON.parse(await page.locator('#meterProfiles').inputValue())).toEqual([{ model: 'SYNTHETIC-METER-01' }]);
  await row.getByRole('button', { name: '이 모델 삭제', exact: true }).click();
  await expect.poll(async () => JSON.parse(await page.locator('#meterProfiles').inputValue())).toEqual([]);
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});

test('English meter guidance contains no untranslated Korean text', async ({ page }) => {
  await mountUi(page, { language: 'en' });
  await openMeters(page, 'en');
  await expect(page.locator('#meterHelpSection')).not.toContainText(/[가-힣]/);
});
