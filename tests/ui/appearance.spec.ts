import fs from 'node:fs';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { mountUi, openDevice } from './host-fixture.js';

const screenshotDirectory = path.resolve('.superpowers/sdd/2026-09-30-ui-redesign/screenshots');
fs.mkdirSync(screenshotDirectory, { recursive: true });

const devices = [
  { id: 'tv-living', name: '거실 TV', deviceType: 'IrTv', lastControl: 'unknown' },
  { id: 'sensor-living', name: '거실 온습도', deviceType: 'SensorTh', online: false, lastControl: 'unknown' },
];

for (const language of ['ko', 'en'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [375, 1200]) {
      test(`${language} ${theme} ${width}px settings stay readable`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await mountUi(page, { language, theme, devices });
        await expect(page.locator('html')).toHaveAttribute('data-hej-theme', theme);
        await expect(page.getByRole('tablist').getByRole('tab')).toHaveCount(3);
        await expect(page.getByRole('tab', { name: language === 'en' ? 'My devices' : '내 장치' })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('[data-testid="device-row"]')).toHaveCount(2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);

        const contrast = await page.locator('#settingsView').evaluate((root) => {
          const parse = (value: string): [number, number, number, number] | null => {
            const match = value.match(/rgba?\(([^)]+)\)/);
            if (!match?.[1]) {
              return null;
            }
            const parts = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
            return [parts[0], parts[1], parts[2], parts[3] ?? 1];
          };
          const over = (foreground: number[], background: number[]) => foreground.slice(0, 3)
            .map((channel, index) => channel * (foreground[3] ?? 1) + background[index] * (1 - (foreground[3] ?? 1)));
          const luminance = (color: number[]) => color.slice(0, 3).map((channel) => {
            const unit = channel / 255;
            return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
          }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
          return [...root.querySelectorAll('.hej-muted, .hej-badge, .hej-meta, [role="tab"], .hej-device-card p')]
            .filter((node) => node instanceof HTMLElement && node.getClientRects().length > 0 && node.textContent?.trim())
            .map((node) => {
              const element = node as HTMLElement;
              const chain: HTMLElement[] = [];
              for (let current: HTMLElement | null = element; current; current = current.parentElement) {
                chain.unshift(current);
              }
              let background: number[] = [255, 255, 255];
              for (const current of chain) {
                const color = parse(getComputedStyle(current).backgroundColor);
                if (color) {
                  background = over(color, background);
                }
              }
              const textColor = parse(getComputedStyle(element).color) ?? [0, 0, 0, 1];
              const foreground = over(textColor, background);
              const light = luminance(foreground);
              const dark = luminance(background);
              return { text: element.textContent?.trim().slice(0, 45), ratio: (Math.max(light, dark) + 0.05)
                / (Math.min(light, dark) + 0.05) };
            });
        });
        expect(contrast.length).toBeGreaterThan(0);
        for (const sample of contrast) {
          expect(sample.ratio, `${language}/${theme}/${width}: ${sample.text}`).toBeGreaterThanOrEqual(4.5);
        }
        await page.screenshot({ path: path.join(screenshotDirectory, `${language}-${theme}-${width}.png`), fullPage: true });

        for (const name of [language === 'en' ? 'Connection settings' : '연결 설정', language === 'en' ? 'Help' : '도움말']) {
          await page.getByRole('tab', { name }).click();
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          const lowContrast = await page.getByRole('tabpanel', { name }).evaluate((panel) => {
            const rgb = (value: string) => value.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
            const linear = (value: number) => {
              const unit = value / 255;
              return unit <= 0.04045 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
            };
            const luminance = (color: number[]) => color.map(linear)
              .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0);
            return [...panel.querySelectorAll('.hej-muted, .hej-badge, .hej-meta')]
              .filter((element) => element instanceof HTMLElement && element.getClientRects().length > 0 && element.textContent?.trim())
              .flatMap((element) => {
                const node = element as HTMLElement;
                const foreground = luminance(rgb(getComputedStyle(node).color));
                let ancestor: HTMLElement | null = node;
                let background = [255, 255, 255];
                while (ancestor) {
                  const style = getComputedStyle(ancestor).backgroundColor;
                  if (style.startsWith('rgb(')) {
                    background = rgb(style);
                    break;
                  }
                  ancestor = ancestor.parentElement;
                }
                const light = luminance(background);
                const ratio = (Math.max(foreground, light) + 0.05) / (Math.min(foreground, light) + 0.05);
                return ratio < 4.5 ? [{ text: node.textContent?.trim().slice(0, 40), ratio }] : [];
              });
          });
          expect(lowContrast, `${language}/${theme}/${width} ${name}`).toEqual([]);
        }
      });
    }
  }
}

test('host theme change updates the open settings page', async ({ page }) => {
  await mountUi(page, { language: 'en', theme: 'dark', devices });
  await expect(page.locator('html')).toHaveAttribute('data-hej-theme', 'dark');
  await page.evaluate(() => {
    window.homebridge.userCurrentLightingMode = async () => 'light';
  });
  await expect(page.locator('html')).toHaveAttribute('data-hej-theme', 'light', { timeout: 5000 });
});

test('customer text uses a readable sans font in both languages', async ({ page }) => {
  for (const language of ['ko', 'en'] as const) {
    await mountUi(page, { language, devices });
    const family = await page.locator('#settingsView').evaluate((element) => getComputedStyle(element).fontFamily);
    expect(family, `${language} font family`).toMatch(/system-ui|sans-serif/i);
  }
});

test('key mobile and desktop flows render as usable pages', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mountUi(page, { language: 'ko', theme: 'light', devices });
  await openDevice(page, 'tv-living');
  await expect(page.locator('[data-testid="device-detail"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: path.join(screenshotDirectory, 'ko-light-375-detail.png'), fullPage: true });

  await page.setViewportSize({ width: 1200, height: 800 });
  await mountUi(page, { language: 'ko', theme: 'light', devices });
  await page.getByRole('tab', { name: '연결 설정' }).click();
  await expect(page.getByRole('tabpanel', { name: '연결 설정' })).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDirectory, 'ko-light-1200-connections.png'), fullPage: true });
  await page.getByRole('tab', { name: '도움말' }).click();
  await expect(page.getByRole('tabpanel', { name: '도움말' })).toBeVisible();
  await page.screenshot({ path: path.join(screenshotDirectory, 'ko-light-1200-help.png'), fullPage: true });

  await page.setViewportSize({ width: 375, height: 800 });
  await mountUi(page, { language: 'en', theme: 'dark', status: { configured: false, sessionValid: false } });
  await expect(page.getByRole('tablist')).toBeHidden();
  await expect(page.locator('#loginView')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ path: path.join(screenshotDirectory, 'en-dark-375-login.png'), fullPage: true });
});

test('mobile sign-in starts at the email step with a compact header', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const [language, theme] of [['en', 'dark'], ['ko', 'light']] as const) {
    await mountUi(page, { language, theme, status: { configured: false, sessionValid: false } });
    const login = page.locator('#loginView');
    await expect(login).toBeVisible();
    const brand = await login.locator('.hej-brand').boundingBox();
    expect(brand?.height, `${language} brand height`).toBeGreaterThanOrEqual(160);
    expect(brand?.height, `${language} brand height`).toBeLessThanOrEqual(220);
    const email = page.getByRole('textbox', { name: language === 'en' ? '1. Email' : '1. 이메일' });
    await expect(email).toBeVisible();
    if (language === 'en') {
      await expect(login.locator('.hej-copy')).not.toContainText(/[가-힣]/);
    }
    const send = page.getByRole('button', { name: language === 'en' ? 'Send code' : '인증번호 전송' });
    await expect(send).toBeVisible();
    const touch = await send.boundingBox();
    expect(touch?.height, `${language} send button height`).toBeGreaterThanOrEqual(44);
    expect(touch?.width, `${language} send button width`).toBeGreaterThanOrEqual(44);
    const loginContrast = await login.evaluate((root) => {
      const parse = (value: string): number[] | null => {
        const match = value.match(/rgba?\(([^)]+)\)/);
        if (!match?.[1]) {
          return null;
        }
        const channels = match[1].split(/[,\s/]+/).filter(Boolean).map(Number);
        return [channels[0], channels[1], channels[2], channels[3] ?? 1];
      };
      const compose = (foreground: number[], background: number[]) => foreground.slice(0, 3)
        .map((channel, index) => channel * (foreground[3] ?? 1) + background[index] * (1 - (foreground[3] ?? 1)));
      const luminance = (color: number[]) => color.slice(0, 3).map((channel) => {
        const value = channel / 255;
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
      }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
      return ['.hej-note', '.hej-copy', '.hej-pill'].map((selector) => {
        const element = root.querySelector(selector) as HTMLElement;
        const chain: HTMLElement[] = [];
        for (let current: HTMLElement | null = element; current; current = current.parentElement) {
          chain.unshift(current);
        }
        let background: number[] = [255, 255, 255];
        for (const current of chain) {
          const color = parse(getComputedStyle(current).backgroundColor);
          if (color) {
            background = compose(color, background);
          }
        }
        const foregroundCss = getComputedStyle(element).color;
        const foreground = compose(parse(foregroundCss) ?? [0, 0, 0, 1], background);
        const light = luminance(foreground);
        const dark = luminance(background);
        return { selector, foreground: foregroundCss, background: background.map(Math.round).join(','),
          ratio: (Math.max(light, dark) + 0.05) / (Math.min(light, dark) + 0.05) };
      });
    });
    for (const sample of loginContrast) {
      expect(sample.ratio, `${language}/${theme} ${sample.selector} foreground=${sample.foreground} background=${sample.background}`)
        .toBeGreaterThanOrEqual(4.5);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.screenshot({ path: path.join(screenshotDirectory, `${language}-${theme}-375-login.png`), fullPage: true });
  }
});
