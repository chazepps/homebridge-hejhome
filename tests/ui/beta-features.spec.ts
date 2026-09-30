import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { mountUi, requestCalls } from './host-fixture.js';

const source = fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');

test('connection and lighting options require separate explicit saves and survive reopening', async ({ page }) => {
  await mountUi(page);
  await page.getByRole('tab', { name: '연결 설정', exact: true }).click();
  const matter = page.getByLabel('다른 스마트홈 앱에 연결(Matter)');
  const adaptive = page.getByLabel('적응형 조명');
  await expect(matter).not.toBeChecked();
  await expect(adaptive).not.toBeChecked();
  await matter.check();
  await adaptive.check();
  await page.locator('#saveFeatures').click();
  await expect(page.locator('#featuresStatus')).toContainText('저장');
  await expect(adaptive).toBeChecked();
  expect((await requestCalls(page, '/save-features')).map((call) => call.payload)).toEqual([{ features: { matter: true } }]);
  await page.locator('#saveLighting').click();
  await expect.poll(async () => (await requestCalls(page, '/save-features')).map((call) => call.payload)).toEqual([
    { features: { matter: true } }, { features: { adaptiveLighting: true } },
  ]);
  await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
  await page.setContent(source);
  await page.getByRole('tab', { name: '연결 설정', exact: true }).click();
  await expect(matter).toBeChecked();
  await expect(adaptive).toBeChecked();
});

test('expert and form meter edits share the saved value including deletion of the last model', async ({ page }) => {
  await mountUi(page, { status: { features: { matter: true, adaptiveLighting: true,
    meters: [{ model: 'P1', power: { field: 'curPower', multiplier: 1 } }] } } });
  await page.getByRole('tab', { name: '도움말', exact: true }).click();
  await page.getByText('고급: 전력 측정 모델 설정', { exact: true }).click();
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  const profiles = [{ model: 'P1', power: { field: 'curPower', multiplier: 2 } }];
  await page.locator('#meterProfiles').fill(JSON.stringify(profiles));
  await page.locator('#saveMeters').click();
  await expect.poll(async () => (await requestCalls(page, '/save-features')).map((call) => call.payload))
    .toEqual([{ features: { meters: profiles } }]);
  await expect(page.locator('[data-meter-multiplier="power"]')).toHaveValue('2');
  await page.getByRole('button', { name: '이 모델 삭제', exact: true }).click();
  await page.locator('#saveMeters').click();
  await expect.poll(async () => (await requestCalls(page, '/save-features')).at(-1)?.payload).toEqual({ features: { meters: [] } });
  expect(await page.evaluate(() => window.__hejHost.status.features)).toMatchObject({ matter: true, adaptiveLighting: true, meters: [] });
  await expect(page.locator('#meterProfiles')).toHaveValue('[]');
});

test('invalid expert JSON is not saved and remains available for correction', async ({ page }) => {
  await mountUi(page);
  await page.getByRole('tab', { name: '도움말', exact: true }).click();
  await page.getByText('고급: 전력 측정 모델 설정', { exact: true }).click();
  await page.getByText('전문가용 원본 설정', { exact: true }).click();
  await page.locator('#meterProfiles').fill('{not json');
  await page.locator('#saveMeters').click();
  await expect(page.locator('#meterStatus')).toContainText(/저장하지 못|확인|올바른/);
  await expect(page.locator('#meterProfiles')).toHaveValue('{not json');
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});
