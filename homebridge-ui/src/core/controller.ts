import { DraftStore } from './drafts.js';
import type { AppSnapshot, ConfirmOptions, DevicePreference, Diagnostics, Features, HomebridgeHost, RequestOptions, Scope, SessionStatus } from './types.js';

export class StaleAccountError extends Error {
  constructor() {
    super('계정이 변경되어 이전 요청을 적용하지 않았습니다.'); this.name = 'StaleAccountError';
  }
}
export function withDeadline<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([promise, new Promise<T>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(message); error.name = 'RequestTimeoutError'; reject(error);
    }, timeoutMs);
  })]).finally(() => clearTimeout(timer));
}
export function isEmailIdentifier(value: string) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

export class AppController {
  private snapshot: AppSnapshot = { language: 'ko', theme: 'dark', phase: 'initializing', status: null, diagnostics: null,
    revision: null, accountEpoch: 0, accountChangePending: false, fresh: false, ready: false, writable: false,
    controlsReady: false, error: '', notice: '', busy: false, hasDirty: false, hapCache: new Set(), matterCache: new Set() };
  private listeners = new Set<() => void>();
  private dirty = new Set<string>();
  private drafts = new Map<string, DraftStore<unknown>>();
  private confirmations: (options: ConfirmOptions) => Promise<boolean> = async () => false;
  private diagnosticsOutstanding = 0;
  private diagnosticsRetryAt = 0;
  private diagnosticsGeneration = 0;
  private diagnosticsFlight: { epoch: number; promise: Promise<void> } | null = null;
  private statusGeneration = 0;
  private statusOutstanding = 0;
  private statusRetryAt = 0;
  private statusVersion = 0;
  private statusFlight: { epoch: number; version: number; promise: Promise<SessionStatus> } | null = null;
  private inventoryAt: string | null | undefined;
  private settingsRevision: string | null | undefined;
  private statusRefreshNeeded = false;
  private pendingStatus: SessionStatus | null = null;
  private mutations = new Set<string>();
  private loginGeneration = 0;
  private activeLogin: { observedRevision: string | null; status: SessionStatus | null } | null = null;
  private requestEpoch = 0;
  private accountResetPending = false;
  private paused = false;
  constructor(readonly host: HomebridgeHost) {}
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener); return () => {
      this.listeners.delete(listener);
    };
  };
  t = (ko: string, en?: string) => this.snapshot.language === 'en' ? (en ?? ko) : ko;
  private publish(patch: Partial<AppSnapshot> = {}) {
    const next = { ...this.snapshot, ...patch };
    const stamp = Date.parse(next.diagnostics?.updatedAt ?? '');
    next.fresh = Number.isFinite(stamp) && Date.now() - stamp <= 30000 && Date.now() - stamp >= -5000;
    const owned = Boolean(next.revision && next.status?.uiSessionRevision === next.revision);
    next.ready = owned && next.status?.sessionValid === true && !next.accountChangePending && next.phase === 'settings'
      && !['expired', 'missing'].includes(next.diagnostics?.connection?.session ?? '');
    const diagnosticsOwned = next.diagnostics?.uiSessionRevision === next.revision;
    next.writable = next.ready && diagnosticsOwned && next.fresh && next.diagnostics?.deviceListAvailable === true
      && next.diagnostics?.connection?.session === 'valid';
    next.controlsReady = next.writable && next.diagnostics?.controlsAvailable === true;
    next.hasDirty = this.dirty.size > 0;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
  tick = () => this.publish();
  notify = (kind: 'success' | 'error' | 'warning' | 'info', message: string) => {
    this.host.toast?.[kind]?.(message);
  };
  setConfirmHandler(handler: (options: ConfirmOptions) => Promise<boolean>) {
    this.confirmations = handler;
  }
  confirm = (options: ConfirmOptions) => this.confirmations(options);
  setDirty = (key: string, dirty: boolean) => {
    if (this.dirty.has(key) === dirty) {
      return;
    }
    if (dirty) {
      this.dirty.add(key);
    } else {
      this.dirty.delete(key);
    }
    this.publish();
  };
  getDraft<T>(key: string, baseline: T): DraftStore<T> {
    let draft = this.drafts.get(key) as DraftStore<T> | undefined;
    if (!draft) {
      draft = new DraftStore(baseline);
      this.drafts.set(key, draft as DraftStore<unknown>);
      const owned = draft;
      draft.subscribe(() => this.setDirty(key, owned.getSnapshot().dirty || owned.getSnapshot().pending));
    }
    return draft;
  }
  private clearDrafts() {
    this.drafts.forEach((draft) => draft.invalidate()); this.drafts.clear(); this.dirty.clear();
  }
  private bumpEpoch(preserveLogin = false) {
    this.statusGeneration++; this.diagnosticsGeneration++;
    if (!preserveLogin) {
      this.loginGeneration++; this.activeLogin = null;
    }
    this.requestEpoch++;
    this.statusRetryAt = 0; this.diagnosticsRetryAt = 0;
    this.inventoryAt = undefined; this.settingsRevision = undefined; this.statusRefreshNeeded = false;
    this.accountResetPending = true;
    this.publish({ diagnostics: null, busy: preserveLogin && this.snapshot.busy, hapCache: new Set(), matterCache: new Set() });
  }
  private applyStatus(status: SessionStatus, returnToSettings = false, preserveLogin = false) {
    const revision = status.uiSessionRevision ?? null;
    if (this.snapshot.revision && revision && revision !== this.snapshot.revision) {
      if (this.activeLogin && !preserveLogin) {
        this.activeLogin.observedRevision = revision;
        this.activeLogin.status = status;
        return;
      }
      this.bumpEpoch(preserveLogin);
      this.pendingStatus = status;
      if (this.dirty.size) {
        this.publish({ revision, accountChangePending: true, phase: 'settings',
          notice: this.t('계정이 바뀌었어요. 이전 계정의 저장하지 않은 변경사항을 확인해 주세요.',
            'The account changed. Review unsaved changes from the previous account.') });
        return;
      }
    }
    if (this.accountResetPending) {
      this.clearDrafts(); this.accountResetPending = false;
      this.publish({ accountEpoch: this.snapshot.accountEpoch + 1 });
    }
    const phase = status.configured ? 'settings' : 'login';
    if (this.inventoryAt === undefined && (typeof status.deviceSummary?.generatedAt === 'string' || status.deviceSummary?.generatedAt === null)) {
      this.inventoryAt = status.deviceSummary.generatedAt;
    }
    if (typeof status.settingsRevision === 'string') {
      this.settingsRevision = status.settingsRevision;
    }
    this.pendingStatus = null;
    if (status.sessionCheckStatus === 'error') {
      this.deferStatusVerification();
    }
    this.publish({ status, revision, error: '', accountChangePending: false,
      phase: !returnToSettings && this.snapshot.phase === 'login' && status.configured ? 'login' : phase });
  }
  initialize = async () => {
    this.host.disableSaveButton?.(); this.host.hideSpinner?.();
    // Startup retry is an explicit user action; automatic refreshes retain backoff.
    // readStatus still coalesces the active flight and caps unsettled raw requests.
    this.statusRetryAt = 0;
    this.publish({ phase: 'initializing', error: '' });
    await this.updateAppearance();
    await this.refreshStatus();
  };
  updateAppearance = async () => {
    const [language, theme] = await Promise.all([
      withDeadline(Promise.resolve().then(() => this.host.i18nCurrentLang?.() ?? 'ko'), 2000, '').catch(() => 'ko'),
      withDeadline(Promise.resolve().then(() => this.host.userCurrentLightingMode?.() ?? 'dark'), 2000, '').catch(() => 'dark'),
    ]);
    this.publish({ language: /^en(?:-|$)/i.test(language) ? 'en' : 'ko', theme: theme === 'light' ? 'light' : 'dark' });
  };
  request = async <T,>(path: string, body: unknown = {}, options: RequestOptions = {}): Promise<T> => {
    const epoch = this.requestEpoch;
    const raw = Promise.resolve().then(() => {
      if (epoch !== this.requestEpoch) {
        throw new StaleAccountError();
      }
      return this.host.request(path, body);
    });
    const response = await withDeadline(raw, options.timeoutMs ?? 10000,
      this.t('응답이 지연되고 있습니다. 잠시 후 다시 확인해 주세요.', 'The response is taking longer than expected. Please check again.'));
    if (epoch !== this.requestEpoch) {
      throw new StaleAccountError();
    }
    return response as T;
  };
  private readStatus(): Promise<SessionStatus> {
    const epoch = this.requestEpoch;
    const version = this.statusVersion;
    if (this.statusFlight?.epoch === epoch && this.statusFlight.version === version) {
      return this.statusFlight.promise;
    }
    if (Date.now() < this.statusRetryAt || this.statusOutstanding >= 2) {
      return Promise.reject(new Error('Session status retry is waiting for an available request slot'));
    }
    this.statusOutstanding++;
    const raw = Promise.resolve().then(() => this.host.request('/session-status', {}));
    void raw.finally(() => {
      this.statusOutstanding--;
    }).catch(() => undefined);
    const promise = withDeadline(raw, 10000, 'Session status timeout').then((response) => {
      if (epoch !== this.requestEpoch || version !== this.statusVersion) {
        throw new StaleAccountError();
      }
      const status = response as SessionStatus;
      if (!status || typeof status.configured !== 'boolean') {
        throw new Error('Invalid session response');
      }
      this.statusRetryAt = 0;
      return status;
    }).catch((error: unknown) => {
      if (epoch === this.requestEpoch && !(error instanceof StaleAccountError)) {
        this.statusRetryAt = Date.now() + 30000;
      }
      throw error;
    }).finally(() => {
      if (this.statusFlight?.promise === promise) {
        this.statusFlight = null;
      }
    });
    this.statusFlight = { epoch, version, promise };
    return promise;
  }
  private deferStatusVerification() {
    this.statusRefreshNeeded = true;
    this.statusRetryAt = Date.now() + 30000;
  }
  refreshStatus = async () => {
    const generation = ++this.statusGeneration;
    const inventoryAt = this.inventoryAt;
    const settingsRevision = this.settingsRevision;
    try {
      const status = await this.readStatus();
      if (generation !== this.statusGeneration) {
        return;
      }
      if (this.snapshot.accountChangePending && status.uiSessionRevision === this.snapshot.revision) {
        this.pendingStatus = status;
        if (status.sessionCheckStatus === 'error') {
          this.deferStatusVerification();
        } else if (inventoryAt === this.inventoryAt && settingsRevision === this.settingsRevision) {
          this.statusRefreshNeeded = false;
        }
        return;
      }
      this.applyStatus(status);
      if (status.sessionCheckStatus !== 'error' && inventoryAt === this.inventoryAt && settingsRevision === this.settingsRevision) {
        this.statusRefreshNeeded = false;
      }
    } catch (error) {
      if (generation !== this.statusGeneration || error instanceof StaleAccountError) {
        return;
      }
      this.statusRefreshNeeded = true;
      const message = this.t('로그인 상태를 확인하지 못했어요. 기존 설정은 그대로입니다. 다시 확인해 주세요.',
        'Could not check sign-in. Existing settings remain. Please check again.');
      this.publish({ error: message, phase: this.snapshot.status ? this.snapshot.phase : 'error',
        status: this.snapshot.status ? { ...this.snapshot.status, sessionValid: false, sessionCheckStatus: 'error' } : null });
    }
  };
  refreshDiagnostics = (): Promise<void> => {
    const epoch = this.requestEpoch;
    if (this.diagnosticsFlight?.epoch === epoch) {
      return this.diagnosticsFlight.promise;
    }
    const flight = this.readDiagnostics().finally(() => {
      if (this.diagnosticsFlight?.promise === flight) {
        this.diagnosticsFlight = null;
      }
    });
    this.diagnosticsFlight = { epoch, promise: flight };
    return flight;
  };
  private readDiagnostics = async () => {
    if (this.paused || !['settings', 'login'].includes(this.snapshot.phase) || Date.now() < this.diagnosticsRetryAt) {
      return;
    }
    if (this.diagnosticsOutstanding >= 2) {
      this.publish({ diagnostics: this.snapshot.diagnostics ? { ...this.snapshot.diagnostics, controlsAvailable: false, deviceListAvailable: false } : null,
        notice: this.t('연결 응답이 멈췄어요. 설정 창을 닫았다 다시 열어 주세요.', 'Connection responses stopped. Close and reopen settings.') });
      return;
    }
    const generation = ++this.diagnosticsGeneration;
    const epoch = this.requestEpoch;
    this.diagnosticsOutstanding++;
    const raw = Promise.resolve().then(() => this.host.request('/diagnostics', {}));
    void raw.finally(() => {
      this.diagnosticsOutstanding--;
    }).catch(() => undefined);
    try {
      const diagnostics = await withDeadline(raw, 10000, 'Diagnostics timeout') as Diagnostics;
      if (generation !== this.diagnosticsGeneration || epoch !== this.requestEpoch || this.paused) {
        return;
      }
      if (!diagnostics || !Array.isArray(diagnostics.devices)) {
        throw new Error('Invalid diagnostics response');
      }
      if (diagnostics.uiSessionRevision && diagnostics.uiSessionRevision !== this.snapshot.revision) {
        if (this.activeLogin) {
          this.activeLogin.observedRevision = diagnostics.uiSessionRevision;
          if (this.activeLogin.status?.uiSessionRevision !== diagnostics.uiSessionRevision) {
            await this.refreshStatus();
          }
          return;
        }
        // Fence writes immediately; the slower status route establishes the new account's settings.
        this.bumpEpoch();
        this.publish({ revision: diagnostics.uiSessionRevision, accountChangePending: this.dirty.size > 0,
          notice: this.t('계정이 바뀌었어요. 새 계정의 설정을 확인하고 있어요.', 'The account changed. Checking the new account settings.') });
        await this.refreshStatus(); return;
      }
      if (!diagnostics.uiSessionRevision || diagnostics.uiSessionRevision !== this.snapshot.revision) {
        throw new Error('Missing diagnostics owner');
      }
      const inventoryAt = diagnostics.generatedAt ?? null;
      const settingsRevision = diagnostics.settingsRevision ?? null;
      if (this.inventoryAt !== undefined && inventoryAt !== this.inventoryAt
        || this.settingsRevision !== undefined && settingsRevision !== this.settingsRevision) {
        this.statusRefreshNeeded = true;
      }
      this.inventoryAt = inventoryAt;
      this.settingsRevision = settingsRevision;
      if (this.snapshot.accountChangePending || this.accountResetPending) {
        if (this.pendingStatus?.uiSessionRevision !== this.snapshot.revision || this.statusRefreshNeeded) {
          await this.refreshStatus();
        }
        return;
      }
      this.diagnosticsRetryAt = 0;
      this.publish({ diagnostics, notice: '' });
      void this.refreshCaches(epoch, generation);
      if (this.statusRefreshNeeded) {
        await this.refreshStatus();
      }
    } catch (error) {
      if (generation !== this.diagnosticsGeneration || epoch !== this.requestEpoch) {
        return;
      }
      this.diagnosticsRetryAt = Date.now() + 30000;
      this.publish({ diagnostics: this.snapshot.diagnostics ? { ...this.snapshot.diagnostics, controlsAvailable: false, deviceListAvailable: false } : null,
        notice: this.t('최근 상태를 확인할 수 없어요', 'Recent status unavailable') });
    }
  };
  private async refreshCaches(epoch: number, generation: number) {
    const [hap, matter] = await Promise.all([
      withDeadline(Promise.resolve().then(() => this.host.getCachedAccessories?.() ?? []), 3000, '').catch(() => []),
      withDeadline(Promise.resolve().then(() => this.host.getCachedMatterAccessories?.() ?? []), 3000, '').catch(() => []),
    ]);
    if (epoch !== this.requestEpoch || generation !== this.diagnosticsGeneration) {
      return;
    }
    this.publish({ hapCache: new Set(hap.map((item) => item.context?.device?.id).filter((id): id is string => Boolean(id))),
      matterCache: new Set(matter.map((item) => item.serialNumber || item.$deviceId).filter((id): id is string => Boolean(id))) });
  }
  mutate = async <T,>(path: string, body: unknown = {}, options: RequestOptions = {}): Promise<T> => {
    this.tick();
    if (!(options.requireFresh === false ? this.snapshot.ready : this.snapshot.writable)
      || (options.requireControls && !this.snapshot.controlsReady)) {
      throw new Error(this.t('현재 계정과 최근 상태를 확인한 뒤 다시 시도해 주세요.', 'Check the current account and recent status before trying again.'));
    }
    const key = `${this.requestEpoch}:${options.key ?? path}`;
    if (this.mutations.has(key)) {
      throw new Error(this.t('이전 요청의 응답을 기다리고 있습니다.', 'The previous request is still pending.'));
    }
    this.mutations.add(key);
    const epoch = this.requestEpoch;
    const raw = Promise.resolve().then(() => {
      if (epoch !== this.requestEpoch) {
        throw new StaleAccountError();
      }
      return this.host.request(path, body);
    });
    void raw.finally(() => this.mutations.delete(key)).catch(() => undefined);
    const response = await withDeadline(raw, options.timeoutMs ?? 10000,
      this.t('응답을 확인하지 못했어요. 기기 동작과 저장 상태를 확인해 주세요.', 'Could not confirm the response. Check the device and saved settings.'));
    if (epoch !== this.requestEpoch) {
      throw new StaleAccountError();
    }
    this.diagnosticsGeneration++; this.statusGeneration++; this.statusVersion++;
    this.reconcile(path, body, response);
    return response as T;
  };
  private reconcile(path: string, body: unknown, response: unknown) {
    if (!response || typeof response !== 'object') {
      return;
    }
    const result = response as Record<string, unknown>;
    const payload = body as Record<string, unknown>;
    const status = this.snapshot.status;
    if (path === '/save-features' && status && result.features) {
      this.publish({ status: { ...status, features: result.features as Features } });
    } else if (path === '/save-scope' && status && result.scope) {
      this.publish({ status: { ...status, scope: result.scope as Scope,
        scopeEditToken: result.scopeEditToken as string | null,
        ...((result.scopeOptions ?? status.scopeOptions)
          ? { scopeOptions: (result.scopeOptions ?? status.scopeOptions) as NonNullable<SessionStatus['scopeOptions']> } : {}) } });
    } else if (path === '/save-power-specs' && result.uiSessionRevision === this.snapshot.revision && Array.isArray(result.powerSpecs)) {
      const preferences = { ...status?.features?.devices };
      const acknowledged = new Map<string, DevicePreference>();
      for (const spec of result.powerSpecs as Array<{ deviceId: string; activeWatts: number | null; standbyWatts: number | null }>) {
        const previous = this.snapshot.diagnostics?.devices.find((device) => device.id === spec.deviceId)?.preference;
        const preference = { ...preferences[spec.deviceId], ...previous };
        delete preference.powerSpec;
        if (spec.activeWatts !== null || spec.standbyWatts !== null) {
          preference.powerSpec = { ...(spec.activeWatts !== null ? { activeWatts: spec.activeWatts } : {}),
            ...(spec.standbyWatts !== null ? { standbyWatts: spec.standbyWatts } : {}) };
        }
        preferences[spec.deviceId] = preference;
        acknowledged.set(spec.deviceId, preference);
      }
      this.publish({ status: status ? { ...status, features: { ...status.features, devices: preferences } } : null,
        diagnostics: this.snapshot.diagnostics ? { ...this.snapshot.diagnostics,
          devices: this.snapshot.diagnostics.devices.map((device) => acknowledged.has(device.id)
            ? { ...device, preference: acknowledged.get(device.id)! } : device) } : null });
    } else if (path === '/save-device-settings' && result.preference) {
      const id = String(payload.deviceId);
      // /save-device-settings returns the complete saved preference, including powerSpec deletion.
      const preference = result.preference as DevicePreference;
      this.publish({ status: status ? { ...status, features: { ...status.features,
        devices: { ...status.features?.devices, [id]: preference } } } : null,
      diagnostics: this.snapshot.diagnostics ? { ...this.snapshot.diagnostics,
        devices: this.snapshot.diagnostics.devices.map((device) => device.id === id
          ? { ...device, preference }
          : device) } : null });
    }
  }
  beginLogin = () => {
    this.loginGeneration++; this.activeLogin = null; this.diagnosticsGeneration++; this.publish({ phase: 'login', error: '' });
  };
  login = async (identifier: string, password: string) => {
    const generation = ++this.loginGeneration;
    const fromRevision = this.snapshot.revision;
    const attempt = { observedRevision: null as string | null, status: null as SessionStatus | null };
    this.activeLogin = attempt;
    this.publish({ busy: true, phase: 'login' });
    try {
      const ack = await this.request<{ uiSessionRevision?: string }>('/login', { identifier, password, autoLogin: true }, { timeoutMs: 45000 });
      if (generation !== this.loginGeneration) {
        throw new StaleAccountError();
      }
      this.statusGeneration++; this.statusVersion++; this.statusRetryAt = 0;
      // Only this login's server ACK authorizes crossing the account revision fence.
      const revision = ack.uiSessionRevision ?? fromRevision;
      if (attempt.observedRevision && attempt.observedRevision !== revision) {
        throw new StaleAccountError();
      }
      const status = attempt.status?.uiSessionRevision === revision ? attempt.status : await this.readStatus();
      if (generation !== this.loginGeneration) {
        throw new StaleAccountError();
      }
      if (status.uiSessionRevision !== revision || attempt.observedRevision && attempt.observedRevision !== revision) {
        attempt.status = status;
        throw new StaleAccountError();
      }
      this.applyStatus(status, true, true);
      this.notify('success', this.t('Hejhome 로그인이 저장되었습니다.', 'Hejhome sign-in saved.'));
    } catch (error) {
      if (generation === this.loginGeneration && attempt.status) {
        this.activeLogin = null;
        this.applyStatus(attempt.status);
      }
      throw error;
    } finally {
      if (this.activeLogin === attempt) {
        this.activeLogin = null;
      }
      if (generation === this.loginGeneration) {
        this.publish({ busy: false });
      }
    }
  };
  resolveAccountChange = async () => {
    if (!this.snapshot.accountChangePending) {
      return;
    }
    const epoch = this.requestEpoch;
    if (!await this.confirm({ title: this.t('새 계정으로 전환', 'Switch account'),
      description: this.t('이전 계정의 저장하지 않은 변경사항을 버릴까요?', 'Discard unsaved changes from the previous account?'),
      actionLabel: this.t('변경사항 버리기', 'Discard changes'), destructive: true })) {
      return;
    }
    if (epoch !== this.requestEpoch) {
      return;
    }
    this.clearDrafts();
    const next = this.pendingStatus;
    this.pendingStatus = null;
    this.accountResetPending = false;
    this.publish({ accountChangePending: false, notice: '', accountEpoch: this.snapshot.accountEpoch + 1 });
    if (next) {
      this.applyStatus(next, true);
    }
    await this.refreshStatus(); await this.refreshDiagnostics();
  };
  logout = async () => {
    if (this.snapshot.busy) {
      return;
    }
    const epoch = this.requestEpoch;
    if (this.dirty.size && !await this.confirm({ title: this.t('로그아웃', 'Sign out'),
      description: this.t('저장하지 않은 변경사항을 버리고 로그아웃할까요?', 'Discard unsaved changes and sign out?'), destructive: true })) {
      return;
    }
    if (epoch !== this.requestEpoch) {
      return;
    }
    this.publish({ busy: true });
    try {
      await this.request('/logout'); this.clearDrafts(); this.bumpEpoch(); this.accountResetPending = false;
      this.publish({ status: null, revision: null, phase: 'login', notice: '', accountChangePending: false,
        accountEpoch: this.snapshot.accountEpoch + 1 });
      this.notify('success', this.t('로그인 정보를 삭제했습니다.', 'Sign-in data removed.'));
    } catch (error) {
      if (!(error instanceof StaleAccountError)) {
        this.notify('error', error instanceof Error ? error.message : String(error));
      }
    } finally {
      this.publish({ busy: false });
    }
  };
  close = async () => {
    if (this.dirty.size && !await this.confirm({ title: this.t('설정 닫기', 'Close settings'),
      description: this.t('저장하지 않은 변경사항을 버리고 닫을까요?', 'Discard unsaved changes and close?'), destructive: true })) {
      return;
    }
    this.host.closeSettings?.();
  };
  setPaused(paused: boolean) {
    this.paused = paused; if (paused) {
      this.diagnosticsGeneration++;
    }
  }
}
