import fs from 'node:fs';
import path from 'node:path';

import { expect, test } from '@playwright/test';

const uiPath = path.resolve(import.meta.dirname, '../../homebridge-ui/public/index.html');
const PIXEL_TOLERANCE = 1.5;

async function expectVerificationButtonOverlay(page, inputSelector: string, buttonSelector: string) {
  const geometry = await page.locator(inputSelector).evaluate((inputElement, selector) => {
    const input = inputElement.getBoundingClientRect();
    const field = inputElement.closest('.hej-field')?.getBoundingClientRect();
    const row = inputElement.closest('.hej-row')?.getBoundingClientRect();
    const button = document.querySelector(selector as string)?.getBoundingClientRect();
    return {
      field: field ? rect(field) : null,
      input: rect(input),
      row: row ? rect(row) : null,
      button: button ? rect(button) : null,
    };

    function rect(value: DOMRect) {
      return {
        bottom: value.bottom,
        height: value.height,
        left: value.left,
        right: value.right,
        top: value.top,
        width: value.width,
      };
    }
  }, buttonSelector);

  expect(geometry.row).not.toBeNull();
  expect(geometry.field).not.toBeNull();
  expect(geometry.button).not.toBeNull();

  const field = geometry.field!;
  const row = geometry.row!;
  const input = geometry.input;
  const button = geometry.button!;

  expect(Math.abs(input.left - row.left)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
  expect(Math.abs(input.right - row.right)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
  expect(Math.abs(input.left - field.left)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
  expect(Math.abs(input.right - field.right)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
  expect(button.left).toBeGreaterThanOrEqual(input.left - PIXEL_TOLERANCE);
  expect(button.right).toBeLessThanOrEqual(input.right + PIXEL_TOLERANCE);
  expect(Math.abs(button.right - input.right)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
  expect(Math.abs(button.top - input.top)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
  expect(Math.abs(button.height - input.height)).toBeLessThanOrEqual(PIXEL_TOLERANCE);
}

test('custom login UI follows Homebridge iframe rules and exposes the sequential email login steps', async ({ page }) => {
  const source = fs.readFileSync(uiPath, 'utf8');
  const requests: string[] = [];

  expect(source).not.toMatch(/<html|<head|<body/i);

  await page.evaluate(() => {
    window.__hejhomeRequests = [];
    window.__hejhomePayloads = [];
    window.homebridge = {
      closeSettings: () => undefined,
      disableSaveButton: () => undefined,
      enableSaveButton: () => undefined,
      hideSpinner: () => undefined,
      request: async (pathName: string, payload: unknown) => {
        window.__hejhomeRequests.push(pathName);
        window.__hejhomePayloads.push({ pathName, payload });
        if (pathName === '/session-status') {
          return {
            configured: false,
            sessionValid: false,
          };
        }
        return { ok: true, pathName, identifier: 'user@example.test' };
      },
      savePluginConfig: async () => undefined,
      showSpinner: () => undefined,
      toast: {
        error: () => undefined,
        info: () => undefined,
        success: () => undefined,
        warning: () => undefined,
      },
      updatePluginConfig: async (config: unknown) => config,
    };
  });
  await page.setContent(source);
  await expect.poll(async () => page.evaluate(() => window.__hejhomeRequests)).toContain('/session-status');

  await expect(page.getByRole('heading', { name: 'Hejhome' })).toBeVisible();
  await expect(page.getByText('for Homebridge')).toBeVisible();
  await expect(page.getByText('앱스토어나 플레이스토어에서 헤이홈 어플을 다운 받아 구체적인 설정을 먼저 마친 뒤, 헤이홈 앱에 등록한 이메일로 로그인해 주세요.')).toBeVisible();
  await expect(page.getByLabel('이메일')).toBeVisible();
  await expect(page.getByRole('button', { name: '인증번호 전송' })).toBeVisible();
  await expect(page.getByLabel('6자리 인증번호 입력')).toBeVisible();
  await expect(page.getByLabel('비밀번호')).toBeVisible();
  await expect(page.getByLabel('자동 로그인')).toBeChecked();
  await expect(page.getByText('이용 정보나 사용 이력은 보관하지 않으며, 타인이나 개발자에게 전달하지 않습니다.')).toBeVisible();
  await expect(page.getByLabel('비밀번호')).toBeDisabled();
  await expect(page.getByRole('button', { name: '로그인' })).toBeDisabled();

  await page.getByLabel('이메일').fill('user@example.test');
  await page.getByRole('button', { name: '인증번호 전송' }).click();
  await expect(page.getByLabel('6자리 인증번호 입력')).toBeEnabled();
  await expect(page.getByRole('button', { name: '확인' })).toBeDisabled();
  await expect(page.getByLabel('비밀번호')).toBeDisabled();
  await expect(page.getByRole('button', { name: '로그인' })).toBeDisabled();

  await page.getByLabel('6자리 인증번호 입력').fill('123456');
  await expect(page.getByRole('button', { name: '확인' })).toBeEnabled();
  await page.getByRole('button', { name: '확인' }).click();
  await expect(page.getByLabel('비밀번호')).toBeEnabled();
  await expect(page.getByLabel('6자리 인증번호 입력')).toBeDisabled();
  await expect(page.getByRole('button', { name: '확인' })).toBeDisabled();
  await expect(page.getByRole('button', { name: '로그인' })).toBeDisabled();

  await page.getByLabel('비밀번호').fill('correct horse battery staple');
  await expect(page.getByRole('button', { name: '로그인' })).toBeEnabled();
  await page.getByRole('button', { name: '로그인' }).click();

  requests.push(...await page.evaluate(() => window.__hejhomeRequests));
  expect(requests.filter((pathName) => pathName !== '/ui-event')).toEqual([
    '/session-status',
    '/send-verification',
    '/verify-code',
    '/login',
    '/session-status',
  ]);
  const payloads = await page.evaluate(() => window.__hejhomePayloads);
  expect(payloads).toEqual(expect.arrayContaining([
    expect.objectContaining({
      pathName: '/ui-event',
      payload: expect.objectContaining({ event: 'login-ui.opened' }),
    }),
  ]));
});

test('custom login UI blocks phone numbers before sending a verification request', async ({ page }) => {
  const source = fs.readFileSync(uiPath, 'utf8');

  await page.evaluate(() => {
    window.__hejhomeRequests = [];
    window.__hejhomeEvents = [];
    window.homebridge = {
      closeSettings: () => undefined,
      disableSaveButton: () => undefined,
      enableSaveButton: () => undefined,
      hideSpinner: () => undefined,
      request: async (pathName: string) => {
        window.__hejhomeRequests.push(pathName);
        if (pathName === '/session-status') {
          return {
            configured: false,
            sessionValid: false,
          };
        }
        return { ok: true };
      },
      savePluginConfig: async () => undefined,
      showSpinner: () => undefined,
      toast: {
        error: (message: string) => window.__hejhomeEvents.push(`error:${message}`),
        info: () => undefined,
        success: () => undefined,
        warning: () => undefined,
      },
      updatePluginConfig: async (config: unknown) => config,
    };
  });
  await page.setContent(source);
  await expect.poll(async () => page.evaluate(() => window.__hejhomeRequests)).toContain('/session-status');

  await page.getByLabel('이메일').fill('010-1234-5678');
  await page.getByRole('button', { name: '인증번호 전송' }).click();

  await expect(page.getByRole('status')).toContainText('현재는 이메일 로그인만 지원합니다');
  await expect.poll(async () => page.evaluate(() => window.__hejhomeRequests)).not.toContain('/send-verification');
  const events = await page.evaluate(() => window.__hejhomeEvents);
  expect(events).toContain('error:현재는 이메일 로그인만 지원합니다. 헤이홈 앱에 등록한 이메일을 입력해 주세요.');
});

test('custom login UI keeps verification action buttons overlaid inside full-width inputs on desktop and mobile', async ({ page }) => {
  const source = fs.readFileSync(uiPath, 'utf8');

  await page.evaluate(() => {
    window.__hejhomeRequests = [];
    window.homebridge = {
      closeSettings: () => undefined,
      disableSaveButton: () => undefined,
      enableSaveButton: () => undefined,
      hideSpinner: () => undefined,
      request: async (pathName: string) => {
        window.__hejhomeRequests.push(pathName);
        if (pathName === '/session-status') {
          return {
            configured: false,
            sessionValid: false,
          };
        }
        return { ok: true };
      },
      savePluginConfig: async () => undefined,
      showSpinner: () => undefined,
      toast: {
        error: () => undefined,
        info: () => undefined,
        success: () => undefined,
        warning: () => undefined,
      },
      updatePluginConfig: async (config: unknown) => config,
    };
  });

  for (const viewport of [
    { width: 1180, height: 900 },
    { width: 390, height: 900 },
  ]) {
    await page.setViewportSize(viewport);
    await page.setContent(source);
    await expect.poll(async () => page.evaluate(() => window.__hejhomeRequests)).toContain('/session-status');

    await expectVerificationButtonOverlay(page, '#identifier', '#sendCode');
    await expectVerificationButtonOverlay(page, '#authCode', '#verifyCode');
  }
});

test('custom config UI shows the settings dashboard instead of the login form for a valid stored session', async ({ page }) => {
  const source = fs.readFileSync(uiPath, 'utf8');

  await page.evaluate(() => {
    window.__hejhomeRequests = [];
    window.__hejhomePayloads = [];
    window.homebridge = {
      closeSettings: () => undefined,
      disableSaveButton: () => undefined,
      enableSaveButton: () => undefined,
      getPluginConfig: async () => [],
      hideSpinner: () => undefined,
      request: async (pathName: string, payload: unknown) => {
        window.__hejhomeRequests.push(pathName);
        window.__hejhomePayloads.push({ pathName, payload });
        if (pathName === '/session-status') {
          return {
            configured: true,
            sessionValid: true,
            sessionCheckStatus: 'valid',
            expiresAtIso: '2026-06-21T12:41:31.692Z',
            refreshRecommendedAtIso: '2026-06-20T12:41:31.692Z',
            deviceSummary: {
              generatedAt: '2026-05-26T01:00:00.000Z',
              registeredCount: 7,
              supportedCount: 6,
              unsupportedCount: 1,
              unsupportedProducts: [
                { deviceType: 'UnknownHeater', modelName: 'Warm Box', count: 1 },
              ],
            },
            supportedModels: [
              { deviceType: 'LightRgbw5', label: 'RGBW 조명', homeKitService: 'Lightbulb', supportStatus: 'supported' },
              { deviceType: 'LedStripRgbw2', label: 'LED 스트립', homeKitService: 'Lightbulb', supportStatus: 'supported' },
              { deviceType: 'RelayController', label: '릴레이 컨트롤러', homeKitService: 'Switch', supportStatus: 'supported' },
              { deviceType: 'SensorMo', label: '모션 센서', homeKitService: 'MotionSensor', supportStatus: 'supported' },
              { deviceType: 'IrTv', label: 'IR TV', homeKitService: 'Switch', supportStatus: 'partial' },
              { deviceType: 'HomeCamera', label: '홈 카메라', homeKitService: 'Camera', supportStatus: 'deferred' },
            ],
            scopeOptions: {
              defaultMode: 'first-family',
              families: [
                {
                  familyId: 101,
                  name: '첫 번째 집',
                  selected: true,
                  rooms: [
                    { roomId: 1, name: '거실', selected: true },
                    { roomId: 2, name: '주방', selected: true },
                  ],
                },
                {
                  familyId: 202,
                  name: '두 번째 집',
                  selected: false,
                  rooms: [
                    { roomId: 3, name: '작은방', selected: false },
                  ],
                },
              ],
            },
            issueTemplate: {
              title: '[Unsupported Device] UnknownHeater / Warm Box',
              body: 'Device type: UnknownHeater\\nModel name: Warm Box',
            },
          };
        }
        if (pathName === '/logout') {
          return { ok: true };
        }
        return { ok: true };
      },
      getPluginConfig: async () => [
        {
          name: 'Hejhome',
          platform: 'Hejhome',
          scope: {
            mode: 'first-family',
          },
        },
      ],
      savePluginConfig: async () => undefined,
      showSpinner: () => undefined,
      toast: {
        error: () => undefined,
        info: () => undefined,
        success: () => undefined,
        warning: () => undefined,
      },
      updatePluginConfig: async (config: unknown) => config,
    };
  });

  await page.setContent(source);
  await expect.poll(async () => page.evaluate(() => window.__hejhomeRequests)).toContain('/session-status');

  await expect(page.getByText('v1에서 v2로 업그레이드되면서 변화가 많습니다. 문제가 있다면 Homebridge 플러그인 메뉴에서 액세서리 초기화를 실행한 뒤 다시 로그인해 주세요.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Hejhome 설정' })).toBeVisible();
  await expect(page.getByText('Homebridge 플러그인 · 개발자 Chaz · 패키지 @chazepps/homebridge-hejhome')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: '로그인 상태' })).toBeVisible();
  await expect(page.getByText('로그인 정상')).toBeVisible();
  await expect(page.getByText('현재 로그인은 정상입니다. 만료 예정: 2026-06-21 21:41:31 (KST). 권장 재로그인 시각: 2026-06-20 21:41:31 (KST).')).toBeVisible();
  await expect(page.getByText('등록된 장비')).toBeVisible();
  await expect(page.getByText('7')).toBeVisible();
  await expect(page.getByText('UnknownHeater · Warm Box')).toBeVisible();
  await expect(page.getByText('LightRgbw5')).toBeVisible();
  await expect(page.getByText('LedStripRgbw2')).toBeVisible();
  await expect(page.getByText('RelayController')).toBeVisible();
  await expect(page.getByText('SensorMo')).toBeVisible();
  await expect(page.getByText('전구 / 구현 중')).toHaveCount(1);
  await expect(page.getByText('구현 중', { exact: true })).toHaveCount(0);
  await expect(page.getByText('전구', { exact: true })).toBeVisible();
  await expect(page.getByText('스위치', { exact: true })).toBeVisible();
  await expect(page.getByText('모션 센서', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: '집/방 선택' })).toBeVisible();
  await expect(page.getByText('처음 로그인하면 첫 번째 집의 모든 방을 사용합니다. 여기서 언제든 바꿀 수 있습니다.')).toBeVisible();
  await expect(page.getByLabel('첫 번째 집')).toBeChecked();
  await expect(page.getByLabel('두 번째 집')).not.toBeChecked();
  await expect(page.getByLabel('거실')).toBeChecked();
  await expect(page.getByRole('button', { name: '집/방 설정 저장' })).toBeVisible();
  await expect(page.getByText('부분 지원')).toBeVisible();
  await expect(page.getByText('카메라는 API 분석 완료, Home 앱 영상 연동은 다음 단계')).toBeVisible();
  await expect(page.getByText('1개 발견')).toBeVisible();
  await expect(page.getByText('[Unsupported Device] UnknownHeater / Warm Box')).toBeVisible();
  await expect(page.getByText('세션')).toHaveCount(0);
  await expect(page.getByText('Lightbulb')).toHaveCount(0);
  await expect(page.getByText('Switch')).toHaveCount(0);
  await expect(page.getByText('MotionSensor')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '로그아웃' })).toBeVisible();
  await expect(page.getByRole('button', { name: '로그인' })).toBeHidden();

  await page.getByRole('button', { name: '로그아웃' }).click();
  await expect(page.getByRole('heading', { name: 'Hejhome' })).toBeVisible();
  await expect(page.getByRole('button', { name: '로그인' })).toBeVisible();
  await expect.poll(async () => page.evaluate(() => window.__hejhomeRequests)).toContain('/logout');
  const payloads = await page.evaluate(() => window.__hejhomePayloads);
  expect(payloads).toEqual(expect.arrayContaining([
    expect.objectContaining({
      pathName: '/ui-event',
      payload: expect.objectContaining({ event: 'logout.click' }),
    }),
    expect.objectContaining({
      pathName: '/ui-event',
      payload: expect.objectContaining({ event: 'logout.success' }),
    }),
  ]));
});

test('custom config UI saves a first-home room subset as a custom scope', async ({ page }) => {
  const source = fs.readFileSync(uiPath, 'utf8');

  await page.evaluate(() => {
    window.__hejhomeRequests = [];
    window.__hejhomePayloads = [];
    window.homebridge = {
      closeSettings: () => undefined,
      disableSaveButton: () => undefined,
      enableSaveButton: () => undefined,
      getPluginConfig: async () => [
        {
          name: 'Hejhome',
          platform: 'Hejhome',
          scope: {
            mode: 'first-family',
          },
        },
      ],
      hideSpinner: () => undefined,
      request: async (pathName: string, payload: unknown) => {
        window.__hejhomeRequests.push(pathName);
        window.__hejhomePayloads.push({ pathName, payload });
        if (pathName === '/session-status') {
          return {
            configured: true,
            sessionValid: true,
            sessionCheckStatus: 'valid',
            scope: {
              mode: 'first-family',
            },
            expiresAtIso: '2026-06-21T12:41:31.692Z',
            refreshRecommendedAtIso: '2026-06-20T12:41:31.692Z',
            deviceSummary: {
              generatedAt: '2026-05-26T01:00:00.000Z',
              registeredCount: 2,
              supportedCount: 2,
              unsupportedCount: 0,
              unsupportedProducts: [],
            },
            supportedModels: [],
            scopeOptions: {
              defaultMode: 'first-family',
              families: [
                {
                  familyId: 101,
                  name: '첫 번째 집',
                  selected: true,
                  rooms: [
                    { roomId: 1, name: '거실', selected: true },
                    { roomId: 2, name: '주방', selected: true },
                  ],
                },
              ],
            },
            issueTemplate: {
              title: '[Unsupported Device]',
              body: 'None',
            },
          };
        }
        if (pathName === '/save-scope') {
          return {
            ok: true,
            scope: payload.scope,
            deviceSummary: {
              generatedAt: '2026-05-26T01:00:00.000Z',
              registeredCount: 1,
              supportedCount: 1,
              unsupportedCount: 0,
              unsupportedProducts: [],
            },
            issueTemplate: {
              title: '[Unsupported Device]',
              body: 'None',
            },
          };
        }
        return { ok: true };
      },
      savePluginConfig: async () => {
        throw new Error('scope save should not call parent savePluginConfig');
      },
      showSpinner: () => undefined,
      toast: {
        error: () => undefined,
        info: () => undefined,
        success: () => undefined,
        warning: () => undefined,
      },
      updatePluginConfig: async () => {
        throw new Error('scope save should not call parent updatePluginConfig');
      },
    };
  });

  await page.setContent(source);
  await expect.poll(async () => page.evaluate(() => window.__hejhomeRequests)).toContain('/session-status');

  await page.getByLabel('주방').uncheck();
  await page.getByRole('button', { name: '집/방 설정 저장' }).click();

  await expect.poll(async () => page.evaluate(() => window.__hejhomeRequests)).toContain('/save-scope');
  await expect(page.getByText('집/방 설정을 저장했습니다. 아래 현황은 새 선택 기준으로 바뀌었습니다. Homebridge를 다시 시작하면 Home 앱 장비도 새 설정으로 바뀝니다.')).toBeVisible();
  await expect(page.locator('#scopeStatus')).toHaveCSS('margin-top', '10px');
  await expect(page.locator('#registeredCount')).toHaveText('1');
  await expect(page.locator('#supportedCount')).toHaveText('1');
  await expect.poll(async () => page.evaluate(() => window.__hejhomePayloads)).toEqual(expect.arrayContaining([
    expect.objectContaining({
      pathName: '/save-scope',
      payload: {
        scope: {
          mode: 'custom',
          includedFamilyIds: [101],
          includedRoomsByFamilyId: {
            '101': [1],
          },
        },
      },
    }),
  ]));
});

test('custom config UI shows zero devices after saving a selection with no rooms', async ({ page }) => {
  const source = fs.readFileSync(uiPath, 'utf8');

  await page.evaluate(() => {
    window.__hejhomeRequests = [];
    window.__hejhomePayloads = [];
    window.homebridge = {
      closeSettings: () => undefined,
      disableSaveButton: () => undefined,
      enableSaveButton: () => undefined,
      getPluginConfig: async () => [
        {
          name: 'Hejhome',
          platform: 'Hejhome',
          scope: {
            mode: 'first-family',
          },
        },
      ],
      hideSpinner: () => undefined,
      request: async (pathName: string, payload: unknown) => {
        window.__hejhomeRequests.push(pathName);
        window.__hejhomePayloads.push({ pathName, payload });
        if (pathName === '/session-status') {
          return {
            configured: true,
            sessionValid: true,
            sessionCheckStatus: 'valid',
            scope: {
              mode: 'first-family',
            },
            expiresAtIso: '2026-06-21T12:41:31.692Z',
            refreshRecommendedAtIso: '2026-06-20T12:41:31.692Z',
            deviceSummary: {
              generatedAt: '2026-05-26T01:00:00.000Z',
              registeredCount: 2,
              supportedCount: 2,
              unsupportedCount: 0,
              unsupportedProducts: [],
            },
            supportedModels: [],
            scopeOptions: {
              defaultMode: 'first-family',
              families: [
                {
                  familyId: 101,
                  name: '첫 번째 집',
                  selected: true,
                  rooms: [
                    { roomId: 1, name: '거실', selected: true },
                    { roomId: 2, name: '주방', selected: true },
                  ],
                },
              ],
            },
            issueTemplate: {
              title: '[Unsupported Device]',
              body: 'None',
            },
          };
        }
        if (pathName === '/save-scope') {
          return {
            ok: true,
            scope: payload.scope,
            deviceSummary: {
              generatedAt: '2026-05-26T01:00:00.000Z',
              registeredCount: 0,
              supportedCount: 0,
              unsupportedCount: 0,
              unsupportedProducts: [],
            },
            issueTemplate: {
              title: '[Unsupported Device]',
              body: 'None',
            },
          };
        }
        return { ok: true };
      },
      savePluginConfig: async () => {
        throw new Error('scope save should not call parent savePluginConfig');
      },
      showSpinner: () => undefined,
      toast: {
        error: () => undefined,
        info: () => undefined,
        success: () => undefined,
        warning: () => undefined,
      },
      updatePluginConfig: async () => {
        throw new Error('scope save should not call parent updatePluginConfig');
      },
    };
  });

  await page.setContent(source);
  await expect.poll(async () => page.evaluate(() => window.__hejhomeRequests)).toContain('/session-status');

  await page.getByLabel('거실').uncheck();
  await page.getByLabel('주방').uncheck();
  await page.getByRole('button', { name: '집/방 설정 저장' }).click();

  await expect.poll(async () => page.evaluate(() => window.__hejhomeRequests)).toContain('/save-scope');
  await expect(page.getByText('등록된 장비')).toBeVisible();
  await expect(page.locator('#registeredCount')).toHaveText('0');
  await expect(page.locator('#supportedCount')).toHaveText('0');
  await expect(page.locator('#unsupportedCount')).toHaveText('0');
  await expect.poll(async () => page.evaluate(() => window.__hejhomePayloads)).toEqual(expect.arrayContaining([
    expect.objectContaining({
      pathName: '/save-scope',
      payload: {
        scope: {
          mode: 'custom',
          includedFamilyIds: [101],
          includedRoomsByFamilyId: {
            '101': [],
          },
        },
      },
    }),
  ]));
});

test('custom config UI keeps the settings dashboard for an invalid stored session and offers re-login', async ({ page }) => {
  const source = fs.readFileSync(uiPath, 'utf8');

  await page.evaluate(() => {
    window.__hejhomeRequests = [];
    window.homebridge = {
      closeSettings: () => undefined,
      disableSaveButton: () => undefined,
      enableSaveButton: () => undefined,
      getPluginConfig: async () => [],
      hideSpinner: () => undefined,
      request: async (pathName: string) => {
        window.__hejhomeRequests.push(pathName);
        if (pathName === '/session-status') {
          return {
            configured: true,
            sessionValid: false,
            sessionCheckStatus: 'invalid',
            deviceSummary: {
              registeredCount: 0,
              supportedCount: 0,
              unsupportedCount: 0,
              unsupportedProducts: [],
            },
            supportedModels: [],
          };
        }
        return { ok: true };
      },
      savePluginConfig: async () => undefined,
      showSpinner: () => undefined,
      toast: {
        error: () => undefined,
        info: () => undefined,
        success: () => undefined,
        warning: () => undefined,
      },
      updatePluginConfig: async (config: unknown) => config,
    };
  });

  await page.setContent(source);
  await expect.poll(async () => page.evaluate(() => window.__hejhomeRequests)).toContain('/session-status');

  await expect(page.getByRole('heading', { name: 'Hejhome 설정' })).toBeVisible();
  await expect(page.getByText('다시 로그인 필요')).toBeVisible();
  await page.getByRole('button', { name: '다시 로그인' }).click();
  await expect(page.getByRole('heading', { name: 'Hejhome' })).toBeVisible();
  await expect(page.getByRole('button', { name: '로그인' })).toBeVisible();
});

test('custom login UI shows completion without writing session data into plugin config', async ({ page }) => {
  const source = fs.readFileSync(uiPath, 'utf8');

  await page.evaluate(() => {
    window.__hejhomeRequests = [];
    window.__hejhomeEvents = [];
    window.homebridge = {
      closeSettings: () => window.__hejhomeEvents.push('closeSettings'),
      disableSaveButton: () => undefined,
      enableSaveButton: () => undefined,
      getPluginConfig: async () => {
        throw new Error('plugin config should not be read during login completion');
      },
      hideSpinner: () => window.__hejhomeEvents.push('hideSpinner'),
      request: async (pathName: string) => {
        window.__hejhomeRequests.push(pathName);
        if (pathName === '/session-status') {
          return { configured: false };
        }
        return { ok: true, pathName, identifier: 'user@example.test' };
      },
      savePluginConfig: async () => {
        throw new Error('plugin config should not be saved during login completion');
      },
      showSpinner: () => window.__hejhomeEvents.push('showSpinner'),
      toast: {
        error: (message: string) => window.__hejhomeEvents.push(`error:${message}`),
        info: () => undefined,
        success: (message: string) => window.__hejhomeEvents.push(`success:${message}`),
        warning: (message: string) => window.__hejhomeEvents.push(`warning:${message}`),
      },
      updatePluginConfig: async () => {
        throw new Error('plugin config should not be updated during login completion');
      },
    };
  });
  await page.setContent(source);
  await expect.poll(async () => page.evaluate(() => window.__hejhomeRequests)).toContain('/session-status');

  await page.getByLabel('이메일').fill('user@example.test');
  await page.getByRole('button', { name: '인증번호 전송' }).click();
  await page.getByLabel('6자리 인증번호 입력').fill('123456');
  await page.getByRole('button', { name: '확인' }).click();
  await page.getByLabel('비밀번호').fill('correct horse battery staple');
  await page.getByRole('button', { name: '로그인' }).click();

  await expect(page.getByRole('status')).toContainText('로그인이 저장되었습니다');
  const events = await page.evaluate(() => window.__hejhomeEvents);
  expect(events).not.toContain('closeSettings');
  expect(events).toEqual(expect.arrayContaining(['showSpinner', 'hideSpinner']));
  const requests = await page.evaluate(() => window.__hejhomeRequests);
  expect(requests).toContain('/session-status');
  expect(requests).toContain('/login');
  expect(requests).toContain('/ui-event');
});
