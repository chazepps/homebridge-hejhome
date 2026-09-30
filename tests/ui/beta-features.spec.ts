import fs from 'node:fs';
import { expect, test } from '@playwright/test';

const source = fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');

test('beta features require explicit selection and survive reload', async ({ page }) => {
  await page.evaluate(() => {
    let features = { matter: false, adaptiveLighting: false, meters: [] };
    window.homebridge = {
      request: async (path, payload) => {
        if (path === '/save-features') {
          features = payload.features;
          return { ok: true, features };
        }
        if (path === '/session-status') {
          return { configured: true, sessionValid: true, features, scope: { mode: 'first-family' }, supportedModels: [] };
        }
        return {};
      },
      hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
      toast: { success() {}, error() {} },
    };
  });
  await page.setContent(source);
  await expect(page.getByLabel('다른 스마트홈 앱에 연결(Matter)')).not.toBeChecked();
  await expect(page.getByLabel('적응형 조명')).not.toBeChecked();
  await page.getByLabel('다른 스마트홈 앱에 연결(Matter)').check();
  await page.getByLabel('적응형 조명').check();
  await page.getByRole('button', { name: '베타 기능 저장' }).click();
  await expect(page.locator('#featuresStatus')).toContainText('저장');
  await page.setContent(source);
  await expect(page.getByLabel('다른 스마트홈 앱에 연결(Matter)')).toBeChecked();
  await expect(page.getByLabel('적응형 조명')).toBeChecked();
});

test('editing expert meter settings is saved even when form rows exist', async ({ page }) => {
  await page.evaluate(() => {
    Object.assign(window, { __savedFeatures: null });
    window.homebridge = {
      request: async (route, payload) => {
        if (route === '/session-status') {
          return { configured: true, sessionValid: true,
            features: { matter: false, adaptiveLighting: false,
              meters: [{ model: 'P1', power: { field: 'curPower', multiplier: 1 } }] },
            scope: { mode: 'first-family' } };
        }
        if (route === '/save-features') {
          Object.assign(window, { __savedFeatures: payload.features });
          return { ok: true, features: payload.features };
        }
        return {};
      },
      hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
      toast: { success() {}, error() {} },
    };
  });
  await page.setContent(source);
  await page.getByText('고급: 전력 측정 모델 설정').click();
  await page.getByText('전문가용 원본 설정').click();
  await page.locator('#meterProfiles').fill(JSON.stringify([{ model: 'P1', power: { field: 'curPower', multiplier: 2 } }]));
  await page.getByRole('button', { name: '베타 기능 저장' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __savedFeatures?: { meters?: unknown[] } }).__savedFeatures?.meters))
    .toEqual([{ model: 'P1', power: { field: 'curPower', multiplier: 2 } }]);
  await page.getByRole('button', { name: '이 모델 삭제' }).click();
  await page.getByRole('button', { name: '베타 기능 저장' }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { __savedFeatures?: { meters?: unknown[] } }).__savedFeatures?.meters))
    .toEqual([]);
});
