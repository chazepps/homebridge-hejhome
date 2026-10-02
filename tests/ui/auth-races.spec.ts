import { build } from 'esbuild';
import { expect, test } from '@playwright/test';
import { installUiHost, requestCalls } from './host-fixture.js';

// Build in memory so these race tests exercise source without rewriting shipped artifacts.
const built = await build({ entryPoints: ['homebridge-ui/src/main.tsx'], bundle: true, write: false,
  outdir: '/tmp/hejhome-auth-races', format: 'iife', jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"', __PLUGIN_VERSION__: '"test"' },
  loader: { '.png': 'dataurl', '.svg': 'dataurl' } });
const source = '<style>' + built.outputFiles.find((file) => file.path.endsWith('.css'))!.text.replace(/<\/style/gi, '<\\/style')
  + '</style><div id="hej-settings-root"></div><script>'
  + built.outputFiles.find((file) => file.path.endsWith('.js'))!.text.replace(/<\/script/gi, '<\\/script') + '</script>';

for (const acknowledgementDelay of [0, 80]) {
  test(`login reaches settings when its revision event precedes its ACK (${acknowledgementDelay}ms)`, async ({ page }) => {
    await installUiHost(page, { status: { configured: false, sessionValid: false, uiSessionRevision: 'unconfigured' },
      diagnostics: { uiSessionRevision: 'unconfigured', connection: { session: 'missing', realtime: 'disconnected' } } });
    await page.evaluate((acknowledgementDelay) => {
      const request = window.homebridge.request;
      let signedIn = false;
      window.homebridge.request = async (route, payload) => {
        const response = await request(route, payload);
        if (route === '/login') {
          signedIn = true;
          window.__hejHost.status.uiSessionRevision = 'signed-in';
          window.__hejHost.diagnostics.uiSessionRevision = 'signed-in';
          window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
          await new Promise((resolve) => setTimeout(resolve, acknowledgementDelay));
          return { ...response as object, uiSessionRevision: 'signed-in' };
        }
        if (route === '/session-status' && signedIn) {
          await new Promise((resolve) => setTimeout(resolve, acknowledgementDelay ? 30 : 90));
        }
        return response;
      };
    }, acknowledgementDelay);
    await page.setContent(source);
    await page.getByLabel('이메일').fill('user@example.test');
    await page.getByRole('button', { name: '인증번호 전송', exact: true }).click();
    await page.getByLabel('6자리 인증번호 입력').fill('123456');
    await page.getByRole('button', { name: '확인', exact: true }).click();
    await page.getByLabel('비밀번호').fill('test-password');
    await page.getByRole('button', { name: '로그인', exact: true }).click();
    await expect(page.getByRole('button', { name: '장치', exact: true })).toHaveAttribute('aria-current', 'page');
    await expect(page.locator('#loginView')).toBeHidden();
    expect(await requestCalls(page, '/login')).toHaveLength(1);
    expect(await page.evaluate(() => window.__hejHost.toasts.some((toast) => toast.message === 'Hejhome 로그인이 저장되었습니다.'))).toBe(true);
  });
}

test('runtime push bursts keep cloud status reads flat and changed discovery refreshes scope', async ({ page }) => {
  await installUiHost(page);
  await page.setContent(source);
  await expect(page.getByRole('button', { name: '장치', exact: true })).toBeVisible();
  await expect.poll(async () => (await requestCalls(page, '/diagnostics')).length).toBeGreaterThan(0);
  await page.evaluate(async () => {
    for (let index = 0; index < 30; index++) {
      window.__hejHost.diagnostics.updatedAt = new Date().toISOString();
      window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  });
  expect(await requestCalls(page, '/session-status')).toHaveLength(1);
  await page.evaluate(() => {
    window.__hejHost.status.scopeOptions = { complete: true, families: [{ familyId: 1, name: '새 집', rooms: [] }] };
    window.__hejHost.diagnostics.generatedAt = new Date(Date.now() + 1_000).toISOString();
    window.homebridge.dispatchEvent(new Event('hejhome-status-changed'));
  });
  await expect.poll(async () => (await requestCalls(page, '/session-status')).length).toBe(2);
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByText('새 집', { exact: true })).toBeVisible();
});
