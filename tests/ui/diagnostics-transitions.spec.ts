import fs from 'node:fs';
import { expect, test } from '@playwright/test';

const source = fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');

test('partial outage, hidden device, stale cache and reconnection update without reload', async ({ page }) => {
  await page.evaluate(() => {
    const host = new EventTarget();
    const now = new Date().toISOString();
    const old = new Date(Date.now() - 3600000).toISOString();
    const state = { diagnostics: {
      generatedAt: old, updatedAt: old, controlsAvailable: true,
      connection: { session: 'valid', realtime: 'connected' },
      devices: [
        { id: 'plug-1', name: 'Study plug', deviceType: 'Plug', inScope: true, online: false,
          homekit: true, matter: false, lastSeenAt: old, lastControl: 'failed', meterProfileApplied: false,
          roleChangeSupported: true, preference: {} },
        { id: 'hidden-1', name: 'Hidden switch', deviceType: 'Switch1', inScope: true, online: true,
          homekit: false, matter: false, lastSeenAt: now, lastControl: 'unknown', meterProfileApplied: false,
          roleChangeSupported: true, preference: { visibility: 'hidden' } },
      ],
    } };
    Object.assign(host, {
      request: async (route: string) => {
        if (route === '/session-status') {
          return { configured: true, sessionValid: true, features: { matter: true, adaptiveLighting: false, meters: [] },
            scope: { mode: 'first-family' }, supportedModels: [] };
        }
        if (route === '/diagnostics') {
          return state.diagnostics;
        }
        return {};
      },
      getCachedAccessories: async () => [{ context: { device: { id: 'plug-1' } } }],
      getCachedMatterAccessories: async () => [],
      toast: { success() {}, error() {} }, hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
    });
    window.homebridge = host as typeof window.homebridge;
    Object.assign(window, { __hejState: state });
  });
  await page.setContent(source);
  await expect(page.locator('#diagnosticsBadge')).toContainText('최근 상태 확인 불가');
  await expect(page.locator('#diagnosticsList')).toContainText('이전에 찾은 장치');
  await page.evaluate(() => {
    const state = (window as unknown as { __hejState: { diagnostics: { updatedAt: string,
      connection: { session: string, realtime: string } } } }).__hejState;
    state.diagnostics.updatedAt = new Date().toISOString();
    state.diagnostics.connection.realtime = 'disconnected';
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await expect(page.locator('#diagnosticsBadge')).toContainText('장치 상태 연결 끊김');
  await expect(page.locator('#diagnosticsList')).toContainText('장치와 연결되지 않음');
  await expect(page.locator('#diagnosticsList')).toContainText('표시하지 않음');
  await page.evaluate(() => {
    const state = (window as unknown as { __hejState: { diagnostics: { updatedAt: string,
      connection: { session: string, realtime: string }, devices: Array<{ online: boolean, lastControl: string }> } } }).__hejState;
    state.diagnostics.updatedAt = new Date().toISOString();
    state.diagnostics.connection.realtime = 'connecting';
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await expect(page.locator('#connectionSummary')).toContainText('장치 상태 연결 중');
  await page.evaluate(() => {
    const state = (window as unknown as { __hejState: { diagnostics: { updatedAt: string,
      connection: { session: string, realtime: string }, devices: Array<{ online: boolean, lastControl: string }> } } }).__hejState;
    state.diagnostics.updatedAt = new Date().toISOString();
    state.diagnostics.connection.realtime = 'connected';
    state.diagnostics.devices[0].online = true;
    state.diagnostics.devices[0].lastControl = 'success';
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await expect(page.locator('#connectionSummary')).toContainText('장치 상태 수신 중');
  await expect(page.locator('#diagnosticsList')).toContainText('장치 연결됨');
  await expect(page.locator('#diagnosticsList')).toContainText('명령 전송 완료');
  await page.evaluate(() => {
    const state = (window as unknown as { __hejState: { diagnostics: { devices: unknown[] } } }).__hejState;
    state.diagnostics.devices = [];
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await expect(page.locator('#diagnosticsList')).toContainText('아직 찾은 장치가 없습니다.');
  await expect(page.locator('#deviceSettingsList')).toContainText('선택한 집/방에서 장치를 찾지 못했습니다.');
});
