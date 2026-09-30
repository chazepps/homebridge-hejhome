import fs from 'node:fs';
import { expect, test } from '@playwright/test';
import { mountUi, openDevice } from './host-fixture.js';

const source = fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');

async function openSignedInSettings(page: import('@playwright/test').Page, language = 'ko', theme = 'light', width = 1200) {
  await page.setViewportSize({ width, height: 800 });
  await page.evaluate(({ language, theme }) => {
    window.homebridge = {
      i18nCurrentLang: async () => language,
      userCurrentLightingMode: async () => theme,
      request: async (route) => {
        if (route === '/session-status') {
          return { configured: true, sessionValid: true,
            features: { matter: false, adaptiveLighting: false, meters: [] }, scope: { mode: 'first-family' },
            supportedModels: [] };
        }
        if (route === '/diagnostics') {
          return { controlsAvailable: false, connection: { session: 'valid', realtime: 'connected' }, devices: [] };
        }
        return {};
      },
      getCachedAccessories: async () => [], getCachedMatterAccessories: async () => [],
      toast: { success() {}, error() {} }, hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
    };
  }, { language, theme });
  await page.setContent(source);
}

test('signed-in settings expose three keyboard-operable tabs with one selected panel', async ({ page }) => {
  await openSignedInSettings(page);
  const tabs = page.getByRole('tablist').getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(0)).toHaveAccessibleName('내 장치');
  await expect(tabs.nth(1)).toHaveAccessibleName('연결 설정');
  await expect(tabs.nth(2)).toHaveAccessibleName('도움말');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toHaveAttribute('tabindex', '0');
  await expect(tabs.nth(1)).toHaveAttribute('tabindex', '-1');
  await expect(page.getByRole('tabpanel', { includeHidden: false })).toHaveCount(1);

  await tabs.nth(0).focus();
  await page.keyboard.press('End');
  await expect(tabs.nth(2)).toBeFocused();
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowLeft');
  await expect(tabs.nth(2)).toBeFocused();
  await page.keyboard.press('Home');
  await expect(tabs.nth(0)).toBeFocused();
});

test('mobile primary navigation fits the viewport and its touch targets reach 44px', async ({ page }) => {
  await openSignedInSettings(page, 'ko', 'light', 375);
  const tabs = page.getByRole('tablist').getByRole('tab');
  await expect(tabs).toHaveCount(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  for (const tab of await tabs.all()) {
    const box = await tab.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

test('English tabs and device filters have accessible names and a usable focus order', async ({ page }) => {
  await mountUi(page, { language: 'en', devices: [{ id: 'tv-1', name: 'Living room TV', deviceType: 'IrTv' }] });
  const tabs = page.getByRole('tablist').getByRole('tab');
  await expect(tabs).toHaveCount(3);
  for (const [index, name] of ['My devices', 'Connection settings', 'Help'].entries()) {
    await expect(tabs.nth(index)).toHaveAccessibleName(name);
  }
  const search = page.getByRole('searchbox', { name: 'Search devices' });
  const filter = page.getByRole('combobox', { name: 'Device filter' });
  await expect(search).toBeVisible();
  await expect(filter).toBeVisible();
  await tabs.nth(0).focus();
  await page.keyboard.press('Tab');
  await expect(search).toBeFocused();
});

test('all three mobile panels avoid overflow and visible form controls have labels', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mountUi(page, { language: 'ko', devices: [{ id: 'tv-1', name: '거실 TV', deviceType: 'IrTv' }] });
  for (const tab of await page.getByRole('tablist').getByRole('tab').all()) {
    await tab.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const box = await tab.boundingBox();
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
  const unnamed = await page.locator('input, select, textarea').evaluateAll((controls) => controls
    .filter((control) => control instanceof HTMLElement && control.getClientRects().length > 0)
    .filter((control) => {
      const element = control as HTMLInputElement;
      return !element.labels?.length && !element.getAttribute('aria-label') && !element.getAttribute('aria-labelledby');
    }).map((control) => (control as HTMLElement).outerHTML.slice(0, 120)));
  expect(unnamed).toEqual([]);
});

test('reduced-motion preference removes decorative transitions without hiding focus', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mountUi(page, { language: 'ko' });
  const tab = page.getByRole('tab', { name: '내 장치' });
  await tab.focus();
  await expect(tab).toBeFocused();
  const durations = await tab.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.transitionDuration, style.animationDuration].flatMap((value) => value.split(',').map((part) => {
      const text = part.trim();
      return text.endsWith('ms') ? parseFloat(text) : parseFloat(text) * 1000;
    }));
  });
  expect(Math.max(...durations)).toBeLessThanOrEqual(1);
});

test('mobile device detail and sign-in expose labelled fields and usable buttons', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mountUi(page, { language: 'ko', devices: [{ id: 'tv-1', name: '거실 TV', deviceType: 'IrTv' }] });
  await openDevice(page, 'tv-1');
  await expect(page.getByRole('button', { name: '장치 목록으로' })).toBeVisible();
  for (const button of await page.locator('[data-testid="device-detail"] button:visible').all()) {
    const box = await button.boundingBox();
    expect(box?.height, await button.textContent()).toBeGreaterThanOrEqual(44);
    expect(box?.width, await button.textContent()).toBeGreaterThanOrEqual(44);
  }
  const unnamedDetailInputs = await page.locator('[data-testid="device-detail"] input:visible, [data-testid="device-detail"] select:visible')
    .evaluateAll((elements) => elements.filter((element) => {
      const control = element as HTMLInputElement;
      return !control.labels?.length && !control.getAttribute('aria-label') && !control.getAttribute('aria-labelledby');
    }).map((element) => (element as HTMLElement).outerHTML.slice(0, 120)));
  expect(unnamedDetailInputs).toEqual([]);

  await mountUi(page, { language: 'en', theme: 'dark', status: { configured: false, sessionValid: false } });
  await expect(page.getByRole('tablist')).toBeHidden();
  const email = page.getByRole('textbox', { name: 'Email' });
  await expect(email).toBeVisible();
  const firstButton = page.getByRole('button', { name: 'Send code' });
  await expect(firstButton).toBeVisible();
  const box = await firstButton.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await email.focus();
  await expect(email).toBeFocused();
});
