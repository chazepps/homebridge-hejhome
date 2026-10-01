import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { installUiHost, mountUi, publishStatus, requestCalls, type UiDevice } from './host-fixture.js';

const source = () => fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');
const devices: UiDevice[] = [
  { id: 'plug-1', name: 'Study lamp', deviceType: 'Plug', modelName: 'GKW-PLG03' },
  { id: 'plug-2', name: 'Living room lamp', deviceType: 'Plug', modelName: 'GKW-PLG03' },
  { id: 'relay-1', name: 'Kitchen relay', deviceType: 'RelayController', modelName: 'GKR-RLY01' },
];
const row = (page: Page, id = 'plug-1') => page.locator(`#powerSpecTableBody [data-power-device-id="${id}"]`);
const active = (page: Page, id = 'plug-1') => row(page, id).locator('[data-power-field="activeWatts"]');
const standby = (page: Page, id = 'plug-1') => row(page, id).locator('[data-power-field="standbyWatts"]');
async function openPower(page: Page, language: 'ko' | 'en' = 'ko') {
  await page.getByRole('tab', { name: language === 'ko' ? '도움말' : 'Help', exact: true }).click();
  await expect(page.locator('#panel-meter')).toBeVisible();
}
async function save(page: Page) {
  await page.locator('#powerSpecsSave').click();
}
async function savedCalls(page: Page) {
  return (await requestCalls(page, '/save-power-specs')).map((call) => call.payload);
}

test('registered devices have readonly identity and exactly two blank watt inputs', async ({ page }) => {
  await mountUi(page, { devices: [...devices, { id: 'outside', name: 'Other home', deviceType: 'Plug', inScope: false }] });
  await openPower(page);
  const table = page.locator('#powerSpecTable');
  await expect(table.locator('thead th')).toHaveCount(3);
  await expect(table.locator('[data-power-device-id]')).toHaveCount(3);
  await expect(table).not.toContainText('Other home');
  for (const device of devices) {
    await expect(row(page, device.id)).toContainText(device.name);
    await expect(row(page, device.id).locator('input')).toHaveCount(2);
    await expect(row(page, device.id).locator('td').first().locator('input,select,button')).toHaveCount(0);
  }
  for (const input of await table.locator('input').all()) {
    await expect(input).toHaveValue('');
    expect(await input.getAttribute('placeholder') ?? '').not.toMatch(/\d/);
  }
  await expect(page.locator('#panel-meter select,#panel-meter input[type="checkbox"],#panel-meter datalist')).toHaveCount(0);
  await expect(page.locator('#panel-meter')).not.toContainText(/fictional|example|가상|예시|계산기/i);
  await expect(page.locator('#powerSpecsSave')).toBeDisabled();
  expect(await savedCalls(page)).toEqual([]);
});

test('same-model devices save independent changed rows with null, zero and decimals and reopen durably', async ({ page }) => {
  await mountUi(page, { devices, status: { features: { devices: { unseen: { name: 'Unseen saved device', powerSpec: { activeWatts: 77 } } } } } });
  await openPower(page);
  await active(page).fill('0');
  await standby(page).fill('0.25');
  await active(page, 'plug-2').fill('42.75');
  await save(page);
  await expect.poll(() => savedCalls(page)).toEqual([{ uiSessionRevision: 'account-revision-1', updates: [
    { deviceId: 'plug-1', activeWatts: 0, standbyWatts: 0.25, expected: { activeWatts: null, standbyWatts: null } },
    { deviceId: 'plug-2', activeWatts: 42.75, standbyWatts: null, expected: { activeWatts: null, standbyWatts: null } },
  ] }]);
  await expect(page.locator('#powerSpecsFeedback')).toContainText(/저장/);
  expect(await page.evaluate(() => window.__hejHost.config.devicePreferences.unseen)).toEqual({ name: 'Unseen saved device', powerSpec: { activeWatts: 77 } });
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.setContent(source());
  await openPower(page);
  await expect(active(page)).toHaveValue('0');
  await expect(standby(page)).toHaveValue('0.25');
  await expect(active(page, 'plug-2')).toHaveValue('42.75');
  await expect(standby(page, 'plug-2')).toHaveValue('');
  await expect(active(page, 'relay-1')).toHaveValue('');
});

test('normal diagnostic polling preserves draft focus and caret', async ({ page }) => {
  await mountUi(page, { devices });
  await openPower(page);
  const input = active(page);
  await input.fill('1234');
  await input.focus();
  await page.keyboard.press('ArrowLeft');
  const before = (await requestCalls(page, '/diagnostics')).length;
  await publishStatus(page);
  await expect.poll(async () => (await requestCalls(page, '/diagnostics')).length).toBeGreaterThan(before);
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('1234');
  await page.keyboard.type('9');
  await expect(input).toHaveValue('12394');
  await expect(standby(page)).toHaveValue('');
  expect(await savedCalls(page)).toEqual([]);
});

for (const invalid of ['-1', '1e400', '1e', 'e']) {
  test(`invalid watt input ${invalid} cannot save or clear a previously saved value`, async ({ page }) => {
    await mountUi(page, { devices: [{ ...devices[0]!, preference: { powerSpec: { activeWatts: 5, standbyWatts: 1 } } }] });
    await openPower(page);
    // Real number-input keystrokes preserve badInput, unlike programmatic value assignment.
    await active(page).fill('');
    await active(page).pressSequentially(invalid);
    await standby(page).fill('2');
    await save(page);
    await expect(page.locator('#powerSpecsFeedback')).toContainText(/확인|숫자|입력|이상/);
    expect(await savedCalls(page)).toEqual([]);
    expect(await page.evaluate(() => window.__hejHost.config.devicePreferences['plug-1']?.powerSpec)).toEqual({ activeWatts: 5, standbyWatts: 1 });
  });
}

for (const cleared of ['active', 'both'] as const) {
  test(`clearing ${cleared} fields sends null and preserves unrelated device preferences`, async ({ page }) => {
    await mountUi(page, { devices: [{ ...devices[0]!, preference: { name: 'Custom name', role: 'outlet',
      powerSpec: { activeWatts: 50.5, standbyWatts: 0 } } }] });
    await openPower(page);
    await active(page).fill('');
    if (cleared === 'both') {
      await standby(page).fill('');
    }
    await save(page);
    await expect.poll(() => savedCalls(page)).toEqual([{ uiSessionRevision: 'account-revision-1', updates: [
      { deviceId: 'plug-1', activeWatts: null, standbyWatts: cleared === 'both' ? null : 0,
        expected: { activeWatts: 50.5, standbyWatts: 0 } },
    ] }]);
    await expect(page.locator('#powerSpecsFeedback')).toContainText(/저장/);
    expect(await page.evaluate(() => window.__hejHost.config.devicePreferences['plug-1'])).toEqual(cleared === 'both'
      ? { name: 'Custom name', role: 'outlet' } : { name: 'Custom name', role: 'outlet', powerSpec: { standbyWatts: 0 } });
  });
}

test('a newer edit typed while save is pending survives ACK and uses the acknowledged expected values', async ({ page }) => {
  await mountUi(page, { devices });
  await openPower(page);
  await active(page).fill('10');
  await page.evaluate(() => {
    window.__hejHost.holdNext['/save-power-specs'] = 1;
  });
  await save(page);
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.filter((entry) => entry.route === '/save-power-specs').length)).toBe(1);
  await active(page).fill('12.5');
  await standby(page).fill('0');
  await page.evaluate(() => window.__hejHost.pending.find((entry) => entry.route === '/save-power-specs')!.resolve());
  await expect(page.locator('#powerSpecsSave')).toBeEnabled();
  await expect(active(page)).toHaveValue('12.5');
  await expect(standby(page)).toHaveValue('0');
  await save(page);
  await expect.poll(() => savedCalls(page)).toEqual([
    { uiSessionRevision: 'account-revision-1', updates: [{ deviceId: 'plug-1', activeWatts: 10, standbyWatts: null,
      expected: { activeWatts: null, standbyWatts: null } }] },
    { uiSessionRevision: 'account-revision-1', updates: [{ deviceId: 'plug-1', activeWatts: 12.5, standbyWatts: 0,
      expected: { activeWatts: 10, standbyWatts: null } }] },
  ]);
  await expect(page.locator('#powerSpecsFeedback')).toContainText(/저장/);
});

test('two older diagnostics settling after save cannot roll back acknowledged values or expected baseline', async ({ page }) => {
  await mountUi(page, { devices });
  await openPower(page);
  const oldDiagnostics = await page.evaluate(() => {
    window.__hejHost.holdNext['/diagnostics'] = 2;
    return structuredClone(window.__hejHost.diagnostics);
  });
  await publishStatus(page);
  await publishStatus(page);
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.filter((entry) => entry.route === '/diagnostics').length)).toBe(2);
  await active(page).fill('18');
  await save(page);
  await expect(page.locator('#powerSpecsFeedback')).toContainText(/저장/);
  await page.evaluate((old) => {
    window.__hejHost.pending.filter((entry) => entry.route === '/diagnostics').forEach((entry) => entry.resolve(old));
  }, oldDiagnostics);
  await expect(active(page)).toHaveValue('18');
  await active(page).fill('19');
  await save(page);
  await expect.poll(async () => (await savedCalls(page)).at(-1)).toEqual({ uiSessionRevision: 'account-revision-1', updates: [
    { deviceId: 'plug-1', activeWatts: 19, standbyWatts: null, expected: { activeWatts: 18, standbyWatts: null } },
  ] });
  await expect(page.locator('#powerSpecsFeedback')).toContainText(/저장/);
});

test('save failure keeps every draft, makes no partial changes and an explicit retry succeeds', async ({ page }) => {
  await mountUi(page, { devices });
  await openPower(page);
  await active(page).fill('10');
  await active(page, 'plug-2').fill('20');
  await page.evaluate(() => {
    window.__hejHost.failNext['/save-power-specs'] = '저장 연결 실패';
  });
  await save(page);
  await expect(page.locator('#powerSpecsFeedback')).toContainText(/저장하지 못|실패/);
  await expect(active(page)).toHaveValue('10');
  await expect(active(page, 'plug-2')).toHaveValue('20');
  expect(await page.evaluate(() => window.__hejHost.config.devicePreferences['plug-1']?.powerSpec)).toBeUndefined();
  expect(await page.evaluate(() => window.__hejHost.config.devicePreferences['plug-2']?.powerSpec)).toBeUndefined();
  await save(page);
  await expect(page.locator('#powerSpecsFeedback')).toContainText(/저장/);
  expect(await savedCalls(page)).toHaveLength(2);
});

test('a concurrent saved change rejects the whole batch and preserves both local drafts', async ({ page }) => {
  await mountUi(page, { devices });
  await openPower(page);
  await active(page).fill('10');
  await active(page, 'plug-2').fill('20');
  await page.evaluate(() => {
    window.__hejHost.config.devicePreferences['plug-2'] = { powerSpec: { activeWatts: 99 } };
    window.__hejHost.diagnostics.devices[1]!.preference = { powerSpec: { activeWatts: 99 } };
  });
  await save(page);
  await expect(page.locator('#powerSpecsFeedback')).toContainText(/바뀌|확인/);
  await expect(active(page)).toHaveValue('10');
  await expect(active(page, 'plug-2')).toHaveValue('20');
  expect(await page.evaluate(() => window.__hejHost.config.devicePreferences['plug-1']?.powerSpec)).toBeUndefined();
  expect(await page.evaluate(() => window.__hejHost.config.devicePreferences['plug-2']?.powerSpec)).toEqual({ activeWatts: 99 });
});

for (const condition of ['empty', 'unavailable', 'missing-availability', 'missing-revision'] as const) {
  test(`${condition} registered list cannot send a clear or save and returning devices keep drafts`, async ({ page }) => {
    await mountUi(page, { devices });
    await openPower(page);
    await active(page).fill('34');
    const previous = await page.evaluate(() => structuredClone(window.__hejHost.diagnostics));
    await page.evaluate((condition) => {
      if (condition === 'empty') {
        window.__hejHost.diagnostics.devices = [];
      } else if (condition === 'unavailable') {
        window.__hejHost.diagnostics.deviceListAvailable = false;
      } else if (condition === 'missing-availability') {
        delete window.__hejHost.diagnostics.deviceListAvailable;
      } else {
        window.__hejHost.diagnostics.uiSessionRevision = null;
      }
    }, condition);
    await publishStatus(page);
    await expect(page.locator('#powerSpecsSave')).toBeDisabled();
    await expect(page.locator('#powerSpecsListState')).toBeVisible();
    expect(await savedCalls(page)).toEqual([]);
    await page.evaluate((previous) => {
      window.__hejHost.diagnostics = previous;
    }, previous);
    await publishStatus(page);
    await expect(active(page)).toHaveValue('34');
    await expect(page.locator('#powerSpecsSave')).toBeEnabled();
  });
}

test('a failed diagnostic request disables power saving without clearing the draft', async ({ page }) => {
  await page.clock.install();
  await mountUi(page, { devices });
  await openPower(page);
  await active(page).fill('34');
  await page.evaluate(() => {
    window.__hejHost.failNext['/diagnostics'] = '장치 목록 실패';
  });
  await publishStatus(page);
  await expect(page.locator('#powerSpecsSave')).toBeDisabled();
  expect(await savedCalls(page)).toEqual([]);
  await page.clock.fastForward(31000);
  await publishStatus(page);
  await expect(active(page)).toHaveValue('34');
  await expect(page.locator('#powerSpecsSave')).toBeEnabled();
});

async function loginOtherAccount(page: Page, identifier = 'other-account@example.test') {
  await page.getByLabel('이메일').fill(identifier);
  await page.getByRole('button', { name: '인증번호 전송', exact: true }).click();
  await page.getByLabel('6자리 인증번호 입력').fill('123456');
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await page.getByLabel('비밀번호').fill('fixture-only-password');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.locator('#loginView')).toBeHidden();
}

test('dirty logout cancellation preserves input and accepting discards it before another account signs in', async ({ page }) => {
  await mountUi(page, { devices });
  await openPower(page);
  await active(page).fill('73');
  await page.getByRole('tab', { name: '연결 설정', exact: true }).click();
  page.once('dialog', (dialog) => dialog.dismiss());
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  expect(await requestCalls(page, '/logout')).toHaveLength(0);
  await openPower(page);
  await expect(active(page)).toHaveValue('73');
  await page.getByRole('tab', { name: '연결 설정', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByLabel('이메일')).toBeVisible();
  await page.evaluate(() => {
    window.__hejHost.nextLoginDevices = [{ id: 'plug-1', name: 'New account lamp', deviceType: 'Plug', preference: { powerSpec: { activeWatts: 8 } } }];
    window.__hejHost.holdNext['/diagnostics'] = 2;
  });
  await loginOtherAccount(page);
  await openPower(page);
  await expect(page.locator('#powerSpecTableBody [data-power-device-id]')).toHaveCount(0);
  await expect(page.locator('#powerSpecsSave')).toBeDisabled();
  await page.evaluate(() => window.__hejHost.pending.filter((entry) => entry.route === '/diagnostics').forEach((entry) => entry.resolve()));
  await expect(active(page)).toHaveValue('8');
  await expect(row(page)).toContainText('New account lamp');
  expect(await savedCalls(page)).toEqual([]);
});

test('a first diagnostic from a different account cannot expose status-account preferences or save them', async ({ page }) => {
  await installUiHost(page, { devices: [{ ...devices[0]!, preference: { powerSpec: { activeWatts: 71 } } }] });
  await page.evaluate(() => {
    window.__hejHost.holdNext['/diagnostics'] = 2;
  });
  await page.setContent(source());
  await openPower(page);
  await expect(page.locator('#powerSpecTableBody [data-power-device-id]')).toHaveCount(0);
  await expect(page.locator('#powerSpecsSave')).toBeDisabled();
  await page.evaluate(() => {
    const host = window.__hejHost;
    host.status.uiSessionRevision = 'account-B';
    host.status.features = { devices: { 'plug-1': { powerSpec: { activeWatts: 9 } } } };
    host.diagnostics = { ...host.diagnostics, uiSessionRevision: 'account-B', devices: [
      { id: 'plug-1', name: 'Account B lamp', deviceType: 'Plug', inScope: true, preference: { powerSpec: { activeWatts: 9 } } },
    ] };
    host.config.devicePreferences = { 'plug-1': { powerSpec: { activeWatts: 9 } } };
    host.pending.filter((entry) => entry.route === '/diagnostics').at(-1)!.resolve(structuredClone(host.diagnostics));
  });
  await openPower(page);
  await expect(row(page)).toContainText('Account B lamp');
  await expect(active(page)).toHaveValue('9');
  expect(await savedCalls(page)).toEqual([]);
});

test('a dirty account switch requires discard and a late save ACK cannot restore the old account', async ({ page }) => {
  await mountUi(page, { devices });
  await openPower(page);
  await active(page).fill('10');
  await page.evaluate(() => {
    window.__hejHost.holdNext['/save-power-specs'] = 1;
  });
  await save(page);
  await page.evaluate(() => {
    const host = window.__hejHost;
    host.status.uiSessionRevision = 'account-B';
    host.status.features = { devices: { 'plug-1': { powerSpec: { activeWatts: 8 } } } };
    host.diagnostics = { ...host.diagnostics, uiSessionRevision: 'account-B', devices: [
      { id: 'plug-1', name: 'Account B lamp', deviceType: 'Plug', inScope: true, preference: { powerSpec: { activeWatts: 8 } } },
    ] };
    host.config.devicePreferences = { 'plug-1': { powerSpec: { activeWatts: 8 } } };
  });
  await publishStatus(page);
  const review = page.locator('#accountChangeAction');
  await expect(review).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await review.click();
  await expect(review).toBeVisible();
  page.once('dialog', (dialog) => dialog.accept());
  await review.click();
  await openPower(page);
  await expect(active(page)).toHaveValue('8');
  await page.evaluate(() => window.__hejHost.pending.find((entry) => entry.route === '/save-power-specs')!.resolve({
    ok: true, uiSessionRevision: 'account-revision-1', powerSpecs: [{ deviceId: 'plug-1', activeWatts: 10, standbyWatts: null }],
  }));
  await expect(active(page)).toHaveValue('8');
  await expect(row(page)).toContainText('Account B lamp');
  await expect(page.locator('#powerSpecsSave')).toBeDisabled();
});

test('late B status and old A diagnostics cannot overwrite account C with the same device ID', async ({ page }) => {
  await installUiHost(page, { devices });
  await page.evaluate(() => {
    window.__hejHost.holdNext['/diagnostics'] = 2;
  });
  await page.setContent(source());
  await openPower(page);
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.filter((entry) => entry.route === '/diagnostics').length)).toBe(2);
  const oldA = await page.evaluate(() => structuredClone(window.__hejHost.diagnostics));
  await page.evaluate(() => {
    const host = window.__hejHost;
    host.status.uiSessionRevision = 'account-B';
    host.status.features = { devices: { 'plug-1': { powerSpec: { activeWatts: 2 } } } };
    host.diagnostics = { ...host.diagnostics, uiSessionRevision: 'account-B', devices: [
      { id: 'plug-1', name: 'Account B lamp', deviceType: 'Plug', inScope: true, preference: { powerSpec: { activeWatts: 2 } } },
    ] };
    host.holdNext['/session-status'] = 1;
    host.pending.filter((entry) => entry.route === '/diagnostics').at(-1)!.resolve(structuredClone(host.diagnostics));
  });
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.filter((entry) => entry.route === '/session-status').length)).toBe(1);
  const oldB = await page.evaluate(() => structuredClone(window.__hejHost.status));
  await page.evaluate(() => {
    const host = window.__hejHost;
    host.status.uiSessionRevision = 'account-C';
    host.status.features = { devices: { 'plug-1': { powerSpec: { activeWatts: 3 } } } };
    host.diagnostics = { ...host.diagnostics, uiSessionRevision: 'account-C', devices: [
      { id: 'plug-1', name: 'Account C lamp', deviceType: 'Plug', inScope: true, preference: { powerSpec: { activeWatts: 3 } } },
    ] };
    host.config.devicePreferences = { 'plug-1': { powerSpec: { activeWatts: 3 } } };
  });
  await publishStatus(page);
  await openPower(page);
  await expect(active(page)).toHaveValue('3');
  await page.evaluate(({ oldA, oldB }) => {
    window.__hejHost.pending.find((entry) => entry.route === '/diagnostics')!.resolve(oldA);
    window.__hejHost.pending.find((entry) => entry.route === '/session-status')!.resolve(oldB);
  }, { oldA, oldB });
  await expect(row(page)).toContainText('Account C lamp');
  await expect(active(page)).toHaveValue('3');
  await active(page).fill('4');
  await save(page);
  await expect.poll(async () => (await savedCalls(page)).at(-1)).toEqual({ uiSessionRevision: 'account-C', updates: [
    { deviceId: 'plug-1', activeWatts: 4, standbyWatts: null, expected: { activeWatts: 3, standbyWatts: null } },
  ] });
});

const renderCases = (['ko', 'en'] as const).flatMap((language) => (['light', 'dark'] as const)
  .flatMap((theme) => [375, 1200].map((width) => ({ language, theme, width }))));
for (const { language, theme, width } of renderCases) {
  test(`${language} ${theme} ${width}px blank specification table has visible units and usable controls without page overflow`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await mountUi(page, { language, theme, devices });
    await openPower(page, language);
    const panel = page.locator('#panel-meter');
    await expect(page.locator('#powerSpecTable th')).toHaveCount(3);
    await expect(page.locator('#powerSpecTable th').nth(1)).toContainText('W');
    await expect(page.locator('#powerSpecTable th').nth(2)).toContainText('W');
    for (const input of await panel.locator('input').all()) {
      await expect(input).toHaveValue('');
      await expect(input).toHaveAccessibleName(/.+/);
      expect(await input.getAttribute('placeholder') ?? '').not.toMatch(/\d/);
    }
    for (const control of await panel.locator('input,button').all()) {
      const box = await control.boundingBox();
      expect(box?.height).toBeGreaterThanOrEqual(44);
      expect(box?.width).toBeGreaterThanOrEqual(44);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    expect(await page.evaluate(() => document.body.scrollWidth)).toBeLessThanOrEqual(width);
    const visibleGeometry = await page.locator('#powerSpecsScroll').evaluate((scroll) => {
      const bounds = scroll.getBoundingClientRect();
      const numericCells = [...scroll.querySelectorAll('th:not(:first-child), td:not(:first-child) input')];
      return { clientWidth: scroll.clientWidth, scrollWidth: scroll.scrollWidth,
        clipped: numericCells.filter((cell) => {
          const rect = cell.getBoundingClientRect();
          return rect.left < bounds.left - 1 || rect.right > bounds.right + 1;
        }).length };
    });
    expect(visibleGeometry.scrollWidth).toBeLessThanOrEqual(visibleGeometry.clientWidth + 1);
    expect(visibleGeometry.clipped).toBe(0);
    await expect(panel).not.toContainText(/fictional|example|가상|예시|calculator|계산기/i);
    if (language === 'en') {
      await expect(panel).not.toContainText(/[가-힣]/);
    }
    const directory = path.resolve('.superpowers/sdd/2026-10-01-power-specs/screenshots');
    fs.mkdirSync(directory, { recursive: true });
    await panel.screenshot({ path: path.join(directory, `${language}-${theme}-${width}-blank.png`) });
  });
}

test('same-account sign-in cannot accept an ACK from a discarded earlier editor instance', async ({ page }) => {
  await mountUi(page, { devices });
  await openPower(page);
  await active(page).fill('10');
  await page.evaluate(() => {
    window.__hejHost.holdNext['/save-power-specs'] = 1;
  });
  await save(page);
  await page.getByRole('tab', { name: '연결 설정', exact: true }).click();
  page.once('dialog', (dialog) => dialog.accept());
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByLabel('이메일')).toBeVisible();
  await page.evaluate(() => {
    // Account revision is stable for this account; the UI editor lifetime is new.
    window.__hejHost.status.uiSessionRevision = 'account-revision-1';
    window.__hejHost.diagnostics.uiSessionRevision = 'account-revision-1';
  });
  await loginOtherAccount(page, 'user@example.test');
  await openPower(page);
  await expect(active(page)).toHaveValue('');
  await active(page).fill('22');
  await page.evaluate(() => window.__hejHost.pending.find((entry) => entry.route === '/save-power-specs')!.resolve({
    ok: true, uiSessionRevision: 'account-revision-1', powerSpecs: [{ deviceId: 'plug-1', activeWatts: 10, standbyWatts: null }],
  }));
  await expect(active(page)).toHaveValue('22');
  await expect(page.locator('#powerSpecsSave')).toBeEnabled();
  await save(page);
  await expect.poll(async () => (await savedCalls(page)).at(-1)).toEqual({ uiSessionRevision: 'account-revision-1', updates: [
    { deviceId: 'plug-1', activeWatts: 22, standbyWatts: null, expected: { activeWatts: null, standbyWatts: null } },
  ] });
  await expect(page.locator('#powerSpecsFeedback')).toContainText(/저장했습니다/);
});

async function submitAndRevertPowerDraft(page: Page) {
  await mountUi(page, { devices: [{ ...devices[0]!, preference: { powerSpec: { activeWatts: 5 } } }] });
  await openPower(page);
  await active(page).fill('10');
  await page.evaluate(() => {
    window.__hejHost.holdNext['/save-power-specs'] = 1;
  });
  await save(page);
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.filter((entry) => entry.route === '/save-power-specs').length)).toBe(1);
  await active(page).fill('5');
}

test('a pending save reverted to its old baseline survives a missing device and commits the newest value after ACK', async ({ page }) => {
  await submitAndRevertPowerDraft(page);
  await page.evaluate(() => {
    // Server write completed, but its ACK and device-list refresh are still in flight.
    const host = window.__hejHost;
    host.config.devicePreferences['plug-1'] = { powerSpec: { activeWatts: 10 } };
    (host.status.features as Record<string, unknown>).devices = structuredClone(host.config.devicePreferences);
    host.diagnostics.devices = [];
  });
  await publishStatus(page);
  await expect(row(page)).toHaveCount(1);
  await expect(active(page)).toHaveValue('5');
  await expect(active(page)).toBeDisabled();
  await expect(page.locator('#powerSpecsSave')).toBeDisabled();
  await page.evaluate(() => {
    const host = window.__hejHost;
    host.diagnostics.devices = [{ id: 'plug-1', name: 'Study lamp', deviceType: 'Plug', inScope: true,
      preference: { powerSpec: { activeWatts: 10 } } }];
    host.pending.find((entry) => entry.route === '/save-power-specs')!.resolve({ ok: true,
      uiSessionRevision: 'account-revision-1', powerSpecs: [{ deviceId: 'plug-1', activeWatts: 10, standbyWatts: null }] });
  });
  await expect(active(page)).toHaveValue('5');
  await expect(page.locator('#powerSpecsFeedback')).toContainText(/아직 저장되지|unsaved/);
  await expect(page.locator('#powerSpecsSave')).toBeEnabled();
  await save(page);
  await expect.poll(async () => (await savedCalls(page)).at(-1)).toEqual({ uiSessionRevision: 'account-revision-1', updates: [
    { deviceId: 'plug-1', activeWatts: 5, standbyWatts: null, expected: { activeWatts: 10, standbyWatts: null } },
  ] });
  await expect(page.locator('#powerSpecsSave')).toBeDisabled();
  expect(await page.evaluate(() => window.__hejHost.config.devicePreferences['plug-1']?.powerSpec)).toEqual({ activeWatts: 5 });
});

test('a pending save reverted to its old baseline still requires logout discard confirmation', async ({ page }) => {
  await submitAndRevertPowerDraft(page);
  let confirmations = 0;
  page.on('dialog', async (dialog) => {
    confirmations++;
    await dialog.dismiss();
  });
  await page.getByRole('tab', { name: '연결 설정', exact: true }).click();
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  expect(confirmations).toBe(1);
  expect(await requestCalls(page, '/logout')).toHaveLength(0);
  await openPower(page);
  await expect(active(page)).toHaveValue('5');
});

test('a pending save reverted to its old baseline requires account-change discard confirmation', async ({ page }) => {
  await submitAndRevertPowerDraft(page);
  await page.evaluate(() => {
    const host = window.__hejHost;
    host.status.uiSessionRevision = 'account-B';
    host.status.features = { devices: { 'plug-1': { powerSpec: { activeWatts: 8 } } } };
    host.diagnostics = { ...host.diagnostics, uiSessionRevision: 'account-B', devices: [
      { id: 'plug-1', name: 'Account B lamp', deviceType: 'Plug', inScope: true, preference: { powerSpec: { activeWatts: 8 } } },
    ] };
  });
  await publishStatus(page);
  const review = page.locator('#accountChangeAction');
  await expect(review).toBeVisible();
  page.once('dialog', (dialog) => dialog.dismiss());
  await review.click();
  await expect(review).toBeVisible();
  expect(await savedCalls(page)).toHaveLength(1);
});

test('a reverted newer draft survives save rejection and subsequent saved-value polling', async ({ page }) => {
  await submitAndRevertPowerDraft(page);
  await page.evaluate(() => window.__hejHost.pending.find((entry) => entry.route === '/save-power-specs')!
    .reject(new Error('ACK unavailable')));
  await expect(page.locator('#powerSpecsFeedback')).toContainText(/저장하지 못/);
  await page.evaluate(() => {
    // An unconfirmed outcome can expose the submitted value in a later diagnostic.
    window.__hejHost.config.devicePreferences['plug-1'] = { powerSpec: { activeWatts: 10 } };
    window.__hejHost.diagnostics.devices[0]!.preference = { powerSpec: { activeWatts: 10 } };
  });
  await page.getByRole('tab', { name: '연결 설정', exact: true }).click();
  const before = (await requestCalls(page, '/diagnostics')).length;
  await publishStatus(page);
  await expect.poll(async () => (await requestCalls(page, '/diagnostics')).length).toBeGreaterThan(before);
  await openPower(page);
  await expect(active(page)).toHaveValue('5');
  await expect(page.locator('#powerSpecsSave')).toBeEnabled();
  expect(await savedCalls(page)).toHaveLength(1);
});
