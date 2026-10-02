import { expect, test } from '@playwright/test';
import fs from 'node:fs';
import { installUiHost, mountUi, openAccountActions, openDevice, publishStatus, requestCalls, respondToConfirmation } from './host-fixture.js';

const devices = [
  { id: 'plug-1', name: '책상 콘센트', deviceType: 'Plug' },
  { id: 'tv-1', name: '거실 TV', deviceType: 'IrTv' },
];

test('four destinations start at devices and expose editing only after opening a device', async ({ page }) => {
  await mountUi(page, { devices });
  const tabs = page.getByRole('navigation', { name: /설정 탐색|Settings navigation/ });
  await expect(tabs.getByRole('button')).toHaveCount(4);
  await expect(tabs.getByRole('button', { name: '장치' })).toHaveAttribute('aria-current', 'page');
  const row = page.locator('[data-testid="device-row"][data-device-id="plug-1"]');
  await expect(row).toContainText('책상 콘센트');
  await expect(row.locator('input, select')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeHidden();
  await openDevice(page, 'plug-1');
  const detail = page.getByTestId('device-detail');
  await expect(detail).toHaveAttribute('data-device-id', 'plug-1');
  await expect(detail.getByLabel('표시 이름')).toBeVisible();
  await expect(detail.getByLabel('연결 방식')).toContainText('Apple Home와 Matter');
  await expect(detail).not.toContainText('Matter 연결 완료');
  await page.getByRole('button', { name: '연결' }).click();
  await openAccountActions(page);
  await expect(page.getByRole('button', { name: '로그아웃', exact: true })).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Matter 연결', exact: true })).not.toBeChecked();
  await expect(page.getByRole('button', { name: '소리 크게' })).toBeHidden();
  await page.getByRole('button', { name: '전력' }).click();
  await expect(page.getByText('고급: 전력 측정 모델 설정', { exact: true })).toBeVisible();
});

test('drafts and text selection survive status changes and tab round trips', async ({ page }) => {
  await mountUi(page, { devices });
  await openDevice(page, 'plug-1');
  const detail = page.getByTestId('device-detail');
  const name = detail.getByLabel('표시 이름');
  await name.fill('작업 조명');
  await name.focus();
  await name.evaluate((input: HTMLInputElement) => input.setSelectionRange(1, 3));
  await page.evaluate(() => {
    window.__hejHost.diagnostics.controlsAvailable = false;
  });
  await publishStatus(page);
  await expect(name).toHaveValue('작업 조명');
  await expect(name).toBeFocused();
  expect(await name.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([1, 3]);
  await page.getByRole('button', { name: '연결' }).click();
  await page.getByRole('switch', { name: 'Matter 연결', exact: true }).check();
  await page.getByRole('button', { name: '도움말' }).click();
  await page.getByRole('button', { name: '장치' }).click();
  await expect(detail).toBeVisible();
  await expect(name).toHaveValue('작업 조명');
  await expect(detail.getByText('저장하지 않은 변경사항', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  const trigger = page.locator('[data-testid="device-row"][data-device-id="plug-1"]').getByRole('button', { name: /상세 보기$/ });
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(name).toHaveValue('작업 조명');
  await page.getByRole('button', { name: '연결' }).click();
  await expect(page.getByRole('switch', { name: 'Matter 연결', exact: true })).toBeChecked();
  expect(await requestCalls(page, '/save-device-settings')).toHaveLength(0);
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
});

test('returning from detail restores search, the list position and the original trigger focus', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 720 });
  const longList = Array.from({ length: 30 }, (_, index) => ({ id: `plug-${index}`, name: `콘센트 ${index}`, deviceType: 'Plug' }));
  await mountUi(page, { devices: longList });
  await page.getByLabel('장치 검색', { exact: true }).fill('콘센트');
  const trigger = page.locator('[data-testid="device-row"][data-device-id="plug-20"]').getByRole('button', { name: /상세 보기$/ });
  await trigger.scrollIntoViewIfNeeded();
  await trigger.focus();
  const position = await page.evaluate(() => window.scrollY);
  expect(position).toBeGreaterThan(100);
  await trigger.click();
  await expect(page.getByTestId('device-detail')).toHaveAttribute('data-device-id', 'plug-20');
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect(page.getByLabel('장치 검색', { exact: true })).toHaveValue('콘센트');
  await expect.poll(() => page.evaluate((position) => Math.abs(window.scrollY - position), position)).toBeLessThan(5);
});

test('failed device save keeps the draft and retry sends only that device preference', async ({ page }) => {
  await mountUi(page, { devices });
  await openDevice(page, 'plug-1');
  const detail = page.getByTestId('device-detail');
  const name = detail.getByLabel('표시 이름');
  await name.fill('저장할 조명');
  await page.evaluate(() => {
    window.__hejHost.failNext['/save-device-settings'] = '저장 공간을 사용할 수 없습니다';
  });
  const save = detail.getByRole('button', { name: '이 장치 저장' });
  await save.click();
  await expect(detail.locator('#deviceSettingsStatus')).toBeVisible();
  await expect(detail.locator('#deviceSettingsStatus')).toContainText('저장 공간');
  await expect(name).toHaveValue('저장할 조명');
  await expect(detail.getByText('저장하지 않은 변경사항', { exact: true })).toBeVisible();
  await expect(save).toBeEnabled();
  await save.click();
  await expect.poll(() => requestCalls(page, '/save-device-settings')).toHaveLength(2);
  expect((await requestCalls(page, '/save-device-settings')).map((call) => call.payload)).toEqual([
    { deviceId: 'plug-1', preference: { name: '저장할 조명' } },
    { deviceId: 'plug-1', preference: { name: '저장할 조명' } },
  ]);
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'plug-1');
  await expect(name).toHaveValue('저장할 조명');
  expect(await requestCalls(page, '/save-features')).toHaveLength(0);
  expect(await requestCalls(page, '/save-scope')).toHaveLength(0);
});

test('late diagnostics cannot roll back a newly saved preference', async ({ page }) => {
  await mountUi(page, { devices });
  await openDevice(page, 'plug-1');
  const old = await page.evaluate(() => structuredClone(window.__hejHost.diagnostics));
  await page.evaluate(() => {
    window.__hejHost.holdNext['/diagnostics'] = 1;
  });
  await publishStatus(page);
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.length)).toBe(1);
  const detail = page.getByTestId('device-detail');
  await detail.getByLabel('표시 이름').fill('새로 저장한 이름');
  await detail.getByRole('button', { name: '이 장치 저장' }).click();
  await expect(detail.getByText('저장하지 않은 변경사항', { exact: true })).toBeHidden();
  await page.evaluate((old) => {
    window.__hejHost.pending.find((request) => request.route === '/diagnostics')!.resolve(old);
  }, old);
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'plug-1');
  await expect(detail.getByLabel('표시 이름')).toHaveValue('새로 저장한 이름');
});

test('a remote timeout is an unconfirmed result with no duplicate or automatic retry', async ({ page }) => {
  await page.clock.install();
  await mountUi(page, { devices });
  await openDevice(page, 'tv-1', 'controls');
  await page.evaluate(() => {
    window.__hejHost.holdNext['/remote-command'] = 1;
  });
  const detail = page.getByTestId('device-detail');
  const volume = detail.getByRole('button', { name: '소리 크게', exact: true });
  await volume.click();
  await expect(volume).toBeDisabled();
  expect(await requestCalls(page, '/remote-command')).toHaveLength(1);
  await page.clock.fastForward(16000);
  await expect(detail).toContainText(/응답.*확인.*기기.*동작/);
  await page.evaluate(() => window.__hejHost.pending.find((request) => request.route === '/remote-command')!.resolve({ ok: true }));
  await expect(detail).toContainText(/응답.*확인.*기기.*동작/);
  await expect(detail).not.toContainText('명령 전송 완료');
  await page.clock.fastForward(30000);
  expect(await requestCalls(page, '/remote-command')).toHaveLength(1);
});

test('expired login keeps existing devices and a draft through reauthentication', async ({ page }) => {
  await mountUi(page, { devices, status: { configured: true, sessionValid: false, sessionCheckStatus: 'invalid' },
    diagnostics: { connection: { session: 'expired', realtime: 'connected' }, controlsAvailable: false } });
  await expect(page.getByTestId('device-row')).toHaveCount(2);
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await expect(page.locator('#sessionBadge')).toContainText('다시 로그인 필요');
  await page.getByRole('button', { name: '장치', exact: true }).click();
  await openDevice(page, 'plug-1');
  await page.getByTestId('device-detail').getByLabel('표시 이름').fill('다시 로그인해도 유지');
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await openAccountActions(page);
  await page.getByRole('button', { name: '다시 로그인', exact: true }).click();
  await page.getByLabel('이메일').fill('user@example.test');
  await page.getByRole('button', { name: '인증번호 전송' }).click();
  await page.getByLabel('6자리 인증번호 입력').fill('123456');
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await page.getByLabel('비밀번호').fill('not-persisted-secret');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await page.getByRole('button', { name: '장치', exact: true }).click();
  await expect(page.getByTestId('device-row')).toHaveCount(2);
  await openDevice(page, 'plug-1');
  await expect(page.getByTestId('device-detail').getByLabel('표시 이름')).toHaveValue('다시 로그인해도 유지');
  expect(await requestCalls(page, '/logout')).toHaveLength(0);
  expect(await requestCalls(page, '/save-device-settings')).toHaveLength(0);
});


test('an empty discovery does not discard the draft when the same device returns', async ({ page }) => {
  await mountUi(page, { devices });
  await openDevice(page, 'plug-1');
  await page.getByTestId('device-detail').getByLabel('표시 이름').fill('잠시 사라져도 유지');
  const original = await page.evaluate(() => structuredClone(window.__hejHost.diagnostics.devices));
  await page.evaluate(() => {
    window.__hejHost.diagnostics.devices = [];
  });
  await publishStatus(page);
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await expect(page.getByTestId('device-row')).toHaveCount(0);
  await page.evaluate((original) => {
    window.__hejHost.diagnostics.devices = original;
  }, original);
  await publishStatus(page);
  await openDevice(page, 'plug-1');
  await expect(page.getByTestId('device-detail').getByLabel('표시 이름')).toHaveValue('잠시 사라져도 유지');
  expect(await requestCalls(page, '/save-device-settings')).toHaveLength(0);
});

test('a different account cannot reuse the previous account device draft even for the same device ID', async ({ page }) => {
  await mountUi(page, { devices });
  await openDevice(page, 'plug-1');
  await page.getByTestId('device-detail').getByLabel('표시 이름').fill('이전 계정 초안');
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.evaluate(() => {
    window.__hejHost.status.sessionValid = false;
    window.__hejHost.status.sessionCheckStatus = 'invalid';
    window.__hejHost.diagnostics.connection = { session: 'expired', realtime: 'connected' };
    window.__hejHost.nextLoginDevices = [{ id: 'plug-1', name: '새 계정 콘센트', deviceType: 'Plug', inScope: true,
      online: true, homekit: true, roleChangeSupported: true, preference: { name: '새 계정 이름' } }];
  });
  await publishStatus(page);
  await openAccountActions(page);
  await page.getByRole('button', { name: '다시 로그인', exact: true }).click();
  await page.getByLabel('이메일').fill('other@example.test');
  await page.getByRole('button', { name: '인증번호 전송' }).click();
  await page.getByLabel('6자리 인증번호 입력').fill('123456');
  await page.getByRole('button', { name: '확인', exact: true }).click();
  await page.getByLabel('비밀번호').fill('another-password');
  await page.getByRole('button', { name: '로그인', exact: true }).click();
  await expect(page.locator('#accountChangeAction')).toBeVisible();
  expect(await requestCalls(page, '/save-device-settings')).toHaveLength(0);
  await page.getByRole('button', { name: '새 계정 확인', exact: true }).click();
  await respondToConfirmation(page, 'cancel');
  await expect(page.getByRole('button', { name: '새 계정 확인', exact: true })).toBeVisible();
  await page.getByRole('button', { name: '새 계정 확인', exact: true }).click();
  await respondToConfirmation(page, 'discard');
  await page.getByRole('button', { name: '장치', exact: true }).click();
  await openDevice(page, 'plug-1');
  await expect(page.getByTestId('device-detail').getByLabel('표시 이름')).toHaveValue('새 계정 이름');
});

test('iframe detail return makes the original device button visible when its parent owns scrolling', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 720 });
  await page.setContent('<main><div style="height:80px">Homebridge host</div><iframe title="Plugin settings" style="width:760px;border:0"></iframe></main>');
  const frame = page.frames().find((candidate) => candidate !== page.mainFrame())!;
  await installUiHost(frame, { devices: Array.from({ length: 30 }, (_, index) => ({
    id: `iframe-${index}`, name: `Iframe 장치 ${index}`, deviceType: 'Plug',
  })) });
  await frame.evaluate(() => {
    window.homebridge.fixScrollHeight = () => {
      requestAnimationFrame(() => {
        const iframe = window.frameElement as HTMLIFrameElement;
        iframe.style.height = '1px';
        iframe.style.height = `${document.documentElement.scrollHeight}px`;
      });
    };
  });
  await frame.setContent(fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8'));
  const trigger = frame.locator('[data-testid="device-row"][data-device-id="iframe-20"]').getByRole('button', { name: /상세 보기$/ });
  await trigger.scrollIntoViewIfNeeded();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100);
  expect(await frame.evaluate(() => window.scrollY)).toBe(0);
  await trigger.click();
  await frame.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await expect(trigger).toBeFocused();
  await expect.poll(async () => {
    const box = await trigger.boundingBox();
    return !!box && box.y >= 0 && box.y + box.height <= 720;
  }).toBe(true);
});


test('a delayed device save cannot discard a newer edit typed while it was pending', async ({ page }) => {
  await mountUi(page, { devices });
  await openDevice(page, 'plug-1');
  const detail = page.getByTestId('device-detail');
  const name = detail.getByLabel('표시 이름');
  await name.fill('처음 보낸 이름');
  await page.evaluate(() => {
    window.__hejHost.holdNext['/save-device-settings'] = 1;
  });
  await detail.getByRole('button', { name: '이 장치 저장' }).click();
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.length)).toBe(1);
  if (await name.isEnabled()) {
    await name.fill('응답 전에 바꾼 이름');
    await page.evaluate(() => window.__hejHost.pending[0]!.resolve());
    await expect(detail.getByRole('button', { name: '이 장치 저장' })).toBeEnabled();
    await expect(name).toHaveValue('응답 전에 바꾼 이름');
    await expect(detail.getByText('저장하지 않은 변경사항', { exact: true })).toBeVisible();
    await detail.getByRole('button', { name: '이 장치 저장' }).click();
    await expect.poll(async () => (await requestCalls(page, '/save-device-settings')).at(-1)?.payload)
      .toEqual({ deviceId: 'plug-1', preference: { name: '응답 전에 바꾼 이름' } });
  } else {
    await expect(name).toBeDisabled();
    await page.evaluate(() => window.__hejHost.pending[0]!.resolve());
    await expect(name).toBeEnabled();
    await expect(name).toHaveValue('처음 보낸 이름');
  }
});

for (const target of ['matter', 'adaptive', 'meters'] as const) {
  test(`delayed ${target} settings save preserves a newer unsaved edit`, async ({ page }) => {
    await mountUi(page);
    await page.getByRole('button', { name: target === 'meters' ? '전력' : '연결', exact: true }).click();
    if (target === 'meters') {
      await page.getByText('고급: 전력 측정 모델 설정', { exact: true }).click();
    }
    const control = page.locator(target === 'matter' ? '#matterFeature' : target === 'adaptive' ? '#adaptiveFeature' : '#meterProfiles');
    const first = [{ model: 'Meter A', power: { field: 'curPower', multiplier: 1 } }];
    const second = [{ model: 'Meter B', power: { field: 'curPower', multiplier: 2 } }];
    if (target === 'meters') {
      await control.fill(JSON.stringify(first));
    } else {
      await control.check();
    }
    await page.evaluate(() => {
      window.__hejHost.holdNext['/save-features'] = 1;
    });
    const save = page.locator(target === 'matter' ? '#saveFeatures' : target === 'adaptive' ? '#saveLighting' : '#saveMeters');
    await save.click();
    await expect.poll(() => page.evaluate(() => window.__hejHost.pending.length)).toBe(1);
    if (await control.isEnabled()) {
      if (target === 'meters') {
        await control.fill(JSON.stringify(second));
      } else {
        await control.uncheck();
      }
      await page.evaluate(() => window.__hejHost.pending[0]!.resolve());
      await expect(save).toBeEnabled();
      if (target === 'meters') {
        await expect.poll(async () => JSON.parse(await control.inputValue())).toEqual(second);
      } else {
        await expect(control).not.toBeChecked();
      }
      await save.click();
      await expect.poll(async () => (await requestCalls(page, '/save-features')).at(-1)?.payload).toEqual({ features:
        target === 'meters' ? { meters: second } : target === 'matter' ? { matter: false } : { adaptiveLighting: false } });
    } else {
      await expect(control).toBeDisabled();
      await page.evaluate(() => window.__hejHost.pending[0]!.resolve());
      await expect(control).toBeEnabled();
    }
  });
}

test('status refresh and detail reopening cannot send a second copy of an in-flight remote command', async ({ page }) => {
  await mountUi(page, { devices });
  await openDevice(page, 'tv-1', 'controls');
  await page.evaluate(() => {
    window.__hejHost.holdNext['/remote-command'] = 1;
  });
  const detail = page.getByTestId('device-detail');
  await detail.getByRole('button', { name: '소리 크게', exact: true }).click();
  await publishStatus(page);
  await expect(detail.getByRole('button', { name: '소리 크게', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '장치 목록으로', exact: true }).click();
  await openDevice(page, 'tv-1', 'controls');
  await expect(detail.getByRole('button', { name: '소리 크게', exact: true })).toBeDisabled();
  expect(await requestCalls(page, '/remote-command')).toHaveLength(1);
  await page.evaluate(() => window.__hejHost.pending.find((request) => request.route === '/remote-command')!.resolve());
  await expect(detail).toContainText('명령 전송 완료');
  await expect(detail.getByRole('button', { name: '소리 크게', exact: true })).toBeEnabled();
});

test('unsupported devices retain settings without invented control buttons', async ({ page }) => {
  await mountUi(page, { devices: [{ id: 'unknown-1', name: '아직 모르는 장치', deviceType: 'UnknownThing',
    roleChangeSupported: false, homekit: false, matter: false }] });
  await openDevice(page, 'unknown-1');
  const detail = page.getByTestId('device-detail');
  await expect(detail.getByLabel('표시 이름')).toBeVisible();
  await expect(detail.getByLabel('표시 형태')).toHaveCount(0);
  await expect(detail.getByRole('button', { name: /켜기|끄기|온도 설정|회전 버튼|소리 크게/ })).toHaveCount(0);
  expect(await requestCalls(page, '/remote-command')).toHaveLength(0);
});

test('elapsed freshness alone disables remote actions without waiting for a changed device value', async ({ page }) => {
  await page.clock.install();
  await mountUi(page, { devices });
  await openDevice(page, 'tv-1', 'controls');
  const volume = page.getByTestId('device-detail').getByRole('button', { name: '소리 크게', exact: true });
  await expect(volume).toBeEnabled();
  await page.clock.fastForward(41000);
  await expect(volume).toBeDisabled();
  await expect(page.locator('#account-summary')).toContainText('최신 상태 확인 필요');
  expect(await requestCalls(page, '/remote-command')).toHaveLength(0);
});

test('failed diagnostics stop stale HVAC values being presented as current and preserve the target draft', async ({ page }) => {
  await page.clock.install();
  await mountUi(page, { devices: [{ id: 'ac-1', name: '침실 에어컨', deviceType: 'IrAirconditioner',
    temperatureCelsius: 22, hvacSettings: { power: true, targetTemperature: 23, mode: 'cool', fanSpeed: 'low' } }] });
  await openDevice(page, 'ac-1', 'controls');
  const detail = page.getByTestId('device-detail');
  await expect(detail).toContainText(/현재 온도:\s*22\s*°C/);
  const target = detail.getByLabel('바꿀 설정 온도(°C)', { exact: true });
  await target.fill('26');
  await target.focus();
  await page.evaluate(() => {
    window.__hejHost.failNext['/diagnostics'] = '연결할 수 없습니다';
  });
  await publishStatus(page);
  await expect(page.locator('#globalStatus')).toContainText(/확인하지 못|확인 실패|확인할 수 없/);
  await page.clock.fastForward(41000);
  await expect(detail).not.toContainText(/현재 온도:\s*22\s*°C/);
  await expect(detail.getByRole('button', { name: '온도 설정', exact: true })).toBeDisabled();
  await expect(target).toHaveValue('26');
  await expect(target).toBeFocused();
});

test('help displays only the server redacted diagnostic export without adding device or account details', async ({ page }) => {
  await mountUi(page, { devices: [{ id: 'private-device-id', name: '내 방의 개인 장치명', deviceType: 'Plug' }] });
  await page.getByRole('button', { name: '도움말', exact: true }).click();
  await page.getByRole('button', { name: '진단 내용 보기', exact: true }).click();
  const output = page.locator('#diagnosticsExport');
  await expect(output).toBeVisible();
  expect(JSON.parse((await output.textContent())!)).toEqual({ formatVersion: 1, summary: { deviceCount: 1 } });
  await expect(output).not.toContainText('private-device-id');
  await expect(output).not.toContainText('내 방의 개인 장치명');
  await expect(output).not.toContainText('user@example.test');
  expect(await requestCalls(page, '/diagnostics-export')).toHaveLength(1);
});

test('startup timeout and failure retain the startup view until a retry confirms the actual session', async ({ page }) => {
  await page.clock.install();
  await installUiHost(page, { devices });
  await page.evaluate(() => {
    window.__hejHost.holdNext['/session-status'] = 1;
  });
  await page.setContent(fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8'));
  await expect.poll(() => requestCalls(page, '/session-status')).toHaveLength(1);
  await expect(page.locator('#startupView')).toBeVisible();
  await expect(page.locator('#loginView')).toBeHidden();
  await page.clock.runFor(10001);
  await expect(page.locator('#retryStartup')).toBeVisible();
  await expect(page.locator('#loginView')).toBeHidden();
  await page.evaluate(() => {
    window.__hejHost.failNext['/session-status'] = 'temporarily unavailable';
  });
  await page.locator('#retryStartup').click();
  await expect.poll(() => requestCalls(page, '/session-status')).toHaveLength(2);
  await expect(page.locator('#startupView')).toBeVisible();
  await expect(page.locator('#loginView')).toBeHidden();
  await page.locator('#retryStartup').click();
  await expect(page.getByTestId('device-row')).toHaveCount(2);
  await expect(page.locator('#startupView')).toBeHidden();
  await page.evaluate(() => window.__hejHost.pending.find((item) => item.route === '/session-status')!
    .resolve({ configured: false, sessionValid: false }));
  await expect(page.locator('#loginView')).toBeHidden();
  await expect(page.getByTestId('device-row')).toHaveCount(2);
});

test('two unsettled diagnostics requests stay capped after UI timeouts and resume when one settles', async ({ page }) => {
  await page.clock.install();
  await mountUi(page, { devices });
  await expect(page.getByTestId('device-row')).toHaveCount(2);
  const initial = (await requestCalls(page, '/diagnostics')).length;
  await page.evaluate(() => {
    window.__hejHost.holdNext['/diagnostics'] = 2;
    window.homebridge.closeSettings = () => window.__hejHost.calls.push({ route: 'host.closeSettings', payload: null });
  });
  await publishStatus(page);
  await publishStatus(page);
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.filter((item) => item.route === '/diagnostics').length)).toBe(1);
  // Concurrent refreshes share a flight. A second raw request starts only after timeout and backoff.
  await page.clock.fastForward(10001);
  await page.clock.fastForward(30001);
  await publishStatus(page);
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.filter((item) => item.route === '/diagnostics').length)).toBe(2);
  await page.clock.runFor(10001);
  await page.clock.runFor(60000);
  expect(await requestCalls(page, '/diagnostics')).toHaveLength(initial + 2);
  await expect(page.locator('#closeStalledSettings')).toBeVisible();
  await page.locator('#closeStalledSettings').click();
  expect(await requestCalls(page, 'host.closeSettings')).toHaveLength(1);
  await page.evaluate(() => {
    window.__hejHost.pending.find((item) => item.route === '/diagnostics')!.resolve({ devices: [] });
    window.__hejHost.diagnostics.updatedAt = new Date().toISOString();
  });
  await publishStatus(page);
  await expect.poll(() => requestCalls(page, '/diagnostics')).toHaveLength(initial + 3);
  await expect(page.getByTestId('device-row')).toHaveCount(2);
  await expect(page.getByText('연결 응답이 멈췄어요. 설정 창을 닫았다 다시 열어 주세요.', { exact: true })).toBeHidden();
});

const packetFamilies = [{ familyId: 101, name: '첫 번째 집', selected: true,
  rooms: [{ roomId: 1, name: '거실', selected: true }, { roomId: 2, name: '주방', selected: true }] }];

async function cancelLogout(page: import('@playwright/test').Page) {
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await openAccountActions(page);
  const logout = page.getByRole('button', { name: '로그아웃', exact: true });
  await logout.click();
  await respondToConfirmation(page, 'cancel');
  await expect(logout).toBeFocused();
  expect(await requestCalls(page, '/logout')).toHaveLength(0);
}

for (const section of ['matter', 'lighting', 'meters', 'scope'] as const) {
  test(`${section} dirty logout cancellation preserves edits and a clean save needs no discard confirmation`, async ({ page }) => {
    await mountUi(page, { status: { scopeOptions: { complete: true, families: packetFamilies } } });
    await page.getByRole('button', { name: section === 'meters' ? '전력' : '연결', exact: true }).click();
    if (section === 'meters') {
      await page.getByText('고급: 전력 측정 모델 설정', { exact: true }).click();
    }
    const control = page.locator(section === 'matter' ? '#matterFeature' : section === 'lighting' ? '#adaptiveFeature'
      : section === 'meters' ? '#meterProfiles' : '[data-room-id="2"]');
    const profile = [{ model: 'P1', power: { field: 'curPower', multiplier: 1 } }];
    if (section === 'meters') {
      await control.fill(JSON.stringify(profile));
    } else if (section === 'scope') {
      await control.uncheck();
    } else {
      await control.check();
    }
    await cancelLogout(page);
    await page.getByRole('button', { name: section === 'meters' ? '전력' : '연결', exact: true }).click();
    if (section === 'meters') {
      await expect.poll(async () => JSON.parse(await control.inputValue())).toEqual(profile);
    } else if (section === 'scope') {
      await expect(control).not.toBeChecked();
    } else {
      await expect(control).toBeChecked();
    }
    await page.locator(section === 'matter' ? '#saveFeatures' : section === 'lighting' ? '#saveLighting'
      : section === 'meters' ? '#saveMeters' : '#saveScope').click();
    await expect(page.locator(section === 'matter' ? '#featuresStatus' : section === 'lighting' ? '#lightingStatus'
      : section === 'meters' ? '#meterStatus' : '#scopeStatus')).toContainText('저장');
    await page.getByRole('button', { name: '연결', exact: true }).click();
    await openAccountActions(page);
    await page.getByRole('button', { name: '로그아웃', exact: true }).click();
    await expect.poll(() => requestCalls(page, '/logout')).toHaveLength(1);
    await expect(page.getByRole('alertdialog')).toBeHidden();
  });
}

for (const operation of ['add', 'remove'] as const) {
  test(`actual-meter JSON ${operation} is still an unsaved change at logout`, async ({ page }) => {
    await mountUi(page, { status: { features: { matter: false, adaptiveLighting: false,
      meters: operation === 'remove' ? [{ model: 'P1', power: { field: 'curPower', multiplier: 1 } }] : [] } } });
    await page.getByRole('button', { name: '전력', exact: true }).click();
    await page.getByText('고급: 전력 측정 모델 설정', { exact: true }).click();
    const draft = operation === 'add' ? '[{"model":"NEW","power":{"field":"curPower","multiplier":1}}]' : '[]';
    await page.locator('#meterProfiles').fill(draft);
    await cancelLogout(page);
    await page.getByRole('button', { name: '전력', exact: true }).click();
    await expect(page.locator('#meterProfiles')).toHaveValue(draft);
  });
}

test('saving meters does not clear an unrelated unsaved Matter change', async ({ page }) => {
  await mountUi(page);
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.locator('#matterFeature').check();
  await page.getByRole('button', { name: '전력', exact: true }).click();
  await page.getByText('고급: 전력 측정 모델 설정', { exact: true }).click();
  await page.locator('#meterProfiles').fill(JSON.stringify([{ model: 'P1', power: { field: 'curPower', multiplier: 1 } }]));
  await page.locator('#saveMeters').click();
  await expect(page.locator('#meterStatus')).toContainText('저장');
  await cancelLogout(page);
  await expect(page.locator('#matterFeature')).toBeChecked();
  expect((await requestCalls(page, '/save-features')).map((item) => item.payload)).toEqual([
    { features: { meters: [{ model: 'P1', power: { field: 'curPower', multiplier: 1 } }] } },
  ]);
});

test('scope save acknowledgement preserves a checkbox edited during the pending save and remains dirty', async ({ page }) => {
  await mountUi(page, { status: { scopeOptions: { complete: true, families: packetFamilies } } });
  await page.getByRole('button', { name: '연결', exact: true }).click();
  await page.getByLabel('주방', { exact: true }).uncheck();
  await page.evaluate(() => {
    window.__hejHost.holdNext['/save-scope'] = 1;
  });
  await page.locator('#saveScope').click();
  await expect.poll(() => page.evaluate(() => window.__hejHost.pending.length)).toBe(1);
  await page.getByLabel('거실', { exact: true }).uncheck();
  await page.evaluate(() => window.__hejHost.pending[0]!.resolve());
  await expect(page.locator('#scopeStatus')).toContainText('저장');
  await expect(page.getByLabel('주방', { exact: true })).not.toBeChecked();
  await expect(page.getByLabel('거실', { exact: true })).not.toBeChecked();
  await cancelLogout(page);
});

for (const action of ['command', 'save'] as const) {
  test(`account A late ${action} completion cannot write into account B with the same device ID`, async ({ page }) => {
    await mountUi(page, { devices: [{ id: 'same-id', name: '계정 A TV', deviceType: 'IrTv' }] });
    await openDevice(page, 'same-id', action === 'command' ? 'controls' : 'settings');
    const detail = page.getByTestId('device-detail');
    const route = action === 'command' ? '/remote-command' : '/save-device-settings';
    await page.evaluate((route) => {
      window.__hejHost.holdNext[route] = 1;
    }, route);
    if (action === 'command') {
      await detail.getByRole('button', { name: '소리 크게', exact: true }).click();
    } else {
      await detail.getByLabel('표시 이름').fill('계정 A 저장 이름');
      await detail.getByRole('button', { name: '이 장치 저장' }).click();
    }
    await expect.poll(() => page.evaluate(() => window.__hejHost.pending.length)).toBe(1);
    await page.evaluate(() => {
      window.__hejHost.status.uiSessionRevision = 'account-B';
      window.__hejHost.diagnostics.uiSessionRevision = 'account-B';
      window.__hejHost.diagnostics.devices = [{ id: 'same-id', name: '계정 B TV', deviceType: 'IrTv', inScope: true,
        online: true, homekit: true, preference: { name: '계정 B 이름' } }];
    });
    await publishStatus(page);
    if (action === 'save') {
      await page.getByRole('button', { name: '새 계정 확인', exact: true }).click();
      await respondToConfirmation(page, 'discard');
    }
    await openDevice(page, 'same-id');
    await expect(detail.getByLabel('표시 이름')).toHaveValue('계정 B 이름');
    await page.evaluate((route) => window.__hejHost.pending.find((item) => item.route === route)!
      .resolve({ ok: true, preference: { name: '계정 A 저장 이름' } }), route);
    await expect(detail.getByLabel('표시 이름')).toHaveValue('계정 B 이름');
    await expect(detail).not.toContainText('명령 전송 완료');
    await expect(detail).not.toContainText('계정 A 저장 이름');
    await detail.getByRole('tab', { name: '조작', exact: true }).click();
    await expect(detail.getByRole('button', { name: '소리 크게', exact: true })).toBeEnabled();
  });
}

test('repeated pagehide and pageshow keep one diagnostic interval and no polling while hidden', async ({ page }) => {
  await page.clock.install();
  await mountUi(page, { devices });
  await expect(page.getByTestId('device-row')).toHaveCount(2);
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.evaluate(() => window.dispatchEvent(new Event('pagehide')));
    const hiddenCount = (await requestCalls(page, '/diagnostics')).length;
    await page.clock.runFor(30000);
    expect(await requestCalls(page, '/diagnostics')).toHaveLength(hiddenCount);
    await page.evaluate(() => window.dispatchEvent(new Event('pageshow')));
    await expect.poll(() => requestCalls(page, '/diagnostics')).toHaveLength(hiddenCount + 1);
  }
  const before = (await requestCalls(page, '/diagnostics')).length;
  await page.clock.runFor(30000);
  expect(await requestCalls(page, '/diagnostics')).toHaveLength(before + 3);
});
