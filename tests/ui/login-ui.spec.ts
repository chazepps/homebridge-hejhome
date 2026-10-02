import fs from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { mountUi, openAccountActions, requestCalls } from './host-fixture.js';

const source = fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');
async function verifyEmail(page: Page) {
  await page.getByLabel('이메일').fill('user@example.test');
  await page.getByRole('button', { name: '인증번호 전송', exact: true }).click();
  await page.getByLabel('6자리 인증번호 입력').fill('123456');
  await page.getByRole('button', { name: '확인', exact: true }).click();
}
const families = [{ familyId: 101, name: '첫 번째 집', selected: true, rooms: [
  { roomId: 1, name: '거실', selected: true }, { roomId: 2, name: '주방', selected: true },
] }];

test('custom UI obeys iframe rules and only enables the next verified authentication step', async ({ page }) => {
  expect(source.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')).not.toMatch(/<(?:html|head|body)(?:\s|>)/i);
  await mountUi(page, { status: { configured: false, sessionValid: false } });
  const login = page.locator('#loginView');
  await expect(login.getByRole('heading', { name: 'Hejhome' })).toBeVisible();
  await expect(page.getByLabel('비밀번호')).toBeDisabled();
  await expect(page.locator('#login')).toBeDisabled();
  await expect(page.locator('#verifyCode')).toBeDisabled();
  await page.getByLabel('이메일').fill('user@example.test');
  await page.getByRole('button', { name: '인증번호 전송', exact: true }).click();
  await expect(page.getByLabel('6자리 인증번호 입력')).toBeEnabled();
  await expect(page.getByLabel('비밀번호')).toBeDisabled();
  await page.getByLabel('6자리 인증번호 입력').fill('123');
  await expect(page.locator('#verifyCode')).toBeDisabled();
  await page.getByLabel('6자리 인증번호 입력').fill('123456');
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await expect(page.getByLabel('6자리 인증번호 입력')).toBeDisabled();
  await expect(page.getByLabel('비밀번호')).toBeEnabled();
  await expect(page.locator('#login')).toBeDisabled();
  await page.getByLabel('비밀번호').fill('not-stored-password');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('button', { name: '장치', exact: true })).toHaveAttribute('aria-current', 'page');
  const authCalls = await page.evaluate(() => window.__hejHost.calls.filter((call) =>
    ['/send-verification', '/verify-code', '/login'].includes(call.route)));
  expect(authCalls.map((call) => call.route)).toEqual(['/send-verification', '/verify-code', '/login']);
  expect(authCalls[0]?.payload).toMatchObject({ identifier: 'user@example.test' });
  expect(authCalls[1]?.payload).toEqual({ identifier: 'user@example.test', authCode: '123456' });
  expect(authCalls[2]?.payload).toEqual({ identifier: 'user@example.test', password: 'not-stored-password', autoLogin: true });
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
  expect(await requestCalls(page, '/save-device-settings')).toHaveLength(0);
});

test('phone identifiers are rejected before any verification request', async ({ page }) => {
  await mountUi(page, { status: { configured: false, sessionValid: false } });
  await page.getByLabel('이메일').fill('010-1234-5678');
  await page.getByRole('button', { name: '인증번호 전송' }).click();
  await expect(page.locator('#loginStatus')).toContainText('이메일 로그인만 지원');
  expect(await requestCalls(page, '/send-verification')).toHaveLength(0);
});

test('verification and password failures keep the current step retryable', async ({ page }) => {
  await mountUi(page, { status: { configured: false, sessionValid: false } });
  await page.getByLabel('이메일').fill('user@example.test');
  await page.getByRole('button', { name: '인증번호 전송' }).click();
  await page.getByLabel('6자리 인증번호 입력').fill('123456');
  await page.evaluate(() => {
    window.__hejHost.failNext['/verify-code'] = '인증번호를 확인해 주세요';
  });
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await expect(page.getByLabel('비밀번호')).toBeDisabled();
  await expect(page.getByRole('button', { name: '확인', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await page.getByLabel('비밀번호').fill('bad-password');
  await page.evaluate(() => {
    window.__hejHost.failNext['/login'] = '비밀번호를 확인해 주세요';
  });
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('button', { name: '로그인', exact: true })).toBeEnabled();
  await expect(page.getByLabel('비밀번호')).toHaveValue('bad-password');
  await page.getByLabel('비밀번호').fill('corrected-password');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.getByRole('button', { name: '장치', exact: true })).toBeVisible();
  expect(await requestCalls(page, '/verify-code')).toHaveLength(2);
  expect(await requestCalls(page, '/login')).toHaveLength(2);
});

test('changing the verified email invalidates the code and password step', async ({ page }) => {
  await mountUi(page, { status: { configured: false, sessionValid: false } });
  await verifyEmail(page);
  await page.getByLabel('비밀번호').fill('discarded-password');
  await page.getByLabel('이메일').fill('other@example.test');
  await expect(page.getByLabel('비밀번호')).toHaveValue('');
  await expect(page.getByLabel('비밀번호')).toBeDisabled();
  await expect(page.locator('#login')).toBeDisabled();
});

test('a valid session starts at devices and account actions live in connection settings', async ({ page }) => {
  await mountUi(page);
  await expect(page.getByRole('button', { name: '장치', exact: true })).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#loginView')).toBeHidden();
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeHidden();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.locator('#sessionBadge')).toContainText('로그인 정상');
  await openAccountActions(page);
  await page.getByRole('button', { name: '로그아웃', exact: true }).click();
  await expect(page.getByLabel('이메일')).toBeVisible();
  expect(await requestCalls(page, '/logout')).toHaveLength(1);
});

for (const rooms of [[1], []]) {
  test(`scope saves ${rooms.length ? 'a room subset' : 'an intentionally empty room selection'} through the server with its edit token`, async ({ page }) => {
    await mountUi(page, { status: { scopeOptions: { complete: true, families } } });
    await page.getByRole('button', { name: '연결', exact: true }).click();
    await page.getByLabel('주방', { exact: true }).uncheck();
    if (!rooms.length) {
      await page.getByLabel('거실', { exact: true }).uncheck();
    }
    await page.getByRole('button', { name: '집/방 설정 저장', exact: true }).click();
    await expect(page.locator('#scopeStatus')).toContainText(/저장/);
    expect((await requestCalls(page, '/save-scope')).at(-1)?.payload).toEqual({ scopeEditToken: 'scope-edit-ticket-1', scope: {
      mode: 'custom', includedFamilyIds: [101], includedRoomsByFamilyId: { '101': rooms },
    } });
    await expect(page.getByLabel('주방', { exact: true })).not.toBeChecked();
  });
}

test('incomplete home or room discovery cannot overwrite the saved scope', async ({ page }) => {
  await mountUi(page, { status: { scopeEditToken: null, scopeOptions: { complete: false, families }, scope: { mode: 'all' } } });
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.getByRole('button', { name: '집/방 설정 저장', exact: true })).toBeDisabled();
  expect(await requestCalls(page, '/save-scope')).toHaveLength(0);
});

test('partial discovery during an existing scope edit preserves unavailable room choices until complete refresh', async ({ page }) => {
  await mountUi(page, { status: { scopeOptions: { complete: true, families } } });
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByRole('checkbox', { name: '주방', exact: true }).uncheck();
  await page.evaluate(() => {
    window.__hejHost.status.scopeEditToken = null;
    window.__hejHost.status.scopeOptions = { complete: false, families: [
      { familyId: 101, name: '첫 번째 집', rooms: [{ roomId: 1, name: '거실' }] },
    ] };
  });
  await page.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  await expect(page.locator('#saveScope')).toBeDisabled();
  expect(await requestCalls(page, '/save-scope')).toHaveLength(0);
  await page.evaluate((families) => {
    window.__hejHost.status.scopeEditToken = 'scope-refreshed';
    window.__hejHost.status.scopeOptions = { complete: true, families };
  }, families);
  await page.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: '거실', exact: true })).toBeChecked();
  await expect(page.getByRole('checkbox', { name: '주방', exact: true })).not.toBeChecked();
  await page.locator('#saveScope').click();
  await expect.poll(async () => (await requestCalls(page, '/save-scope')).at(-1)?.payload).toEqual({
    scopeEditToken: 'scope-refreshed', scope: { mode: 'custom', includedFamilyIds: [101], includedRoomsByFamilyId: { '101': [1] } },
  });
});

test('a concurrent saved scope cannot be overwritten by adopting its new token into an older local draft', async ({ page }) => {
  await mountUi(page, { status: { scopeOptions: { complete: true, families } } });
  await page.getByRole('button', { name: '연결', exact: true }).click();
  const living = page.getByRole('checkbox', { name: '거실', exact: true });
  const kitchen = page.getByRole('checkbox', { name: '주방', exact: true });
  await living.uncheck();
  await page.evaluate(() => {
    window.__hejHost.status.scopeEditToken = 'scope-other-window';
    window.__hejHost.status.scope = { mode: 'custom', includedFamilyIds: [101], includedRoomsByFamilyId: { '101': [1] } };
  });
  await page.getByRole('button', { name: '상태 새로고침', exact: true }).click();
  await expect(page.locator('#scopeStatus')).toContainText('저장은 중지했습니다');
  await expect(living).not.toBeChecked();
  await expect(kitchen).toBeChecked();
  await expect(page.locator('#saveScope')).toBeDisabled();
  expect(await requestCalls(page, '/save-scope')).toHaveLength(0);

  const reset = page.getByRole('button', { name: '최신 설정으로 되돌리기', exact: true });
  await reset.click();
  const confirmation = page.getByRole('alertdialog', { name: '최신 집/방 설정을 불러올까요?', exact: true });
  await confirmation.getByRole('button', { name: '취소', exact: true }).click();
  await expect(confirmation).toBeHidden();
  await expect(living).not.toBeChecked();
  await expect(kitchen).toBeChecked();
  await expect(page.locator('#saveScope')).toBeDisabled();

  await reset.click();
  await confirmation.getByRole('button', { name: '최신 설정 불러오기', exact: true }).click();
  await expect(living).toBeChecked();
  await expect(kitchen).not.toBeChecked();
  await expect(page.locator('#saveScope')).toBeDisabled();
  await living.uncheck();
  await page.locator('#saveScope').click();
  await expect.poll(async () => (await requestCalls(page, '/save-scope')).at(-1)?.payload).toEqual({
    scopeEditToken: 'scope-other-window', scope: { mode: 'custom', includedFamilyIds: [101], includedRoomsByFamilyId: { '101': [] } },
  });
  await expect(page.locator('#scopeStatus')).toContainText('저장했습니다');
  await expect(living).not.toBeChecked();
  await expect(kitchen).not.toBeChecked();
});
