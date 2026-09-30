import { expect, test } from '@playwright/test';
import { mountUi, openDevice, publishStatus } from './host-fixture.js';

test('outage, hidden filtering, stale state and reconnection are visible through the device flow', async ({ page }) => {
  const old = new Date(Date.now() - 3600000).toISOString();
  await mountUi(page, {
    status: { features: { matter: true, adaptiveLighting: false, meters: [] } },
    diagnostics: { generatedAt: old, updatedAt: old },
    devices: [
      { id: 'plug-1', name: 'Study plug', deviceType: 'Plug', online: false, lastSeenAt: old, lastControl: 'failed' },
      { id: 'hidden-1', name: 'Hidden switch', deviceType: 'Switch1', preference: { visibility: 'hidden' }, homekit: false },
    ],
  });
  const summary = page.locator('#globalStatus');
  await expect(summary).toContainText(/최근 상태.*확인/);
  const plug = page.locator('[data-testid="device-row"][data-device-id="plug-1"]');
  await expect(plug).toContainText('최근 상태를 확인할 수 없어요');
  await page.evaluate(() => {
    window.__hejHost.diagnostics.updatedAt = new Date().toISOString();
    window.__hejHost.diagnostics.connection = { session: 'valid', realtime: 'disconnected' };
  });
  await publishStatus(page);
  await expect(summary).toContainText(/연결.*끊/);
  await expect(plug).toContainText('장치와 연결되지 않음');
  await page.getByLabel('장치 필터', { exact: true }).selectOption('attention');
  await expect(page.getByTestId('device-row')).toHaveCount(1);
  await expect(page.getByTestId('device-row')).toContainText('Study plug');
  await page.getByLabel('장치 필터', { exact: true }).selectOption('hidden');
  await expect(page.getByTestId('device-row')).toHaveCount(1);
  await expect(page.getByTestId('device-row')).toContainText('Hidden switch');
  await expect(page.getByTestId('device-row')).toContainText('표시하지 않음');
  await page.getByLabel('장치 필터', { exact: true }).selectOption('all');
  await page.evaluate(() => {
    window.__hejHost.diagnostics.connection = { session: 'valid', realtime: 'connecting' };
  });
  await publishStatus(page);
  await expect(summary).toContainText('연결 중');
  await page.evaluate(() => {
    window.__hejHost.diagnostics.connection = { session: 'valid', realtime: 'connected' };
    window.__hejHost.diagnostics.devices[0]!.online = true;
    window.__hejHost.diagnostics.devices[0]!.lastControl = 'success';
  });
  await publishStatus(page);
  await expect(summary).toContainText(/상태.*(수신 중|받고 있어요)/);
  await openDevice(page, 'plug-1');
  await expect(page.getByTestId('device-detail')).toContainText('장치 연결됨');
  await expect(page.getByTestId('device-detail')).toContainText('명령 전송 완료');
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await page.evaluate(() => {
    window.__hejHost.diagnostics.devices = [];
  });
  await publishStatus(page);
  await expect(page.getByTestId('device-row')).toHaveCount(0);
  await expect(page.getByRole('tabpanel', { name: '내 장치', exact: true })).toContainText(/장치를 찾지 못/);
});
