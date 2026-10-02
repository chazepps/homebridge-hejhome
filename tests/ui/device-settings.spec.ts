import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { chooseOption, openDevice } from './host-fixture.js';

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

test('older diagnostic response cannot overwrite a newer status', async ({ page }) => {
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
  await page.evaluate(() => {
    const testState = (window as unknown as { __hejTest: { state: { hold: boolean } } }).__hejTest.state;
    testState.hold = true;
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await expect(page.locator('#account-summary')).toContainText('실시간 상태 수신 중');
  await page.evaluate(() => {
    const helper = (window as unknown as { __hejTest: { state: { pending: (value: unknown) => void }; diagnostic: (state: string) => unknown } }).__hejTest;
    helper.state.pending(helper.diagnostic('disconnected'));
  });
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
