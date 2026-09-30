import fs from 'node:fs';
import { expect, test } from '@playwright/test';

const source = fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8');

for (const language of ['ko', 'en']) {
  test(`${language} describes the IR fan as one conditional Home service`, async ({ page }) => {
    await page.evaluate((language) => {
      window.homebridge = {
        i18nCurrentLang: async () => language,
        userCurrentLightingMode: async () => 'light',
        request: async (route) => {
          if (route === '/session-status') {
            return { configured: true, sessionValid: true, features: { matter: false, adaptiveLighting: false, meters: [] },
              scope: { mode: 'first-family' }, supportedModels: [
                { deviceType: 'IrFan', label: 'IR 선풍기', homeKitServices: ['Fan', 'Switch'], supportStatus: 'partial' },
                { deviceType: 'SensorTh', label: '온습도 센서',
                  homeKitServices: ['TemperatureSensor', 'HumiditySensor', 'BatteryService'], supportStatus: 'supported' },
                { deviceType: 'ZigbeeDoorlock', label: '도어락 문 열림',
                  homeKitServices: ['ContactSensor'], supportStatus: 'partial' },
              ] };
          }
          if (route === '/diagnostics') {
            return { connection: { session: 'unknown', realtime: 'unknown' }, devices: [] };
          }
          return {};
        },
        getCachedAccessories: async () => [], getCachedMatterAccessories: async () => [],
        toast: { success() {}, error() {} }, hideSpinner() {}, disableSaveButton() {}, fixScrollHeight() {},
      };
    }, language);
    await page.setContent(source);
    await page.getByRole('tab', { name: language === 'en' ? 'Help' : '도움말', exact: true }).click();
    const list = page.locator('#supportedModels');
    await expect(list).toContainText(language === 'en' ? 'Fan or power button' : '선풍기 또는 전원 버튼');
    await expect(list).toContainText(language === 'en'
      ? 'Shows as a fan when power status is available; otherwise a power button.'
      : '전원 상태가 확인되면 선풍기, 확인되지 않으면 전원 버튼으로 보입니다.');
    await expect(list).not.toContainText(language === 'en' ? 'Fan + Switch' : '선풍기 + 스위치');
    await expect(list).toContainText(language === 'en'
      ? 'Temperature sensor + Humidity sensor + Battery'
      : '온도 센서 + 습도 센서 + 배터리');
    await expect(list).toContainText(language === 'en'
      ? 'Lock status and lock or unlock controls are unavailable.'
      : '잠금 상태 확인이나 잠금·해제 조작은 할 수 없습니다.');
  });
}
