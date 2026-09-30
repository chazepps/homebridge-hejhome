import fs from 'node:fs';
import { expect, test } from '@playwright/test';

const source = fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');

for (const language of ['ko', 'en']) {
  for (const theme of ['light', 'dark']) {
    for (const width of [375, 1200]) {
      test(`${language} ${theme} ${width}px settings stay readable`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await page.evaluate(({ language, theme }) => {
          window.homebridge = {
            i18nCurrentLang: async () => language,
            userCurrentLightingMode: async () => theme,
            request: async (route) => {
              if (route === '/session-status') {
                return { configured: true, sessionValid: true,
                  features: { matter: false, adaptiveLighting: false, meters: [] }, scope: { mode: 'first-family' } };
              }
              if (route === '/diagnostics') {
                return { controlsAvailable: false, updatedAt: null,
                  connection: { session: 'unknown', realtime: 'unknown' }, devices: [] };
              }
              return {};
            },
            getCachedAccessories: async () => [], getCachedMatterAccessories: async () => [],
            toast: { success() {}, error() {} }, hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
          };
        }, { language, theme });
        await page.setContent(source);
        await expect(page.locator('html')).toHaveAttribute('data-hej-theme', theme);
        await expect(page.getByRole('heading', { name: language === 'en' ? 'Hejhome settings' : 'Hejhome 설정' })).toBeVisible();
        await expect(page.getByRole('heading', { name: language === 'en' ? 'Connection status' : '연결 상태 살펴보기' })).toBeVisible();
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        if (language === 'en') {
          expect(await page.locator('#settingsView').evaluate((node) => node.textContent?.match(/[가-힣]/g) ?? [])).toEqual([]);
        }
      });
    }
  }
}

test('host theme change updates the open page', async ({ page }) => {
  await page.evaluate(() => {
    Object.assign(window, { __theme: 'dark' });
    window.homebridge = {
      i18nCurrentLang: async () => 'en',
      userCurrentLightingMode: async () => (window as unknown as { __theme: string }).__theme,
      request: async (route) => route === '/session-status'
        ? { configured: false, sessionValid: false } : {},
      toast: { success() {}, error() {} }, hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
    };
  });
  await page.setContent(source);
  await expect(page.locator('html')).toHaveAttribute('data-hej-theme', 'dark');
  await page.evaluate(() => {
    Object.assign(window, { __theme: 'light' });
  });
  await expect(page.locator('html')).toHaveAttribute('data-hej-theme', 'light', { timeout: 5000 });
});

for (const theme of ['light', 'dark']) {
  test(`${theme} badge and meta text keep readable contrast`, async ({ page }) => {
    await page.evaluate((theme) => {
      window.homebridge = {
        i18nCurrentLang: async () => 'ko', userCurrentLightingMode: async () => theme,
        request: async (route) => route === '/session-status'
          ? { configured: true, sessionValid: true, features: { matter: false, adaptiveLighting: false, meters: [] } }
          : route === '/diagnostics'
            ? { connection: { session: 'unknown', realtime: 'unknown' }, devices: [] } : {},
        getCachedAccessories: async () => [], getCachedMatterAccessories: async () => [],
        toast: { success() {}, error() {} }, hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
      };
    }, theme);
    await page.setContent(source);
    await expect(page.locator('html')).toHaveAttribute('data-hej-theme', theme);
    const samples = await page.locator('.hej-overview').evaluate((panel) => {
      const channel = (value: number) => {
        const linear = value / 255;
        return linear <= 0.04045 ? linear / 12.92 : ((linear + 0.055) / 1.055) ** 2.4;
      };
      const luminance = (cssColor: string) => {
        const values = cssColor.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [];
        return channel(values[0]) * 0.2126 + channel(values[1]) * 0.7152 + channel(values[2]) * 0.0722;
      };
      const background = luminance(getComputedStyle(panel).backgroundColor);
      return ['hej-badge', 'hej-badge is-good', 'hej-badge is-warn', 'hej-badge is-bad', 'hej-meta']
        .map((className) => {
          const element = document.createElement('span');
          element.className = className;
          element.textContent = '상태';
          panel.append(element);
          const foreground = luminance(getComputedStyle(element).color);
          element.remove();
          return { className, contrast: (Math.max(foreground, background) + 0.05)
            / (Math.min(foreground, background) + 0.05) };
        });
    });
    for (const sample of samples) {
      expect(sample.contrast, `${sample.className} in ${theme}`).toBeGreaterThanOrEqual(4.5);
    }
  });
}
