import fs from 'node:fs';
import path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { mountUi, openDevice } from './host-fixture.js';

const screenshotDirectory = path.resolve('.superpowers/sdd/2026-10-02-radix-settings/screenshots');
fs.mkdirSync(screenshotDirectory, { recursive: true });

const devices = [
  { id: 'tv-living', name: '거실 TV', deviceType: 'IrTv', lastControl: 'unknown' },
  { id: 'sensor-living', name: '거실 온습도', deviceType: 'SensorTh', online: false, lastControl: 'unknown' },
];

async function expectReadableText(root: Locator, context: string) {
  const samples = await root.evaluate((element) => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const drawing = canvas.getContext('2d', { willReadFrequently: true })!;
    const rgba = (value: string) => {
      drawing.clearRect(0, 0, 1, 1);
      drawing.fillStyle = value;
      drawing.fillRect(0, 0, 1, 1);
      const channels = [...drawing.getImageData(0, 0, 1, 1).data];
      return [channels[0], channels[1], channels[2], channels[3] / 255];
    };
    const over = (foreground: number[], background: number[]) => foreground.slice(0, 3)
      .map((channel, index) => channel * foreground[3] + background[index] * (1 - foreground[3]));
    const luminance = (color: number[]) => color.slice(0, 3).map((channel) => {
      const value = channel / 255;
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
    const textElements = [...element.querySelectorAll<HTMLElement>('*')].filter((node) =>
      node.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) && !node.closest('[disabled], [aria-disabled="true"], svg, script, style')
      && [...node.childNodes].some((child) => child.nodeType === Node.TEXT_NODE && child.textContent?.trim()));
    return textElements.map((node) => {
      const chain: HTMLElement[] = [];
      for (let current: HTMLElement | null = node; current; current = current.parentElement) {
        chain.unshift(current);
      }
      let background: number[] = [255, 255, 255];
      for (const current of chain) {
        background = over(rgba(getComputedStyle(current).backgroundColor), background);
      }
      const style = getComputedStyle(node);
      const foreground = luminance(over(rgba(style.color), background));
      const backdrop = luminance(background);
      const size = parseFloat(style.fontSize);
      const largeText = size >= 24 || size >= 18.66 && parseInt(style.fontWeight, 10) >= 700;
      return { text: node.textContent?.trim().slice(0, 60), minimum: largeText ? 3 : 4.5,
        ratio: (Math.max(foreground, backdrop) + 0.05) / (Math.min(foreground, backdrop) + 0.05) };
    });
  });
  expect(samples.length, `${context} visible text samples`).toBeGreaterThan(0);
  expect(samples.filter(sample => sample.ratio < sample.minimum), `${context} text below WCAG AA contrast`).toEqual([]);
}

for (const language of ['ko', 'en'] as const) {
  for (const theme of ['light', 'dark'] as const) {
    for (const width of [375, 1200]) {
      test(`${language} ${theme} ${width}px settings stay readable`, async ({ page }) => {
        await page.setViewportSize({ width, height: 800 });
        await mountUi(page, { language, theme, devices });
        await expect(page.locator('html')).toHaveAttribute('data-hej-theme', theme);
        const navigation = page.getByRole('navigation', { name: /설정 탐색|Settings navigation/ });
        await expect(navigation.getByRole('button')).toHaveCount(4);
        await expect(navigation.getByRole('button', { name: language === 'en' ? 'Devices' : '장치', exact: true }))
          .toHaveAttribute('aria-current', 'page');
        await expect(page.getByTestId('device-row')).toHaveCount(2);
        await page.screenshot({ animations: 'disabled', path: path.join(screenshotDirectory, `${language}-${theme}-${width}.png`), fullPage: true });
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
        await expectReadableText(page.locator('#settingsView'), `${language}/${theme}/${width} Devices`);

        for (const name of language === 'en' ? ['Connections', 'Power', 'Help'] : ['연결', '전력', '도움말']) {
          await navigation.getByRole('button', { name, exact: true }).click();
          expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
          const panel = page.getByRole('region', { name, exact: true });
          await expect(panel).toBeVisible();
          await page.screenshot({ animations: 'disabled', path: path.join(screenshotDirectory, `${language}-${theme}-${width}-${name}.png`), fullPage: true });
          await expectReadableText(panel, `${language}/${theme}/${width} ${name}`);
          // Keep indexes stable as each disclosure changes its open attribute.
          for (const disclosure of await panel.locator('details').all()) {
            const summary = disclosure.locator(':scope > summary');
            if (await summary.isVisible() && await disclosure.getAttribute('open') === null) {
              await summary.click();
            }
          }
          await page.screenshot({ animations: 'disabled',
            path: path.join(screenshotDirectory, `${language}-${theme}-${width}-${name}-expanded.png`), fullPage: true });
          await expectReadableText(panel, `${language}/${theme}/${width} ${name} expanded`);
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
  await expect(page.getByTestId('device-detail')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ animations: 'disabled', path: path.join(screenshotDirectory, 'ko-light-375-detail.png'), fullPage: true });

  await page.setViewportSize({ width: 1200, height: 800 });
  await mountUi(page, { language: 'ko', theme: 'light', devices });
  for (const [name, file] of [['연결', 'connections'], ['전력', 'power'], ['도움말', 'help']]) {
    await page.getByRole('navigation', { name: '설정 탐색' }).getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
    await page.screenshot({ animations: 'disabled', path: path.join(screenshotDirectory, `ko-light-1200-${file}.png`), fullPage: true });
  }
  await page.setViewportSize({ width: 375, height: 800 });
  await mountUi(page, { language: 'en', theme: 'dark', status: { configured: false, sessionValid: false } });
  for (const destination of await page.getByRole('navigation', { name: 'Settings navigation' }).getByRole('button').all()) {
    await expect(destination).toBeDisabled();
  }
  await expect(page.locator('#loginView')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  await page.screenshot({ animations: 'disabled', path: path.join(screenshotDirectory, 'en-dark-375-login.png'), fullPage: true });
});

test('mobile sign-in starts at an immediately usable email step with readable text', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  for (const [language, theme] of [['en', 'dark'], ['ko', 'light']] as const) {
    await mountUi(page, { language, theme, status: { configured: false, sessionValid: false } });
    const login = page.locator('#loginView');
    await expect(login).toBeVisible();
    const email = page.getByRole('textbox', { name: language === 'en' ? /Email/ : /이메일/ });
    await expect(email).toBeInViewport();
    if (language === 'en') {
      await expect(login).not.toContainText(/[가-힣]/);
    }
    const send = page.getByRole('button', { name: language === 'en' ? 'Send code' : '인증번호 전송', exact: true });
    await expect(send).toBeInViewport();
    const touch = await send.boundingBox();
    expect(touch?.height).toBeGreaterThanOrEqual(44);
    expect(touch?.width).toBeGreaterThanOrEqual(44);
    await expectReadableText(login, `${language}/${theme} login`);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    await page.screenshot({ animations: 'disabled', path: path.join(screenshotDirectory, `${language}-${theme}-375-login.png`), fullPage: true });
  }
});
