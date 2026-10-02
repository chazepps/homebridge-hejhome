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
    newLogin.resolve({ ok: true }); await newAttempt;
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
