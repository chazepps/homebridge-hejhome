import fs from 'node:fs';
import { expect, type Page, type Frame } from '@playwright/test';

export interface UiDevice {
  id: string;
  name: string;
  deviceType: string;
  preference?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface UiHostState {
  status: Record<string, unknown>;
  diagnostics: { devices: UiDevice[]; [key: string]: unknown };
  calls: Array<{ route: string; payload: unknown }>;
  toasts: Array<{ kind: string; message: string }>;
  holdNext: Record<string, number>;
  failNext: Record<string, string>;
  accountIdentifier: string;
  nextLoginDevices?: UiDevice[];
  pending: Array<{ route: string; resolve(value?: unknown): void; reject(error: Error): void }>;
}
declare global {
  interface Window { __hejHost: UiHostState }
}

interface Options {
  language?: 'ko' | 'en';
  theme?: 'light' | 'dark';
  devices?: UiDevice[];
  status?: Record<string, unknown>;
  diagnostics?: Record<string, unknown>;
}

export async function installUiHost(page: Page | Frame, options: Options = {}): Promise<void> {
  await page.evaluate((options) => {
    const host = new EventTarget();
    const now = new Date().toISOString();
    const state: UiHostState = {
      status: { configured: true, sessionValid: true, sessionCheckStatus: 'valid', uiSessionRevision: 'account-revision-1',
        scopeEditToken: 'scope-edit-ticket-1',
        features: { matter: false, adaptiveLighting: false, meters: [] }, scope: { mode: 'first-family' },
        scopeOptions: { complete: true, families: [] }, supportedModels: [], ...options.status },
      diagnostics: { uiSessionRevision: 'account-revision-1', generatedAt: now, updatedAt: now, controlsAvailable: true,
        connection: { session: 'valid', realtime: 'connected' },
        devices: (options.devices ?? []).map((device) => ({ inScope: true, online: true, homekit: true, matter: false,
          lastControl: 'unknown', lastSeenAt: now, meterProfileApplied: false,
          roleChangeSupported: ['Plug', 'RelayController', 'Switch1'].includes(device.deviceType), preference: {}, ...device })),
        ...options.diagnostics },
      calls: [], toasts: [], holdNext: {}, failNext: {}, pending: [], accountIdentifier: 'user@example.test',
    };
    const copy = (value: unknown) => structuredClone(value);
    const reply = (route: string, payload: unknown): unknown => {
      if (route === '/session-status') {
        return copy(state.status);
      }
      if (route === '/diagnostics') {
        return copy(state.diagnostics);
      }
      if (route === '/save-device-settings') {
        const body = payload as { deviceId: string; preference: Record<string, unknown> };
        const device = state.diagnostics.devices.find((entry) => entry.id === body.deviceId);
        if (device) {
          device.preference = copy(body.preference) as Record<string, unknown>;
        }
        return { ok: true, preference: copy(body.preference) };
      }
      if (route === '/save-features') {
        const features = (payload as { features: Record<string, unknown> }).features;
        state.status.features = { ...state.status.features as Record<string, unknown>, ...copy(features) as Record<string, unknown> };
        return { ok: true, features: copy(state.status.features) };
      }
      if (route === '/save-scope') {
        const body = payload as { scope: unknown; scopeEditToken?: string };
        if (body.scopeEditToken !== state.status.scopeEditToken) {
          throw new Error('집과 방 목록을 다시 확인해 주세요.');
        }
        state.status.scope = copy(body.scope);
        state.status.scopeEditToken = `scope-edit-ticket-${state.calls.length}`;
        return { ok: true, scope: copy(state.status.scope), scopeEditToken: state.status.scopeEditToken, scopeOptions: copy(state.status.scopeOptions) };
      }
      if (route === '/login') {
        const identifier = (payload as { identifier: string }).identifier;
        if (identifier !== state.accountIdentifier) {
          state.accountIdentifier = identifier;
          state.status.uiSessionRevision = `account-revision-${state.calls.length}`;
          state.diagnostics.uiSessionRevision = state.status.uiSessionRevision;
          state.diagnostics.devices = state.nextLoginDevices ?? [];
        }
        Object.assign(state.status, { configured: true, sessionValid: true, sessionCheckStatus: 'valid' });
        state.diagnostics.connection = { session: 'valid', realtime: 'connected' };
      }
      if (route === '/logout') {
        Object.assign(state.status, { configured: false, sessionValid: false, uiSessionRevision: `logout-${state.calls.length}` });
      }
      if (route === '/diagnostics-export') {
        return { formatVersion: 1, summary: { deviceCount: state.diagnostics.devices.length } };
      }
      return { ok: true };
    };
    Object.assign(host, {
      i18nCurrentLang: async () => options.language ?? 'ko', userCurrentLightingMode: async () => options.theme ?? 'light',
      getCachedAccessories: async () => [], getCachedMatterAccessories: async () => [],
      request: async (route: string, payload: unknown) => {
        state.calls.push({ route, payload: copy(payload) });
        if (state.failNext[route]) {
          const message = state.failNext[route]; delete state.failNext[route]; throw new Error(message);
        }
        if (state.holdNext[route]) {
          state.holdNext[route]--;
          return new Promise((resolve, reject) => state.pending.push({ route, reject,
            resolve: (value) => resolve(value === undefined ? reply(route, payload) : value) }));
        }
        return reply(route, payload);
      },
      toast: Object.fromEntries(['success', 'error', 'warning', 'info'].map((kind) => [kind,
        (message: string) => state.toasts.push({ kind, message })])),
      hideSpinner() {}, showSpinner() {}, disableSaveButton() {}, enableSaveButton() {}, fixScrollHeight() {}, closeSettings() {},
      getPluginConfig: async () => [], updatePluginConfig: async () => {
        throw new Error('Use server save routes.');
      },
      savePluginConfig: async () => {
        throw new Error('Use server save routes.');
      },
    });
    window.homebridge = host as typeof window.homebridge;
    window.__hejHost = state;
  }, options);
}

export async function mountUi(page: Page, options: Options = {}): Promise<void> {
  await installUiHost(page, options);
  await page.setContent(fs.readFileSync(new URL('../../homebridge-ui/public/index.html', import.meta.url), 'utf8'));
}

export async function requestCalls(page: Page, route: string) {
  return page.evaluate((route) => window.__hejHost.calls.filter((entry) => entry.route === route), route);
}

export async function openDevice(page: Page | Frame, id: string): Promise<void> {
  const row = page.locator(`[data-testid="device-row"][data-device-id="${id}"]`);
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: /^(상세 보기|Details)$/ }).click();
}

export async function publishStatus(page: Page): Promise<void> {
  await page.evaluate(() => window.homebridge.dispatchEvent(new Event('hejhome-status-changed')));
}
