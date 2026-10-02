import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { chooseOption, mountUi, openDevice, publishStatus, requestCalls } from './host-fixture.js';

const source = fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');

test('live status does not erase a device name draft and English light mode remains readable', async ({ page }) => {
  await page.evaluate(() => {
    const host = new EventTarget();
    const state = { saved: null as unknown, calls: 0 };
    const diagnostics = {
      uiSessionRevision: 'account-revision-1', deviceListAvailable: true, controlsAvailable: false, updatedAt: new Date().toISOString(),
      connection: { session: 'valid', realtime: 'connected' },
      devices: [{ id: 'plug-1', name: 'Desk plug', deviceType: 'Plug', inScope: true,
        roleChangeSupported: true, preference: {}, homekit: false, matter: false,
        lastControl: 'unknown', lastSeenAt: null, meterProfileApplied: false },
      { id: 'tv-1', name: 'Living room TV', deviceType: 'IrTv', inScope: true,
        roleChangeSupported: false, preference: {}, homekit: false, matter: false,
        lastControl: 'unknown', lastSeenAt: null, meterProfileApplied: false }],
    };
    Object.assign(host, {
      i18nCurrentLang: async () => 'en-US', userCurrentLightingMode: async () => 'light',
      getCachedAccessories: async () => [], getCachedMatterAccessories: async () => [],
      request: async (route: string, payload: unknown) => {
        if (route === '/session-status') {
          return { configured: true, sessionValid: true, uiSessionRevision: 'account-revision-1',
            features: { matter: false, adaptiveLighting: false, meters: [] },
            scope: { mode: 'first-family' }, supportedModels: [] };
        }
        if (route === '/diagnostics') {
          state.calls++; return diagnostics;
        }
        if (route === '/save-device-settings') {
          state.saved = payload; return { ok: true };
        }
        return {};
      },
      toast: { success() {}, error() {} }, hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
    });
    window.homebridge = host as typeof window.homebridge;
    Object.assign(window, { __hejTest: { state, diagnostics } });
  });
  await page.setContent(source);
  await expect(page.getByRole('button', { name: 'Devices', exact: true })).toBeVisible();
  await openDevice(page, 'plug-1');
  await expect(page.locator('html')).toHaveAttribute('data-hej-theme', 'light');
  expect(await page.getByTestId('device-detail').evaluate((node) => node.textContent?.match(/[가-힣][^\n]*/g) ?? [])).toEqual([]);
  const name = page.getByTestId('device-detail').getByLabel('Display name');
  await name.fill('Reading lamp');
  await name.focus();
  await page.evaluate(() => window.homebridge.dispatchEvent(new Event('hejhome-status-changed')));
  await expect(name).toHaveValue('Reading lamp');
  await expect(name).toBeFocused();
  await page.evaluate(() => {
    const helper = (window as unknown as { __hejTest: { diagnostics: { controlsAvailable: boolean } } }).__hejTest;
    helper.diagnostics.controlsAvailable = true;
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await page.evaluate(() => {
    const helper = (window as unknown as { __hejTest: { diagnostics: { updatedAt: string } } }).__hejTest;
    helper.diagnostics.updatedAt = new Date(Date.now() - 3600000).toISOString();
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await expect(name).toBeFocused();
  await page.evaluate(() => {
    const helper = (window as unknown as { __hejTest: { diagnostics: { updatedAt: string } } }).__hejTest;
    helper.diagnostics.updatedAt = new Date().toISOString();
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await expect(name).toHaveValue('Reading lamp');
  await expect(name).toBeFocused();
  await page.getByTestId('device-detail').getByRole('button', { name: 'Save this device' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hejTest: { state: { saved: unknown } } }).__hejTest.state.saved))
    .toMatchObject({ deviceId: 'plug-1', preference: { name: 'Reading lamp' } });
  await page.getByRole('button', { name: 'Back to devices', exact: true }).click();
  await openDevice(page, 'tv-1', 'controls');
  const volume = page.getByTestId('device-detail').getByRole('button', { name: 'Volume up' });
  await expect(volume).toBeEnabled();
  await page.evaluate(() => {
    const helper = (window as unknown as { __hejTest: { diagnostics: { updatedAt: string } } }).__hejTest;
    helper.diagnostics.updatedAt = new Date(Date.now() - 3600000).toISOString();
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await expect(volume).toBeDisabled();

});

test('a late diagnostic response after timeout cannot overwrite a newer completed refresh', async ({ page }) => {
  await page.clock.install();
  await page.evaluate(() => {
    const host = new EventTarget();
    const state: { pending?: (value: unknown) => void; hold: boolean; count: number } = { hold: false, count: 0 };
    const diagnostic = (realtime: string) => ({ uiSessionRevision: 'account-revision-1',
      deviceListAvailable: true, controlsAvailable: false, updatedAt: new Date().toISOString(),
      connection: { session: 'valid', realtime }, devices: [] });
    Object.assign(host, {
      request: async (route: string) => {
        if (route === '/session-status') {
          return { configured: true, sessionValid: true, uiSessionRevision: 'account-revision-1',
            features: { matter: false, adaptiveLighting: false, meters: [] }, scope: { mode: 'first-family' } };
        }
        if (route === '/diagnostics') {
          state.count++;
          if (state.hold) {
            state.hold = false; return new Promise((resolve) => {
              state.pending = resolve;
            });
          }
          return diagnostic('connected');
        }
        return {};
      },
      getCachedAccessories: async () => [], getCachedMatterAccessories: async () => [],
      toast: { success() {}, error() {} }, hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
    });
    window.homebridge = host as typeof window.homebridge;
    Object.assign(window, { __hejTest: { state, diagnostic } });
  });
  await page.setContent(source);
  await expect(page.locator('#account-summary')).toContainText('실시간 상태 수신 중');
  const initialCalls = await page.evaluate(() => (window as unknown as { __hejTest: { state: { count: number } } }).__hejTest.state.count);
  await page.evaluate(() => {
    const testState = (window as unknown as { __hejTest: { state: { hold: boolean } } }).__hejTest.state;
    testState.hold = true;
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hejTest: { state: { count: number } } }).__hejTest.state.count))
    .toBe(initialCalls + 1);
  await page.clock.fastForward(10001);
  await expect(page.locator('#globalStatus')).toContainText('최근 상태를 확인할 수 없어요');
  await page.clock.fastForward(30001);
  await publishStatus(page);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hejTest: { state: { count: number } } }).__hejTest.state.count))
    .toBeGreaterThanOrEqual(initialCalls + 2);
  await expect(page.locator('#account-summary')).toContainText('실시간 상태 수신 중');
  await page.evaluate(() => {
    const helper = (window as unknown as { __hejTest: { state: { pending: (value: unknown) => void }; diagnostic: (state: string) => unknown } }).__hejTest;
    helper.state.pending(helper.diagnostic('disconnected'));
  });
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.locator('#account-summary')).toContainText('실시간 상태 수신 중');
});

test('saved device cache is not shown as a current pairing and event listeners are cleaned up', async ({ page }) => {
  await page.evaluate(() => {
    const host = new EventTarget();
    const state = { calls: 0 };
    Object.assign(host, {
      request: async (route: string) => {
        if (route === '/session-status') {
          return { configured: true, sessionValid: true, uiSessionRevision: 'account-revision-1',
            features: { matter: true, adaptiveLighting: false, meters: [] }, scope: { mode: 'first-family' } };
        }
        if (route === '/diagnostics') {
          state.calls += 1;
          return { uiSessionRevision: 'account-revision-1',
            deviceListAvailable: true, controlsAvailable: false, generatedAt: new Date(Date.now() - 3600000).toISOString(),
            updatedAt: new Date(Date.now() - 3600000).toISOString(),
            connection: { session: 'unknown', realtime: 'disconnected' },
            devices: [{ id: 'tv-1', name: 'TV', deviceType: 'IrTv', inScope: true,
              roleChangeSupported: false, preference: {}, homekit: true, matter: true,
              lastControl: 'unknown', lastSeenAt: null, meterProfileApplied: false }] };
        }
        return {};
      },
      getCachedAccessories: async () => [{ context: { device: { id: 'tv-1' } } }],
      getCachedMatterAccessories: async () => [{ serialNumber: 'tv-1' }],
      toast: { success() {}, error() {} }, hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
    });
    window.homebridge = host as typeof window.homebridge;
    Object.assign(window, { __hejTest: { state } });
  });
  await page.setContent(source);
  await openDevice(page, 'tv-1');
  const detail = page.getByTestId('device-detail');
  await detail.locator('summary').filter({ hasText: '상태 및 연결' }).click();
  await expect(detail).toContainText('Apple Home: 이전에 저장된 장치');
  await expect(detail).toContainText('Matter: 이전에 저장된 장치');
  await expect(detail).not.toContainText('연결용으로 준비됨');
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  const before = await page.evaluate(() => (window as unknown as { __hejTest: { state: { calls: number } } }).__hejTest.state.calls);
  await page.evaluate(() => window.homebridge.dispatchEvent(new Event('hejhome-status-changed')));
  await page.waitForTimeout(100);
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hejTest: { state: { calls: number } } }).__hejTest.state.calls))
    .toBe(before);
  await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hejTest: { state: { calls: number } } }).__hejTest.state.calls))
    .toBeGreaterThan(before);
});

test('device appearance changes save the physical device ID without writing other settings', async ({ page }) => {
  const { mountUi, requestCalls } = await import('./host-fixture.js');
  await mountUi(page, { devices: [{ id: 'relay-1', name: '기존 릴레이', deviceType: 'RelayController', roleChangeSupported: true }] });
  await openDevice(page, 'relay-1');
  const detail = page.getByTestId('device-detail');
  await detail.getByLabel('표시 이름').fill('간접 조명');
  await chooseOption(page, detail.locator('[data-device-control="role"]'), '조명');
  await chooseOption(page, detail.getByLabel('연결 방식'), 'Apple Home만');
  await detail.getByRole('button', { name: '이 장치 저장' }).click();
  await expect.poll(async () => (await requestCalls(page, '/save-device-settings')).at(-1)?.payload).toEqual({
    deviceId: 'relay-1', preference: { name: '간접 조명', role: 'light', visibility: 'homekit' },
  });
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'relay-1');
  await expect(detail.locator('[data-device-control="role"]')).toContainText('조명');
  await expect(detail.getByLabel('연결 방식')).toContainText('Apple Home만');
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});

test('a saved device keeps its latest preference while excluded from scope', async ({ page }) => {
  await mountUi(page, { devices: [{ id: 'plug-1', name: 'Desk plug', deviceType: 'Plug', preference: { name: 'Old name' } }] });
  await openDevice(page, 'plug-1');
  const detail = page.getByTestId('device-detail');
  const name = detail.getByLabel('표시 이름');
  await name.fill('Saved new name');
  await detail.getByRole('button', { name: '이 장치 저장' }).click();
  await expect(detail.getByRole('button', { name: '이 장치 저장' })).toBeDisabled();
  await page.evaluate(() => {
    window.__hejHost.diagnostics.devices[0].inScope = false;
  });
  await publishStatus(page);
  await expect(detail).toContainText('이 장치를 현재 목록에서 확인할 수 없습니다');
  await expect(name).toHaveValue('Saved new name');
  await expect(name).toBeDisabled();
  await expect(detail.getByLabel('Home 앱에서 보이는 형태')).toBeDisabled();
  await expect(detail.getByLabel('연결 방식')).toBeDisabled();
  await expect(detail.getByRole('button', { name: '이 장치 저장' })).toBeDisabled();
  const removed = await page.evaluate(() => window.__hejHost.diagnostics.devices.splice(0, 1)[0]);
  await publishStatus(page);
  await expect(page.locator('#deviceCount')).toHaveText('0개 장치');
  await expect(name).toHaveValue('Saved new name');
  await page.evaluate((removed) => {
    window.__hejHost.diagnostics.devices.push({ ...removed, inScope: true });
  }, removed);
  await publishStatus(page);
  await expect(name).toBeEnabled();
  await chooseOption(page, detail.getByLabel('Home 앱에서 보이는 형태'), '조명');
  await detail.getByRole('button', { name: '이 장치 저장' }).click();
  await expect.poll(async () => (await requestCalls(page, '/save-device-settings')).at(-1)?.payload).toEqual({
    deviceId: 'plug-1', preference: { name: 'Saved new name', role: 'light' },
  });
});

test('disappearing devices retain their draft and newly discovered devices do not steal focus', async ({ page }) => {
  await mountUi(page, { devices: [{ id: 'plug-1', name: 'Desk plug', deviceType: 'Plug', preference: { name: 'Saved name' } }] });
  await openDevice(page, 'plug-1');
  const detail = page.getByTestId('device-detail');
  const name = detail.getByLabel('표시 이름');
  await name.fill('Unsaved name');
  await page.evaluate(() => {
    window.__hejHost.diagnostics.devices.push({ id: 'new-plug', name: 'New plug', deviceType: 'Plug', inScope: true, preference: {} });
  });
  await publishStatus(page);
  await expect(page.locator('#deviceCount')).toHaveText('2개 장치');
  await expect(name).toHaveValue('Unsaved name');
  await expect(name).toBeFocused();
  await page.evaluate(() => {
    window.__hejHost.diagnostics.devices = window.__hejHost.diagnostics.devices.filter((item) => item.id !== 'plug-1');
  });
  await publishStatus(page);
  await expect(name).toBeDisabled();
  await expect(name).toHaveValue('Unsaved name');
  await expect(detail).toHaveAttribute('data-device-id', 'plug-1');
  await expect(detail.getByRole('button', { name: '이 장치 저장' })).toBeDisabled();
  expect(await requestCalls(page, '/save-device-settings')).toHaveLength(0);
  await page.evaluate(() => {
    window.__hejHost.diagnostics.devices.push({ id: 'plug-1', name: 'Desk plug', deviceType: 'Plug', inScope: true,
      roleChangeSupported: true, preference: { name: 'Saved name' } });
  });
  await publishStatus(page);
  await expect(name).toBeEnabled();
  await expect(name).toHaveValue('Unsaved name');
  await detail.getByRole('button', { name: '이 장치 저장' }).click();
  await expect.poll(async () => (await requestCalls(page, '/save-device-settings')).at(-1)?.payload).toEqual({
    deviceId: 'plug-1', preference: { name: 'Unsaved name' },
  });
});

test('a removed meter retains the draft and offers explicit cleanup of inactive freshness', async ({ page }) => {
  await mountUi(page, { devices: [{ id: 'plug-1', name: 'Desk plug', deviceType: 'Plug', meterProfileApplied: true,
    preference: { freshnessMinutes: 30 } }] });
  await openDevice(page, 'plug-1');
  const detail = page.getByTestId('device-detail');
  const name = detail.getByLabel('표시 이름');
  const freshness = detail.getByLabel('측정값 유효 시간(분)');
  await freshness.fill('45');
  await name.fill('New plug name');
  await page.evaluate(() => {
    window.__hejHost.diagnostics.devices[0].meterProfileApplied = false;
  });
  await publishStatus(page);
  await expect(freshness).toBeDisabled();
  await expect(freshness).toHaveValue('45');
  await expect(name).toHaveValue('New plug name');
  await expect(name).toBeFocused();
  await expect(detail).toContainText('기존 값의 삭제만 가능합니다');
  expect(await requestCalls(page, '/save-device-settings')).toHaveLength(0);
  await detail.getByRole('button', { name: '유효 시간 지우기' }).click();
  await detail.getByRole('button', { name: '이 장치 저장' }).click();
  await expect.poll(async () => (await requestCalls(page, '/save-device-settings')).at(-1)?.payload).toEqual({
    deviceId: 'plug-1', preference: { name: 'New plug name' },
  });
});

test('an inactive purifier freshness value is only removed by explicit cleanup', async ({ page }) => {
  await mountUi(page, { devices: [{ id: 'purifier-1', name: 'Purifier', deviceType: 'Airpurifier', preference: { freshnessMinutes: 30 } }] });
  await openDevice(page, 'purifier-1');
  const detail = page.getByTestId('device-detail');
  const freshness = detail.getByLabel('측정값 유효 시간(분)');
  await detail.getByLabel('표시 이름').fill('New purifier name');
  await expect(freshness).toHaveValue('30');
  await expect(freshness).toBeDisabled();
  await detail.getByRole('button', { name: '유효 시간 지우기' }).click();
  await expect(freshness).toHaveValue('');
  await detail.getByRole('button', { name: '이 장치 저장' }).click();
  await expect.poll(async () => (await requestCalls(page, '/save-device-settings')).at(-1)?.payload).toEqual({
    deviceId: 'purifier-1', preference: { name: 'New purifier name' },
  });
});

for (const meterProfileApplied of [false, true]) {
  test(`disabling PM2.5 preserves freshness only when power measurement remains active (${meterProfileApplied})`, async ({ page }) => {
    await mountUi(page, { devices: [{ id: 'purifier-1', name: 'Purifier', deviceType: 'Airpurifier', meterProfileApplied,
      preference: { pm25Multiplier: 0.5, freshnessMinutes: 30 } }] });
    await openDevice(page, 'purifier-1');
    const detail = page.getByTestId('device-detail');
    await detail.getByText('고급: PM2.5 측정값 보정').click();
    await detail.getByLabel('보정 배율').fill('');
    await expect(detail.getByLabel('측정값 유효 시간(분)')).toHaveValue(meterProfileApplied ? '30' : '');
    await detail.getByRole('button', { name: '이 장치 저장' }).click();
    await expect.poll(async () => (await requestCalls(page, '/save-device-settings')).at(-1)?.payload).toEqual({
      deviceId: 'purifier-1', preference: meterProfileApplied ? { freshnessMinutes: 30 } : {},
    });
  });
}
