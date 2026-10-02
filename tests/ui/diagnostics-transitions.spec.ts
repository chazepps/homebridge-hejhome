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
  const summary = page.locator('#helpConnectionSummary');
  const checkConnection = async (text: string | RegExp) => {
    await page.getByRole('button', { name: '도움말', exact: true }).click();
    await expect(summary).toBeVisible();
    await expect(summary).toContainText(text);
    await page.getByRole('button', { name: '장치', exact: true }).click();
  };
  await checkConnection('현재 상태 확인 불가');
  const plug = page.locator('[data-testid="device-row"][data-device-id="plug-1"]');
  await expect(plug).toContainText('최근 상태 없음');
  await page.evaluate(() => {
    window.__hejHost.diagnostics.updatedAt = new Date().toISOString();
    window.__hejHost.diagnostics.connection = { session: 'valid', realtime: 'disconnected' };
  });
  await publishStatus(page);
  await checkConnection('연결 끊김');
  await expect(plug).toContainText('연결 끊김');
  await page.getByRole('radiogroup', { name: '장치 필터' }).getByRole('radio', { name: '확인 필요', exact: true }).click();
  await expect(page.getByTestId('device-row')).toHaveCount(1);
  await expect(page.getByTestId('device-row')).toContainText('Study plug');
  await page.getByRole('radiogroup', { name: '장치 필터' }).getByRole('radio', { name: '숨김', exact: true }).click();
  await expect(page.getByTestId('device-row')).toHaveCount(1);
  await expect(page.getByTestId('device-row')).toContainText('Hidden switch');
  await expect(page.getByTestId('device-row')).toContainText('표시하지 않음');
  await page.getByRole('radiogroup', { name: '장치 필터' }).getByRole('radio', { name: '전체', exact: true }).click();
  await page.evaluate(() => {
    window.__hejHost.diagnostics.connection = { session: 'valid', realtime: 'connecting' };
  });
  await publishStatus(page);
  await checkConnection('연결 중');
  await page.evaluate(() => {
    window.__hejHost.diagnostics.connection = { session: 'valid', realtime: 'connected' };
    window.__hejHost.diagnostics.devices[0]!.online = true;
    window.__hejHost.diagnostics.devices[0]!.lastControl = 'success';
  });
  await publishStatus(page);
  await checkConnection('상태 수신 중');
  await openDevice(page, 'plug-1');
  await page.getByTestId('device-detail').locator('summary').filter({ hasText: '상태 및 연결' }).click();
  await expect(page.getByTestId('device-detail')).toContainText('장치 연결됨');
  await expect(page.getByTestId('device-detail')).toContainText('명령 전송 완료');
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await page.evaluate(() => {
    window.__hejHost.diagnostics.devices = [];
  });
  await publishStatus(page);
  await expect(page.getByTestId('device-row')).toHaveCount(0);
  await expect(page.getByRole('region', { name: '장치', exact: true })).toContainText(/표시할 장치가 없습니다/);
});
