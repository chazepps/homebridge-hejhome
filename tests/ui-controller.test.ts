import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppController, StaleAccountError } from '../homebridge-ui/src/core/controller.js';
import { DraftStore } from '../homebridge-ui/src/core/drafts.js';
import type { Diagnostics, HomebridgeHost, SessionStatus } from '../homebridge-ui/src/core/types.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function fixture() {
  const state = { status: { configured: true, sessionValid: true, uiSessionRevision: 'one' } as SessionStatus,
    diagnostics: { uiSessionRevision: 'one', updatedAt: new Date().toISOString(), controlsAvailable: true,
      deviceListAvailable: true, connection: { session: 'valid', realtime: 'connected' }, devices: [] } as Diagnostics };
  const host: HomebridgeHost = { request: async (path) => structuredClone(path === '/session-status' ? state.status : state.diagnostics) };
  return { state, host, controller: new AppController(host) };
}
afterEach(() => vi.useRealTimers());

describe('account-aware UI controller', () => {
  it('rechecks a structured transient verification failure after backoff without an inventory change', async () => {
    vi.useFakeTimers();
    const { controller, state, host } = fixture();
    state.status.sessionValid = false;
    state.status.sessionCheckStatus = 'error';
    const original = host.request;
    let reads = 0;
    host.request = (route, body) => {
      if (route === '/session-status') {
        reads++;
      }
      return original(route, body);
    };
    await controller.initialize();
    for (let index = 0; index < 20; index++) {
      await controller.refreshDiagnostics();
    }
    expect(reads).toBe(1);
    expect(controller.getSnapshot().writable).toBe(false);
    state.status.sessionValid = true;
    state.status.sessionCheckStatus = 'valid';
    await vi.advanceTimersByTimeAsync(29999);
    state.diagnostics.updatedAt = new Date().toISOString();
    await controller.refreshDiagnostics();
    expect(reads).toBe(1);
    await vi.advanceTimersByTimeAsync(2);
    state.diagnostics.updatedAt = new Date().toISOString();
    await controller.refreshDiagnostics();
    expect(reads).toBe(2);
    expect(controller.getSnapshot().writable).toBe(true);
    await controller.refreshDiagnostics();
    expect(reads).toBe(2);
  });

  it('allows an explicit startup retry during automatic backoff without reviving a timed-out response', async () => {
    vi.useFakeTimers();
    const { controller, host } = fixture();
    const original = host.request;
    const held = deferred<SessionStatus>();
    let calls = 0;
    host.request = (route, body) => {
      if (route !== '/session-status') {
        return original(route, body);
      }
      calls++;
      return calls === 1 ? held.promise : calls === 2 ? Promise.reject(new Error('temporarily unavailable')) : original(route, body);
    };
    const startup = controller.initialize();
    await vi.advanceTimersByTimeAsync(10001);
    await startup;
    expect(controller.getSnapshot().phase).toBe('error');
    await controller.initialize();
    expect(calls).toBe(2);
    expect(controller.getSnapshot().phase).toBe('error');
    await controller.initialize();
    expect(calls).toBe(3);
    expect(controller.getSnapshot().phase).toBe('settings');
    held.resolve({ configured: false, sessionValid: false, uiSessionRevision: 'old' });
    await vi.advanceTimersByTimeAsync(0);
    expect(controller.getSnapshot().phase).toBe('settings');
    expect(controller.getSnapshot().revision).toBe('one');
  });

  it('accepts only the revision acknowledged by the current login when its status push arrives first', async () => {
    const { controller, state, host } = fixture();
    state.status = { configured: false, sessionValid: false, uiSessionRevision: 'unconfigured' };
    await controller.initialize();
    const acknowledgement = deferred<unknown>();
    const original = host.request;
    host.request = (path, body) => path === '/login' ? acknowledgement.promise : original(path, body);
    const login = controller.login('user@example.test', 'password').catch((error: unknown) => error);
    state.status = { configured: true, sessionValid: true, uiSessionRevision: 'signed-in' };
    await controller.refreshStatus();
    const beforeAck = controller.getSnapshot();
    acknowledgement.resolve({ ok: true, uiSessionRevision: 'signed-in' });
    expect(await login).toBeUndefined();
    expect(beforeAck).toMatchObject({ phase: 'login', busy: true, accountEpoch: 0 });
    expect(controller.getSnapshot()).toMatchObject({ phase: 'settings', busy: false, revision: 'signed-in' });
  });

  it('rejects a foreign revision observed before the current login ACK', async () => {
    const { controller, state, host } = fixture();
    await controller.initialize();
    const acknowledgement = deferred<unknown>();
    const original = host.request;
    host.request = (path, body) => path === '/login' ? acknowledgement.promise : original(path, body);
    controller.beginLogin();
    const login = controller.login('user@example.test', 'password');
    const failure = expect(login).rejects.toBeInstanceOf(StaleAccountError);
    state.status.uiSessionRevision = 'foreign';
    await controller.refreshStatus();
    acknowledgement.resolve({ ok: true, uiSessionRevision: 'mine' });
    await failure;
    expect(controller.getSnapshot().revision).toBe('foreign');
    expect(controller.getSnapshot().busy).toBe(false);
  });

  it('does not reuse a status request started before the acknowledged login transition', async () => {
    const { controller, state, host } = fixture();
    state.status = { configured: false, sessionValid: false, uiSessionRevision: 'unconfigured' };
    await controller.initialize();
    const previousStatus = structuredClone(state.status);
    const held = deferred<unknown>();
    const original = host.request;
    let reads = 0;
    host.request = async (path, body) => {
      if (path === '/session-status' && ++reads === 1) {
        return held.promise;
      }
      if (path === '/login') {
        state.status = { configured: true, sessionValid: true, uiSessionRevision: 'signed-in' };
        return { ok: true, uiSessionRevision: 'signed-in' };
      }
      return original(path, body);
    };
    const oldRefresh = controller.refreshStatus();
    const login = controller.login('user@example.test', 'password').catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 0));
    held.resolve(previousStatus);
    await oldRefresh;
    expect(await login).toBeUndefined();
    expect(controller.getSnapshot()).toMatchObject({ phase: 'settings', revision: 'signed-in' });
  });

  it('does not apply a pre-save status response to a post-ACK refresh', async () => {
    const { controller, state, host } = fixture();
    state.status.features = { matter: false };
    await controller.initialize(); await controller.refreshDiagnostics();
    const previousStatus = structuredClone(state.status);
    const held = deferred<unknown>();
    const original = host.request;
    let reads = 0;
    host.request = async (path, body) => {
      if (path === '/session-status' && ++reads === 1) {
        return held.promise;
      }
      if (path === '/save-features') {
        state.status.features = { matter: true };
        return { ok: true, features: { matter: true } };
      }
      return original(path, body);
    };
    const previous = controller.refreshStatus();
    await controller.mutate('/save-features', { features: { matter: true } });
    const current = controller.refreshStatus();
    held.resolve(previousStatus);
    await Promise.all([previous, current]);
    expect(controller.getSnapshot().status?.features?.matter).toBe(true);
  });

  it('coalesces status reads, bounds timed-out raw requests, and recovers after a slot settles', async () => {
    vi.useFakeTimers();
    const { controller, state, host } = fixture();
    await controller.initialize();
    const held: ReturnType<typeof deferred<unknown>>[] = [];
    host.request = () => {
      const call = deferred<unknown>(); held.push(call); return call.promise;
    };
    const concurrent = Array.from({ length: 8 }, () => controller.refreshStatus());
    await vi.advanceTimersByTimeAsync(10001);
    await Promise.all(concurrent);
    expect(held).toHaveLength(1);
    await controller.refreshStatus();
    expect(held).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30000);
    const retry = controller.refreshStatus();
    await vi.advanceTimersByTimeAsync(10001); await retry;
    await vi.advanceTimersByTimeAsync(30000);
    await controller.refreshStatus();
    expect(held).toHaveLength(2);
    held[0]!.resolve(state.status);
    await Promise.resolve(); await Promise.resolve();
    host.request = async () => state.status;
    await vi.advanceTimersByTimeAsync(30000);
    await controller.refreshStatus();
    expect(controller.getSnapshot()).toMatchObject({ error: '', ready: true });
    held[1]!.resolve(state.status);
  });

  it('refreshes inventory status once when discovery changes and keeps runtime-only updates local', async () => {
    const { controller, state, host } = fixture();
    state.diagnostics.generatedAt = '2026-10-02T00:00:00Z';
    const original = host.request;
    let statusReads = 0;
    host.request = (path, body) => {
      if (path === '/session-status') {
        statusReads++;
      }
      return original(path, body);
    };
    await controller.initialize(); await controller.refreshDiagnostics();
    for (let index = 0; index < 30; index++) {
      state.diagnostics.updatedAt = new Date().toISOString();
      await controller.refreshDiagnostics();
    }
    expect(statusReads).toBe(1);
    state.status.scope = { mode: 'all' };
    state.diagnostics.generatedAt = '2026-10-02T00:01:00Z';
    await controller.refreshDiagnostics();
    expect(controller.getSnapshot().status?.scope).toEqual({ mode: 'all' });
    expect(statusReads).toBe(2);
    await controller.refreshDiagnostics();
    expect(statusReads).toBe(2);
  });

  it('retries a failed account status check after backoff even without a new discovery snapshot', async () => {
    vi.useFakeTimers();
    const { controller, state, host } = fixture();
    await controller.initialize(); await controller.refreshDiagnostics();
    const original = host.request;
    host.request = async (path, body) => {
      if (path === '/session-status') {
        throw new Error('offline');
      }
      return original(path, body);
    };
    await controller.refreshStatus();
    expect(controller.getSnapshot().ready).toBe(false);
    host.request = original;
    await vi.advanceTimersByTimeAsync(30001);
    state.diagnostics.updatedAt = new Date().toISOString();
    await controller.refreshDiagnostics();
    expect(controller.getSnapshot()).toMatchObject({ ready: true, error: '' });
  });

  it('refreshes changed saved settings without rediscovery and does not reread unchanged runtime events', async () => {
    const { controller, state, host } = fixture();
    state.status.settingsRevision = 'settings-a';
    state.status.features = { matter: false };
    Object.assign(state.diagnostics, { generatedAt: '2026-10-02T00:00:00Z', settingsRevision: 'settings-a' });
    const original = host.request;
    let reads = 0;
    host.request = (path, body) => {
      if (path === '/session-status') {
        reads++;
      }
      return original(path, body);
    };
    await controller.initialize(); await controller.refreshDiagnostics();
    state.status.settingsRevision = 'settings-b'; state.status.features = { matter: true };
    Object.assign(state.diagnostics, { settingsRevision: 'settings-b' });
    await controller.refreshDiagnostics();
    expect(controller.getSnapshot().status?.features?.matter).toBe(true);
    await controller.refreshDiagnostics(); await controller.refreshDiagnostics();
    expect(reads).toBe(2);
  });

  it('detects a settings change between initial status and the first diagnostics read', async () => {
    const { controller, state } = fixture();
    state.status.settingsRevision = 'settings-a'; state.status.features = { matter: false };
    await controller.initialize();
    state.status.settingsRevision = 'settings-b'; state.status.features = { matter: true };
    Object.assign(state.diagnostics, { settingsRevision: 'settings-b' });
    await controller.refreshDiagnostics();
    expect(controller.getSnapshot().status?.features?.matter).toBe(true);
  });

  it('lets the new account read diagnostics while the previous account request is still unresolved', async () => {
    const { controller, state, host } = fixture();
    await controller.initialize();
    const oldDiagnostics = deferred<unknown>();
    const original = host.request;
    host.request = (path, body) => path === '/diagnostics' ? oldDiagnostics.promise : original(path, body);
    const previous = controller.refreshDiagnostics();
    await Promise.resolve();
    state.status.uiSessionRevision = 'two'; state.diagnostics.uiSessionRevision = 'two';
    await controller.refreshStatus();
    host.request = original;
    const current = controller.refreshDiagnostics();
    // New-account state must be available without waiting for the held old request.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const observed = controller.getSnapshot();
    oldDiagnostics.resolve({ ...state.diagnostics, uiSessionRevision: 'one' });
    await Promise.all([previous, current]);
    expect(observed).toMatchObject({ revision: 'two', controlsReady: true });
    expect(controller.getSnapshot().diagnostics?.uiSessionRevision).toBe('two');
  });

  it('does not repeatedly read cloud inventory while waiting for a dirty account-switch confirmation', async () => {
    const { controller, state, host } = fixture();
    await controller.initialize(); await controller.refreshDiagnostics();
    controller.setDirty('device', true);
    const original = host.request;
    let reads = 0;
    host.request = (path, body) => {
      if (path === '/session-status') {
        reads++;
      }
      return original(path, body);
    };
    state.status.uiSessionRevision = 'two'; state.diagnostics.uiSessionRevision = 'two';
    await controller.refreshDiagnostics();
    await controller.refreshDiagnostics(); await controller.refreshDiagnostics();
    expect(controller.getSnapshot().accountChangePending).toBe(true);
    expect(reads).toBe(1);
  });

  it('reconciles power ACKs into both sources before unrelated complete preference ACKs publish', async () => {
    const { controller, state, host } = fixture();
    state.status.features = { devices: { p: { powerSpec: { activeWatts: 5 } }, q: {} } };
    state.diagnostics.devices = [
      { id: 'p', name: 'Plug', deviceType: 'Plug', preference: { powerSpec: { activeWatts: 5 } } },
      { id: 'q', name: 'Other', deviceType: 'Plug', preference: {} },
    ];
    await controller.initialize(); await controller.refreshDiagnostics();
    host.request = async (path) => path === '/save-power-specs'
      ? { ok: true, uiSessionRevision: 'one', powerSpecs: [{ deviceId: 'p', activeWatts: 10, standbyWatts: null }] }
      : { ok: true, deviceId: 'q', preference: { name: 'Renamed' } };
    await controller.mutate('/save-power-specs', {});
    await controller.mutate('/save-device-settings', { deviceId: 'q' });
    expect(controller.getSnapshot().diagnostics?.devices[0]?.preference?.powerSpec).toEqual({ activeWatts: 10 });
    expect(controller.getSnapshot().status?.features?.devices?.p?.powerSpec).toEqual({ activeWatts: 10 });
    host.request = async () => ({ ok: true, deviceId: 'p', preference: { name: 'Plug renamed', powerSpec: { activeWatts: 15 } } });
    await controller.mutate('/save-device-settings', { deviceId: 'p' });
    expect(controller.getSnapshot().diagnostics?.devices[0]?.preference?.powerSpec).toEqual({ activeWatts: 15 });
    host.request = async () => ({ ok: true, deviceId: 'p', preference: { name: 'Power removed elsewhere' } });
    await controller.mutate('/save-device-settings', { deviceId: 'p' });
    expect(controller.getSnapshot().diagnostics?.devices[0]?.preference?.powerSpec).toBeUndefined();
  });
  it('does not make missing, stale or cached-only device evidence writable', async () => {
    const { controller, state } = fixture();
    await controller.initialize();
    await controller.refreshDiagnostics();
    expect(controller.getSnapshot().controlsReady).toBe(true);
    state.diagnostics.updatedAt = new Date(Date.now() - 60000).toISOString();
    await controller.refreshDiagnostics();
    expect(controller.getSnapshot().controlsReady).toBe(false);
    expect(controller.getSnapshot().fresh).toBe(false);
    state.diagnostics.updatedAt = null;
    await controller.refreshDiagnostics();
    expect(controller.getSnapshot().writable).toBe(false);
  });

  it('rejects an old account save response and guards drafts before accepting a changed account', async () => {
    const { controller, state, host } = fixture();
    await controller.initialize();
    await controller.refreshDiagnostics();
    controller.setDirty('device:a', true);
    const held = deferred<unknown>();
    const original = host.request;
    host.request = (path, body) => path === '/save-features' ? held.promise : original(path, body);
    const save = controller.mutate('/save-features', { features: { matter: true } });
    state.status.uiSessionRevision = 'two';
    await controller.refreshStatus();
    expect(controller.getSnapshot().accountChangePending).toBe(true);
    expect(controller.getSnapshot().writable).toBe(false);
    held.resolve({ ok: true, features: { matter: true } });
    await expect(save).rejects.toBeInstanceOf(StaleAccountError);
    expect(controller.getSnapshot().status?.features?.matter).not.toBe(true);
    controller.setConfirmHandler(async () => false);
    await controller.resolveAccountChange();
    expect(controller.getSnapshot().hasDirty).toBe(true);
    controller.setConfirmHandler(async () => true);
    await controller.resolveAccountChange();
    expect(controller.getSnapshot().accountChangePending).toBe(false);
    expect(controller.getSnapshot().hasDirty).toBe(false);
    expect(controller.getSnapshot().status?.uiSessionRevision).toBe('two');
  });

  it('fences writes as soon as diagnostics show a different owner while account status is still loading', async () => {
    const { controller, state, host } = fixture();
    await controller.initialize(); await controller.refreshDiagnostics();
    controller.setDirty('power', true);
    const epoch = controller.getSnapshot().accountEpoch;
    const held = deferred<unknown>();
    const original = host.request;
    host.request = (path, body) => path === '/session-status' ? held.promise : original(path, body);
    state.diagnostics.uiSessionRevision = 'two';
    const refresh = controller.refreshDiagnostics();
    await vi.waitFor(() => expect(controller.getSnapshot().accountChangePending).toBe(true));
    expect(controller.getSnapshot().accountEpoch).toBe(epoch);
    await expect(controller.mutate('/save-features', {}, { requireFresh: false })).rejects.toThrow();
    held.resolve({ configured: true, sessionValid: true, uiSessionRevision: 'two' });
    await refresh;
    expect(controller.getSnapshot().hasDirty).toBe(true);
  });

  it('blocks previously writable settings after a failed session-status verification', async () => {
    const { controller, host } = fixture();
    await controller.initialize(); await controller.refreshDiagnostics();
    expect(controller.getSnapshot().ready).toBe(true);
    host.request = async () => {
      throw new Error('offline');
    };
    await controller.refreshStatus();
    expect(controller.getSnapshot().ready).toBe(false);
    expect(controller.getSnapshot().error).not.toBe('');
    await expect(controller.mutate('/save-features', {}, { requireFresh: false })).rejects.toThrow();
  });

  it('does not let a late login response clear a newer account login operation', async () => {
    const { controller, state, host } = fixture();
    await controller.initialize();
    const oldLogin = deferred<unknown>();
    const newLogin = deferred<unknown>();
    const original = host.request;
    let loginCalls = 0;
    host.request = (path, body) => path === '/login' ? (++loginCalls === 1 ? oldLogin.promise : newLogin.promise) : original(path, body);
    controller.beginLogin();
    const oldAttempt = controller.login('old@example.test', 'old');
    const oldFailure = expect(oldAttempt).rejects.toBeInstanceOf(StaleAccountError);
    await Promise.resolve();
    state.status.uiSessionRevision = 'two';
    await controller.refreshStatus();
    controller.beginLogin();
    const newAttempt = controller.login('new@example.test', 'new');
    await Promise.resolve();
    oldLogin.resolve({ ok: true }); await oldFailure;
    expect(controller.getSnapshot().busy).toBe(true);
    newLogin.resolve({ ok: true, uiSessionRevision: 'two' }); await newAttempt;
    expect(controller.getSnapshot().busy).toBe(false);
  });

  it('does not let an old account unresolved mutation block a new account save with the same key', async () => {
    const { controller, state, host } = fixture();
    await controller.initialize(); await controller.refreshDiagnostics();
    const oldSave = deferred<unknown>();
    const original = host.request;
    let writes = 0;
    host.request = (path, body) => path === '/save-features'
      ? ++writes === 1 ? oldSave.promise : Promise.resolve({ ok: true, features: { matter: true } }) : original(path, body);
    const previous = controller.mutate('/save-features', { features: { matter: false } });
    const previousFailure = expect(previous).rejects.toBeInstanceOf(StaleAccountError);
    await Promise.resolve();
    state.status.uiSessionRevision = 'two'; state.diagnostics.uiSessionRevision = 'two';
    await controller.refreshStatus(); await controller.refreshDiagnostics();
    await expect(controller.mutate('/save-features', { features: { matter: true } })).resolves.toMatchObject({ ok: true });
    oldSave.resolve({ ok: true, features: { matter: false } }); await previousFailure;
    expect(controller.getSnapshot().status?.features?.matter).toBe(true);
  });

  it.each([false, true])('binds dirty logout confirmation to its opening account (accountChanged=%s)', async (accountChanged) => {
    const { controller, state, host } = fixture();
    await controller.initialize();
    controller.setDirty('device:one', true);
    const confirmation = deferred<boolean>();
    controller.setConfirmHandler(() => confirmation.promise);
    const original = host.request;
    const logoutOwners: Array<string | null | undefined> = [];
    host.request = (path, body) => {
      if (path === '/logout') {
        logoutOwners.push(state.status.uiSessionRevision);
        return Promise.resolve({ ok: true });
      }
      return original(path, body);
    };
    const signingOut = controller.logout();
    if (accountChanged) {
      state.status.uiSessionRevision = 'two';
      await controller.refreshStatus();
      expect(controller.getSnapshot().accountChangePending).toBe(true);
    }
    confirmation.resolve(true);
    await signingOut;
    if (accountChanged) {
      expect(logoutOwners).toEqual([]);
      expect(controller.getSnapshot()).toMatchObject({ revision: 'two', hasDirty: true, accountChangePending: true });
    } else {
      expect(logoutOwners).toEqual(['one']);
      expect(controller.getSnapshot()).toMatchObject({ phase: 'login', hasDirty: false });
    }
  });

  it('keeps drafts during same-account sign-in renewal', async () => {
    const { controller } = fixture();
    await controller.initialize();
    const draft = controller.getDraft('feature:matter', false);
    draft.setValue(true);
    controller.beginLogin();
    await controller.login('user@example.test', 'password');
    expect(controller.getSnapshot().phase).toBe('settings');
    expect(controller.getDraft('feature:matter', false).getSnapshot()).toMatchObject({ value: true, dirty: true });
  });

  it('limits unresolved diagnostics to two even after deadlines and applies retry backoff', async () => {
    vi.useFakeTimers();
    const { controller, host } = fixture();
    await controller.initialize();
    const held: ReturnType<typeof deferred<unknown>>[] = [];
    const original = host.request;
    host.request = (path, body) => {
      if (path !== '/diagnostics') {
        return original(path, body);
      }
      const call = deferred<unknown>(); held.push(call); return call.promise;
    };
    const first = controller.refreshDiagnostics();
    await vi.advanceTimersByTimeAsync(10001);
    await first;
    await controller.refreshDiagnostics();
    expect(held).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30000);
    const second = controller.refreshDiagnostics();
    await vi.advanceTimersByTimeAsync(10001);
    await second;
    await vi.advanceTimersByTimeAsync(30000);
    await controller.refreshDiagnostics();
    expect(held).toHaveLength(2);
    expect(controller.getSnapshot().notice).toMatch(/응답|responses/);
    held.forEach((call) => call.resolve({ devices: [] }));
    await Promise.resolve();
    expect(controller.getSnapshot().diagnostics?.controlsAvailable).not.toBe(true);
  });

  it('does not permit duplicate commands while a timed-out underlying request remains pending', async () => {
    vi.useFakeTimers();
    const { controller, host } = fixture();
    await controller.initialize(); await controller.refreshDiagnostics();
    const held = deferred<unknown>(); host.request = () => held.promise;
    const command = controller.mutate('/device-command', { deviceId: 'one' }, { timeoutMs: 100, key: 'command:one' });
    const failure = expect(command).rejects.toMatchObject({ name: 'RequestTimeoutError' });
    await vi.advanceTimersByTimeAsync(101); await failure;
    await expect(controller.mutate('/device-command', {}, { key: 'command:one' })).rejects.toThrow(/응답|pending/);
    held.resolve({ ok: true });
  });
});

describe('persistent draft acknowledgement', () => {
  it('discards to the latest external settings and preserves them in the next unrelated save', async () => {
    const draft = new DraftStore({ name: 'Original', visibility: 'homekit' });
    draft.setValue({ name: 'My edit', visibility: 'homekit' });
    draft.receive({ name: 'Other window', visibility: 'matter' });
    expect(draft.getSnapshot().value.name).toBe('My edit');
    draft.reset();
    draft.receive({ name: 'Other window', visibility: 'matter' });
    expect(draft.getSnapshot()).toMatchObject({ value: { name: 'Other window', visibility: 'matter' }, dirty: false });
    draft.setValue((previous) => ({ ...previous, name: 'Only name changed' }));
    let saved: unknown;
    await draft.save(async (value) => {
      saved = value; return value;
    });
    expect(saved).toEqual({ name: 'Only name changed', visibility: 'matter' });
  });

  it('keeps pending edits and uses the later ACK as the next reset baseline', async () => {
    const draft = new DraftStore({ name: 'Original', visibility: 'homekit' });
    draft.setValue({ name: 'Submitted', visibility: 'homekit' });
    const held = deferred<{ name: string; visibility: string }>();
    const save = draft.save(() => held.promise);
    draft.receive({ name: 'Other window', visibility: 'matter' });
    draft.setValue({ name: 'New edit', visibility: 'homekit' });
    held.resolve({ name: 'Submitted', visibility: 'homekit' }); await save;
    expect(draft.getSnapshot()).toMatchObject({ value: { name: 'New edit' }, dirty: true });
    draft.reset();
    expect(draft.getSnapshot().value).toEqual({ name: 'Submitted', visibility: 'homekit' });
  });
  it('explicitly accepts a newer external baseline after a dirty save conflict and uses it for future resets', async () => {
    const draft = new DraftStore({ selection: 'old' });
    draft.setValue({ selection: 'mine' });
    await expect(draft.save(async () => {
      throw new Error('conflict');
    })).rejects.toThrow('conflict');
    draft.receive({ selection: 'latest' });
    expect(draft.getSnapshot()).toMatchObject({ value: { selection: 'mine' }, dirty: true, error: 'conflict' });
    draft.resetTo({ selection: 'latest' });
    draft.receive({ selection: 'latest' });
    expect(draft.getSnapshot()).toMatchObject({ value: { selection: 'latest' }, dirty: false, error: '' });
    draft.setValue({ selection: 'another edit' });
    draft.reset();
    expect(draft.getSnapshot()).toMatchObject({ value: { selection: 'latest' }, dirty: false });
  });

  it('does not replace a pending save baseline with an explicit reset', async () => {
    const draft = new DraftStore({ selection: 'old' });
    draft.setValue({ selection: 'submitted' });
    const acknowledgement = deferred<{ selection: string }>();
    const save = draft.save(() => acknowledgement.promise);
    draft.resetTo({ selection: 'external' });
    expect(draft.getSnapshot()).toMatchObject({ value: { selection: 'submitted' }, pending: true, dirty: true });
    acknowledgement.resolve({ selection: 'acknowledged' });
    await save;
    draft.setValue({ selection: 'edited again' });
    draft.reset();
    expect(draft.getSnapshot()).toMatchObject({ value: { selection: 'acknowledged' }, pending: false, dirty: false });
  });

  it('preserves edits made while save is pending even when reverted to the previous baseline', async () => {
    const draft = new DraftStore({ name: 'Original' });
    draft.setValue({ name: 'Submitted' });
    const held = deferred<{ name: string }>();
    const save = draft.save(() => held.promise);
    draft.setValue({ name: 'Original' });
    held.resolve({ name: 'Submitted' }); await save;
    expect(draft.getSnapshot()).toMatchObject({ value: { name: 'Original' }, dirty: true, pending: false });
    draft.receive({ name: 'Original' });
    expect(draft.getSnapshot().dirty).toBe(true);
  });
  it('retains edits after failed saves and ignores older external baseline after successful acknowledgement', async () => {
    const draft = new DraftStore({ enabled: false });
    draft.setValue({ enabled: true });
    await expect(draft.save(async () => {
      throw new Error('offline');
    })).rejects.toThrow('offline');
    expect(draft.getSnapshot()).toMatchObject({ dirty: true, error: 'offline' });
    await draft.save(async (value) => value);
    draft.receive({ enabled: false });
    expect(draft.getSnapshot()).toMatchObject({ value: { enabled: true }, dirty: false });
  });
});
