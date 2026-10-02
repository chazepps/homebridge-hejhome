import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { chooseOption, openDevice } from './host-fixture.js';

const source = fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');

test('live HVAC and purifier settings update without changing an in-progress target input', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await page.evaluate(() => {
    const host = new EventTarget();
    const state = { commands: [] as Array<{ route: string, payload: unknown }>, diagnostics: {
      uiSessionRevision: 'account-revision-1',
      deviceListAvailable: true, generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), controlsAvailable: true,
      connection: { session: 'valid', realtime: 'connected' },
      devices: [
        { id: 'ac-1', name: 'Bedroom AC', deviceType: 'IrAirconditioner', inScope: true,
          roleChangeSupported: false, preference: {}, online: true, homekit: true, matter: false,
          lastSeenAt: null, lastControl: 'unknown', meterProfileApplied: false, temperatureCelsius: 22,
          hvacSettings: { power: true, targetTemperature: 23, mode: 'cool', fanSpeed: 'low' } },
        { id: 'purifier-1', name: 'Purifier', deviceType: 'Airpurifier', inScope: true,
          roleChangeSupported: false, preference: {}, online: true, homekit: true, matter: false,
          lastSeenAt: null, lastControl: 'unknown', meterProfileApplied: false,
          purifierSettings: { power: true, mode: 'sleep' } },
        { id: 'ir-purifier-1', name: 'IR purifier', deviceType: 'IrAirpurifier', inScope: true,
          roleChangeSupported: false, preference: {}, online: true, homekit: false, matter: false,
          lastSeenAt: null, lastControl: 'unknown', meterProfileApplied: false },
      ],
    } };
    Object.assign(host, {
      request: async (route: string, payload: unknown) => {
        if (route === '/session-status') {
          return { configured: true, sessionValid: true, uiSessionRevision: 'account-revision-1',
            features: { matter: false, adaptiveLighting: false, meters: [] },
            scope: { mode: 'first-family' }, supportedModels: [] };
        }
        if (route === '/diagnostics') {
          return state.diagnostics;
        }
        if (route === '/purifier-command' || route === '/air-conditioner-command') {
          state.commands.push({ route, payload }); return { ok: true };
        }
        return {};
      },
      getCachedAccessories: async () => [], getCachedMatterAccessories: async () => [],
      toast: { success() {}, error() {} }, hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
    });
    window.homebridge = host as typeof window.homebridge;
    Object.assign(window, { __hejFixture: state });
  });
  await page.setContent(source);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await openDevice(page, 'ac-1', 'controls');
  const ac = page.locator('[data-testid="device-detail"][data-device-id="ac-1"]');
  await expect(ac.getByLabel('바꿀 설정 온도(°C)', { exact: true })).toBeVisible();
  await expect(ac.getByLabel('바꿀 운전 방식', { exact: true })).toBeVisible();
  await expect(ac.getByLabel('바꿀 바람 세기', { exact: true })).toBeVisible();
  await expect(ac).toContainText(/설정 온도\s*23\s*°C/);
  await expect(ac).toContainText(/현재 온도:\s*22\s*°C/);
  const target = ac.getByLabel('바꿀 설정 온도(°C)');
  await target.fill('25');
  await page.evaluate(() => {
    const fixture = (window as unknown as { __hejFixture: { diagnostics: { devices: Array<{ hvacSettings?: { targetTemperature: number } }> } } }).__hejFixture;
    fixture.diagnostics.devices[0].hvacSettings!.targetTemperature = 24;
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await expect(ac).toContainText(/설정 온도\s*24\s*°C/);
  await expect(target).toHaveValue('25');
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'purifier-1', 'controls');
  const purifier = page.locator('[data-testid="device-detail"][data-device-id="purifier-1"]');
  await expect(purifier.getByRole('button', { name: '공기청정기 켜기', exact: true })).toBeVisible();
  await expect(purifier.getByRole('button', { name: '공기청정기 끄기', exact: true })).toBeVisible();
  await expect(purifier).toContainText(/운전 방식\s*취침/);
  await chooseOption(page, purifier.getByLabel('바꿀 운전 방식'), '수동');
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'ac-1', 'controls');
  await chooseOption(page, ac.getByLabel('바꿀 운전 방식'), '난방');
  await target.focus();
  await page.evaluate(() => {
    const fixture = (window as unknown as { __hejFixture: { diagnostics: { controlsAvailable: boolean,
      connection: { realtime: string } } } }).__hejFixture;
    fixture.diagnostics.controlsAvailable = false;
    fixture.diagnostics.connection.realtime = 'disconnected';
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await expect(target).toHaveValue('25');
  await expect(target).toBeFocused();
  await expect(ac.getByLabel('바꿀 운전 방식')).toContainText('난방');
  await expect(ac).toContainText('마지막으로 읽은 설정');
  await page.evaluate(() => {
    const fixture = (window as unknown as { __hejFixture: { diagnostics: { controlsAvailable: boolean,
      connection: { realtime: string } } } }).__hejFixture;
    fixture.diagnostics.controlsAvailable = true;
    fixture.diagnostics.connection.realtime = 'connected';
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'purifier-1', 'controls');
  await expect(purifier.getByLabel('바꿀 운전 방식')).toContainText('수동');
  await expect(purifier.getByRole('button', { name: '운전 방식 설정' })).toBeEnabled();
  await purifier.getByRole('button', { name: '운전 방식 설정' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __hejFixture: { commands: unknown[] } }).__hejFixture.commands))
    .toContainEqual({ route: '/purifier-command', payload: { deviceId: 'purifier-1', command: { mode: 'manual' } } });
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'ir-purifier-1');
  await expect(page.getByTestId('device-detail')).not.toContainText('공기청정기 운전 방식');
});

test('eligible devices save freshness, remote buttons and optional PM2.5 calibration', async ({ page }) => {
  await page.evaluate(() => {
    const saved: Array<{ deviceId: string, preference: Record<string, unknown> }> = [];
    window.homebridge = {
      request: async (route, payload) => {
        if (route === '/session-status') {
          return { configured: true, sessionValid: true, uiSessionRevision: 'account-revision-1',
            features: { matter: true, adaptiveLighting: false, meters: [] },
            scope: { mode: 'first-family' }, supportedModels: [] };
        }
        if (route === '/diagnostics') {
          return { uiSessionRevision: 'account-revision-1',
            deviceListAvailable: true, generatedAt: new Date().toISOString(), updatedAt: new Date().toISOString(), controlsAvailable: false,
            connection: { session: 'valid', realtime: 'disconnected' }, devices: [
              { id: 'sensor-1', name: 'Thermometer', deviceType: 'SensorTh', inScope: true,
                roleChangeSupported: false, preference: {}, meterProfileApplied: false },
              { id: 'tv-1', name: 'TV', deviceType: 'IrTv', inScope: true,
                roleChangeSupported: false, preference: {}, meterProfileApplied: false },
              { id: 'purifier-1', name: 'Purifier', deviceType: 'Airpurifier', inScope: true,
                roleChangeSupported: false, preference: {}, meterProfileApplied: false },
            ] };
        }
        if (route === '/save-device-settings') {
          saved.push(payload as { deviceId: string, preference: Record<string, unknown> });
          return { ok: true };
        }
        return {};
      },
      getCachedAccessories: async () => [], getCachedMatterAccessories: async () => [],
      toast: { success() {}, error() {} }, hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
    };
    Object.assign(window, { __savedDevices: saved });
  });
  await page.setContent(source);
  await openDevice(page, 'sensor-1');
  const sensor = page.locator('[data-testid="device-detail"][data-device-id="sensor-1"]');
  await sensor.getByLabel('측정값 유효 시간(분)').fill('45');
  await sensor.getByRole('button', { name: '이 장치 저장' }).click();
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'tv-1');
  const tv = page.locator('[data-testid="device-detail"][data-device-id="tv-1"]');
  const remote = tv.getByLabel('리모컨 버튼을 Apple Home에 표시');
  await chooseOption(page, tv.getByLabel('연결 방식'), 'Matter만');
  await expect(remote).toBeDisabled();
  await chooseOption(page, tv.getByLabel('연결 방식'), 'Apple Home만');
  await remote.check();
  await tv.getByRole('button', { name: '이 장치 저장' }).click();
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'purifier-1');
  const purifier = page.locator('[data-testid="device-detail"][data-device-id="purifier-1"]');
  const pmValidity = purifier.getByLabel('측정값 유효 시간(분)');
  await expect(pmValidity).toBeDisabled();
  await purifier.getByText('고급: PM2.5 측정값 보정').click();
  await purifier.getByLabel('보정 배율').fill('0.5');
  await expect(pmValidity).toBeEnabled();
  await pmValidity.fill('30');
  await purifier.getByRole('button', { name: '이 장치 저장' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __savedDevices: unknown[] }).__savedDevices))
    .toEqual(expect.arrayContaining([
      { deviceId: 'sensor-1', preference: { freshnessMinutes: 45 } },
      { deviceId: 'tv-1', preference: { visibility: 'homekit', remoteButtons: true } },
      { deviceId: 'purifier-1', preference: { pm25Multiplier: 0.5, freshnessMinutes: 30 } },
    ]));
});
