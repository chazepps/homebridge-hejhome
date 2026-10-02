import { expect, test, type Locator } from '@playwright/test';
import { mountUi, openAccountActions, openDevice, requestCalls, respondToConfirmation } from './host-fixture.js';

const navigation = (page: import('@playwright/test').Page) => page.getByRole('navigation', { name: /설정 탐색|Settings navigation/ });

async function expectLabelledControls(root: import('@playwright/test').Locator) {
  const controls = root.locator('input:not([aria-hidden="true"]):visible, textarea:visible, '
    + '[role="combobox"]:visible, [role="switch"]:visible, [role="checkbox"]:visible');
  for (const control of await controls.all()) {
    await expect(control).toHaveAccessibleName(/.+/);
  }
}

async function expectSwitchTouchTarget(control: Locator, root: Locator) {
  const visual = await control.boundingBox();
  const label = root.locator(`label[for="${await control.getAttribute('id')}"]`);
  const box = await label.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  expect(box?.width).toBeGreaterThanOrEqual(44);
  const points = [[4, 4], [box!.width - 4, 4], [4, box!.height - 4], [box!.width - 4, box!.height - 4]];
  const point = points.find(([x, y]) => box!.x + x < visual!.x || box!.x + x > visual!.x + visual!.width
    || box!.y + y < visual!.y || box!.y + y > visual!.y + visual!.height);
  expect(point, 'The linked label exposes a real hit target outside the visual switch track').toBeDefined();
  const checked = await control.isChecked();
  await label.click({ position: { x: point![0], y: point![1] } });
  await expect(control).toBeChecked({ checked: !checked });
  await label.click({ position: { x: point![0], y: point![1] } });
  await expect(control).toBeChecked({ checked });
}

test('signed-in settings expose four keyboard-operable destinations with one current region', async ({ page }) => {
  await mountUi(page);
  const destinations = navigation(page).getByRole('button');
  await expect(destinations).toHaveCount(4);
  for (const [index, name] of ['장치', '연결', '전력', '도움말'].entries()) {
    await expect(destinations.nth(index)).toHaveAccessibleName(name);
  }
  await expect(destinations.nth(0)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('region', { name: '장치', exact: true })).toBeVisible();
  await destinations.nth(0).focus();
  for (const [index, name] of ['연결', '전력', '도움말'].entries()) {
    await page.keyboard.press('Tab');
    await expect(destinations.nth(index + 1)).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(destinations.nth(index + 1)).toHaveAttribute('aria-current', 'page');
    await expect(navigation(page).locator('[aria-current="page"]')).toHaveCount(1);
    await expect(page.getByRole('region', { name, exact: true })).toBeVisible();
    await expect(page.getByRole('region', { name: '장치', exact: true })).toBeHidden();
  }
  await page.keyboard.press('Shift+Tab');
  await expect(destinations.nth(2)).toBeFocused();
  await page.keyboard.press('Space');
  await expect(destinations.nth(2)).toHaveAttribute('aria-current', 'page');
});

test('mobile primary navigation fits the viewport and its touch targets reach 44px', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mountUi(page);
  const destinations = navigation(page).getByRole('button');
  await expect(destinations).toHaveCount(4);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
  for (const destination of await destinations.all()) {
    const box = await destination.boundingBox();
    expect(box?.width).toBeGreaterThanOrEqual(44);
    expect(box?.height).toBeGreaterThanOrEqual(44);
  }
});

test('English navigation and Radix device filters have accessible names and keyboard operation', async ({ page }) => {
  await mountUi(page, { language: 'en', devices: [{ id: 'tv-1', name: 'Living room TV', deviceType: 'IrTv' }] });
  const destinations = navigation(page).getByRole('button');
  await expect(destinations).toHaveCount(4);
  for (const [index, name] of ['Devices', 'Connections', 'Power', 'Help'].entries()) {
    await expect(destinations.nth(index)).toHaveAccessibleName(name);
  }
  const search = page.getByRole('textbox', { name: 'Search devices' });
  const filter = page.getByRole('radiogroup', { name: 'Device filter' });
  await expect(search).toBeVisible();
  await expect(filter).toBeVisible();
  await search.focus();
  await page.keyboard.press('Tab');
  await expect(filter.getByRole('radio', { name: 'All', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  const attention = filter.getByRole('radio', { name: 'Needs attention', exact: true });
  await expect(attention).toBeFocused();
  await page.keyboard.press('Space');
  await expect(attention).toBeChecked();
  await page.keyboard.press('ArrowLeft');
  await expect(filter.getByRole('radio', { name: 'All', exact: true })).toBeFocused();
  await page.keyboard.press('Space');
  await expect(filter.getByRole('radio', { name: 'All', exact: true })).toBeChecked();
  await openDevice(page, 'tv-1');
  const connection = page.getByTestId('device-detail').getByRole('combobox', { name: 'Connections' });
  await connection.focus();
  await page.keyboard.press('Space');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toBeHidden();
  await expect(connection).toBeFocused();
});

test('all four mobile destinations avoid overflow and visible form controls have labels', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mountUi(page, { devices: [{ id: 'tv-1', name: '거실 TV', deviceType: 'IrTv' }] });
  for (const destination of await navigation(page).getByRole('button').all()) {
    await destination.click();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(375);
    const settings = page.locator('#settingsView');
    await expectLabelledControls(settings);
    for (const control of await settings.getByRole('switch').all()) {
      await expectSwitchTouchTarget(control, settings);
    }
  }
});

test('reduced-motion preference removes decorative transitions without hiding focus', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await mountUi(page);
  const destination = navigation(page).getByRole('button', { name: '장치', exact: true });
  await destination.focus();
  await expect(destination).toBeFocused();
  const durations = await destination.evaluate((element) => {
    const style = getComputedStyle(element);
    return [style.transitionDuration, style.animationDuration].flatMap((value) => value.split(',').map((part) => {
      const text = part.trim();
      return text.endsWith('ms') ? parseFloat(text) : parseFloat(text) * 1000;
    }));
  });
  expect(Math.max(...durations)).toBeLessThanOrEqual(1);
});

test('mobile device inspector and sign-in expose labelled fields and usable buttons', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await mountUi(page, { devices: [{ id: 'tv-1', name: '거실 TV', deviceType: 'IrTv' }] });
  await openDevice(page, 'tv-1');
  await expect(page.getByRole('button', { name: '장치 목록으로', exact: true })).toBeVisible();
  const detail = page.getByTestId('device-detail');
  for (const button of await detail.locator('button:visible').all()) {
    if (await button.getAttribute('role') === 'switch') {
      await expectSwitchTouchTarget(button, detail);
    } else {
      const box = await button.boundingBox();
      expect(box?.height, await button.textContent()).toBeGreaterThanOrEqual(44);
      expect(box?.width, await button.textContent()).toBeGreaterThanOrEqual(44);
    }
  }
  await expectLabelledControls(detail);

  await mountUi(page, { language: 'en', theme: 'dark', status: { configured: false, sessionValid: false } });
  for (const destination of await navigation(page).getByRole('button').all()) {
    await expect(destination).toBeDisabled();
  }
  const email = page.getByRole('textbox', { name: /Email/ });
  await expect(email).toBeVisible();
  const firstButton = page.getByRole('button', { name: 'Send code', exact: true });
  await expect(firstButton).toBeVisible();
  const box = await firstButton.boundingBox();
  expect(box?.height).toBeGreaterThanOrEqual(44);
  await email.focus();
  await expect(email).toBeFocused();
  await expectLabelledControls(page.locator('#loginView'));
});

test('dirty confirmation traps keyboard focus, Escape keeps edits, and returns focus to the initiating action', async ({ page }) => {
  await mountUi(page);
  await navigation(page).getByRole('button', { name: '연결', exact: true }).click();
  const matter = page.getByRole('switch', { name: 'Matter 연결', exact: true });
  await matter.focus();
  await page.keyboard.press('Space');
  await expect(matter).toBeChecked();
  await openAccountActions(page);
  const logout = page.getByRole('button', { name: '로그아웃', exact: true });
  await logout.click();
  const dialog = page.getByRole('alertdialog', { name: '로그아웃', exact: true });
  const cancel = dialog.getByRole('button', { name: '취소', exact: true });
  const discard = dialog.getByRole('button', { name: '변경사항 버리기', exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(discard).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(logout).toBeFocused();
  await expect(matter).toBeChecked();
  expect(await requestCalls(page, '/logout')).toHaveLength(0);
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
  await page.evaluate(() => {
    window.homebridge.closeSettings = () => window.__hejHost.calls.push({ route: 'host.closeSettings', payload: null });
  });
  const close = page.getByRole('button', { name: '설정 닫기', exact: true });
  await close.click();
  await expect(page.getByRole('alertdialog', { name: '설정 닫기', exact: true })).toBeVisible();
  await respondToConfirmation(page, 'cancel');
  await expect(close).toBeFocused();
  await expect(matter).toBeChecked();
  expect(await requestCalls(page, 'host.closeSettings')).toHaveLength(0);
});
