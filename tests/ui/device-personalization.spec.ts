import { expect, test } from '@playwright/test';
import { mountUi, openDevice } from './host-fixture.js';

test('mobile settings save, edit and delete stable favorites and purifier mode buttons', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 900 });
  await mountUi(page, { devices: [
    { id: 'tv', name: 'TV', deviceType: 'IrTv' },
    { id: 'purifier', name: '청정기', deviceType: 'Airpurifier' },
    { id: 'strip', name: '멀티탭', deviceType: 'PowerStrip', powerChannels: ['power1', 'power2', 'power3', 'power4', 'power6'] },
  ] });
  await openDevice(page, 'tv');
  await page.getByRole('button', { name: '즐겨찾기 채널 추가', exact: true }).click();
  await page.getByLabel('즐겨찾기 1 이름', { exact: true }).fill('뉴스');
  await page.getByLabel('즐겨찾기 1 채널 번호', { exact: true }).fill('11');
  await page.getByRole('button', { name: '이 장치 저장', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__hejHost.config.devicePreferences.tv?.favoriteChannels)).toEqual([
    { id: expect.any(String), name: '뉴스', channel: 11 },
  ]);
  const id = await page.evaluate(() => (window.__hejHost.config.devicePreferences.tv?.favoriteChannels as Array<{ id: string }>)[0]!.id);
  await page.getByLabel('즐겨찾기 1 이름', { exact: true }).fill('영화');
  await page.getByLabel('즐겨찾기 1 채널 번호', { exact: true }).fill('22');
  await page.getByRole('button', { name: '이 장치 저장', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__hejHost.config.devicePreferences.tv?.favoriteChannels))
    .toEqual([{ id, name: '영화', channel: 22 }]);
  await page.getByRole('button', { name: '즐겨찾기 1 삭제', exact: true }).click();
  await page.getByRole('button', { name: '이 장치 저장', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__hejHost.config.devicePreferences.tv?.favoriteChannels)).toBeUndefined();
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'purifier');
  await page.getByRole('switch', { name: '모드 버튼을 Apple Home에 표시', exact: true }).click();
  await page.getByRole('button', { name: '이 장치 저장', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__hejHost.config.devicePreferences.purifier?.purifierModeButtons)).toBe(true);
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'strip');
  await page.getByLabel('포트 1 이름', { exact: true }).fill('책상');
  await page.getByLabel('포트 6 이름', { exact: true }).fill('USB');
  await page.getByRole('button', { name: '이 장치 저장', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__hejHost.config.devicePreferences.strip?.channelNames))
    .toEqual({ power1: '책상', power6: 'USB' });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
});

test('settings from a previous device type remain removable so other edits can be saved', async ({ page }) => {
  await mountUi(page, { devices: [
    { id: 'former-tv', name: 'Changed TV', deviceType: 'IrFan', preference: {
      favoriteChannels: [{ id: 'news', name: '뉴스', channel: 11 }],
    } },
    { id: 'former-purifier', name: 'Changed purifier', deviceType: 'Plug', preference: { purifierModeButtons: true } },
  ] });
  await openDevice(page, 'former-tv');
  await page.getByRole('button', { name: '즐겨찾기 1 삭제', exact: true }).click();
  await page.getByLabel('표시 이름', { exact: true }).fill('Fan');
  await page.getByRole('button', { name: '이 장치 저장', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__hejHost.config.devicePreferences['former-tv'])).toEqual({ name: 'Fan' });
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'former-purifier');
  await page.getByRole('switch', { name: '모드 버튼을 Apple Home에 표시', exact: true }).click();
  await page.getByLabel('표시 이름', { exact: true }).fill('Plug');
  await page.getByRole('button', { name: '이 장치 저장', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__hejHost.config.devicePreferences['former-purifier'])).toEqual({ name: 'Plug' });
});
