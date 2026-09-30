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
  await expect(page.getByLabel('Matter 장치 노출')).not.toBeChecked();
  await expect(page.getByLabel('적응형 조명')).not.toBeChecked();
  await page.getByLabel('Matter 장치 노출').check();
  await page.getByLabel('적응형 조명').check();
  await page.getByRole('button', { name: '베타 기능 저장' }).click();
  await expect(page.locator('#featuresStatus')).toContainText('저장');
  await page.setContent(source);
  await expect(page.getByLabel('Matter 장치 노출')).toBeChecked();
  await expect(page.getByLabel('적응형 조명')).toBeChecked();
});
