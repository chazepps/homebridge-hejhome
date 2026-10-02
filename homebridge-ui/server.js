import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import fs from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createHash, randomUUID } from 'node:crypto';

import { normalizeFeatures } from '../dist/features.js';

import { HejAuthClient } from '../dist/hej/auth.js';
import { HejRestClient } from '../dist/hej/rest.js';
import { DeviceSnapshotStore } from '../dist/storage/deviceSnapshotStore.js';
import { LogStore } from '../dist/storage/logStore.js';
import { SessionStore, sessionFingerprint } from '../dist/storage/sessionStore.js';
import {
  createDeviceSupportSummary,
  createUnsupportedDeviceIssueTemplate,
  SUPPORTED_DEVICE_MODELS,
} from '../dist/utils/deviceSupport.js';
import { sanitizeForLog } from '../dist/utils/redact.js';
import { createSessionLogContext } from '../dist/utils/sessionDiagnostics.js';
import { getDeviceCapability, supportsDeviceRole } from '../dist/devices/capabilities.js';
import { MAX_POWER_ESTIMATE_WATTS, powerEstimateSupport } from '../dist/runtime/powerEstimates.js';

class HejhomeUiServer extends HomebridgePluginUiServer {
  constructor() {
    super();

    this.authClient = new HejAuthClient({
      logger: (event) => this.logAuthEvent(event),
    });
    this.logStore = new LogStore(this.homebridgeStoragePath);
    this.sessionStore = new SessionStore(this.homebridgeStoragePath);
    this.snapshotStore = new DeviceSnapshotStore(this.homebridgeStoragePath);
    this.verifiedIdentifiers = new Set();
    this.configWrites = Promise.resolve();
    this.scopeEdits = new Map();
    this.uiAccountIdentifier = null;
    this.uiSessionRevision = randomUUID();
    this.statusFile = path.join(this.homebridgeStoragePath, 'hejhome', 'runtime-status.json');
    this.sessionFile = path.join(this.homebridgeStoragePath, 'hejhome', 'session.json');
    this.onStatusChanged = (current, previous) => {
      if (current.mtimeMs !== previous.mtimeMs) {
        this.pushEvent('hejhome-status-changed', { updated: true });
      }
    };
    watchFile(this.statusFile, { interval: 1500, persistent: false }, this.onStatusChanged);
    watchFile(this.sessionFile, { interval: 1500, persistent: false }, this.onStatusChanged);
    process.once('exit', () => {
      unwatchFile(this.statusFile, this.onStatusChanged);
      unwatchFile(this.sessionFile, this.onStatusChanged);
    });

    this.onRequest('/send-verification', this.handleSendVerification.bind(this));
    this.onRequest('/verify-code', this.handleVerifyCode.bind(this));
    this.onRequest('/login', this.handleLogin.bind(this));
    this.onRequest('/logout', this.handleLogout.bind(this));
    this.onRequest('/save-features', this.handleSaveFeatures.bind(this));
    this.onRequest('/save-scope', this.handleSaveScope.bind(this));
    this.onRequest('/session-status', this.handleSessionStatus.bind(this));
    this.onRequest('/diagnostics', this.handleDiagnostics.bind(this));
    this.onRequest('/diagnostics-export', this.handleDiagnosticsExport.bind(this));
    this.onRequest('/save-device-settings', this.handleSaveDeviceSettings.bind(this));
    this.onRequest('/save-power-specs', this.handleSavePowerSpecs.bind(this));
    this.onRequest('/remote-command', this.handleRemoteCommand.bind(this));
    this.onRequest('/air-conditioner-command', this.handleAirConditionerCommand.bind(this));
    this.onRequest('/purifier-command', this.handlePurifierCommand.bind(this));
    this.onRequest('/ui-event', this.handleUiEvent.bind(this));

    this.log('ui-server.ready', {
      storagePathConfigured: Boolean(this.homebridgeStoragePath),
      configPathConfigured: Boolean(this.homebridgeConfigPath),
      homebridgeUiVersion: this.homebridgeUiVersion ?? 'unknown',
    });
    this.ready();
  }

  async handleSendVerification(payload) {
    return await this.timedRequest('send-verification', payload, async () => {
      const identifier = normalizeEmailIdentifier(payload?.identifier);
      this.log('send-verification.identifier', describeIdentifier(identifier));
      this.verifiedIdentifiers.delete(identifier);
      await this.authClient.sendVerificationCode(identifier);
      return { ok: true };
    }, '인증번호 전송에 실패했습니다.');
  }

  async handleVerifyCode(payload) {
    return await this.timedRequest('verify-code', payload, async () => {
      const identifier = normalizeEmailIdentifier(payload?.identifier);
      this.log('verify-code.identifier', {
        ...describeIdentifier(identifier),
        authCodeLength: String(payload?.authCode ?? '').length,
      });
      if (this.verifiedIdentifiers.has(identifier)) {
        this.log('verify-code.already-verified', describeIdentifier(identifier));
        return { ok: true, alreadyVerified: true };
      }
      await this.authClient.verifyCode(identifier, String(payload?.authCode ?? ''));
      this.verifiedIdentifiers.add(identifier);
      this.log('verify-code.verified', describeIdentifier(identifier));
      return { ok: true };
    }, '인증번호 확인에 실패했습니다.');
  }

  async handleLogin(payload) {
    return await this.timedRequest('login', payload, async () => {
      const identifier = normalizeEmailIdentifier(payload?.identifier);
      const password = String(payload?.password ?? '');
      this.log('login.input', {
        ...describeIdentifier(identifier),
        passwordPresent: password.length > 0,
        verificationCompleted: this.verifiedIdentifiers.has(identifier),
        autoLogin: true,
      });
      if (!this.verifiedIdentifiers.has(identifier)) {
        throw new Error('Email verification must be completed before password login.');
      }
      const session = await this.authClient.loginWithPassword({
        identifier,
        password,
        autoLogin: true,
      });
      this.log('login.session-created', createSessionLogContext(session));
      const saveStartedAt = performance.now();
      await this.sessionStore.save(session);
      this.scopeEdits.clear();
      const uiSessionRevision = this.revisionForAccount(session.identifier);
      this.pushEvent('hejhome-status-changed', { updated: true });
      this.log('login.session-saved', {
        durationMs: elapsed(saveStartedAt),
        storageScope: 'homebridge-storage/hejhome/session.json',
      });
      if (!await this.isCurrentOwner(sessionFingerprint(session)) || this.uiSessionRevision !== uiSessionRevision) {
        throw new Error('로그인 정보가 변경되었습니다. 다시 확인해 주세요.');
      }
      return {
        ok: true,
        uiSessionRevision,
        expiresAt: session.expiresAt,
        expiresAtIso: new Date(session.expiresAt).toISOString(),
        refreshRecommendedAtIso: createSessionLogContext(session).refreshRecommendedAtIso,
      };
    }, 'Hejhome 로그인에 실패했습니다.');
  }

  async handleLogout() {
    return await this.timedRequest('logout', {}, async () => {
      await this.sessionStore.clear();
      this.scopeEdits.clear();
      this.uiAccountIdentifier = null;
      this.uiSessionRevision = randomUUID();
      this.pushEvent('hejhome-status-changed', { updated: true });
      this.verifiedIdentifiers.clear();
      this.log('logout.session-cleared', {
        storageScope: 'homebridge-storage/hejhome/session.json',
      });
      return { ok: true };
    }, 'Hejhome 로그아웃에 실패했습니다.');
  }

  async handleSessionStatus() {
    return await this.timedRequest('session-status', {}, async () => {
      const { session, snapshot, owner } = await this.loadOwnedState();
      const platformConfig = await this.loadPlatformConfig();
      const scope = platformConfig.scope ?? { mode: 'first-family' };
      const features = normalizeFeatures(platformConfig.features);
      const deviceSummary = createDeviceSupportSummary(snapshot, scope);
      const baseStatus = {
        features,
        settingsRevision: configurationRevision(scope, features),
        scope,
        scopeEditToken: null,
        uiSessionRevision: null,
        deviceSummary,
        issueTemplate: createUnsupportedDeviceIssueTemplate(deviceSummary),
        supportedModels: SUPPORTED_DEVICE_MODELS,
      };

      let result = {
        configured: false,
        sessionValid: false,
        sessionCheckStatus: 'missing',
        ...baseStatus,
      };
      if (session?.accessToken) {
        const sessionContext = createSessionLogContext(session);
        const sessionCheckStartedAt = performance.now();
        let restClient;
        try {
          restClient = new HejRestClient(session, {
            logger: (event) => this.log('rest.request', event),
            requestTimeoutMs: 8000,
          });
          const families = await restClient.getFamilies();
          const scopeOptions = await this.buildScopeOptions(restClient, families);
          result = {
            configured: true,
            sessionValid: true,
            sessionCheckStatus: 'valid',
            sessionCheckDurationMs: elapsed(sessionCheckStartedAt),
            scopeOptions,
            ...sessionContext,
            ...baseStatus,
          };
        } catch (error) {
          result = {
            configured: true,
            sessionValid: false,
            sessionCheckStatus: isLikelyExpiredSession(error) ? 'invalid' : 'error',
            sessionCheckDurationMs: elapsed(sessionCheckStartedAt),
            message: sanitizeForLog(error instanceof Error ? error.message : String(error)),
            ...sessionContext,
            ...baseStatus,
          };
        } finally {
          restClient?.dispose?.();
        }
      }
      if (!await this.isSameOwner(owner)) {
        throw new Error('로그인 정보가 변경되었습니다. 다시 확인해 주세요.');
      }
      result.uiSessionRevision = this.revisionForAccount(session?.identifier);
      if (owner && result.scopeOptions?.complete === true) {
        result.scopeEditToken = this.issueScopeEdit(owner, scope, result.scopeOptions);
      } else if (owner) {
        this.invalidateScopeEdits(owner);
      }
      this.log('session-status.result', {
        configured: result.configured,
        sessionValid: result.sessionValid,
        sessionCheckStatus: result.sessionCheckStatus,
        sessionCheckDurationMs: result.sessionCheckDurationMs,
        expiresAtIso: result.expiresAtIso,
        refreshRecommendedAtIso: result.refreshRecommendedAtIso,
        deviceSummary: result.deviceSummary,
      });
      return result;
    }, 'Hejhome 세션 상태 확인에 실패했습니다.');
  }

  async handleSaveFeatures(payload) {
    return await this.timedRequest('features.save', {}, async () => {
      if (!payload?.features || typeof payload.features !== 'object' || Array.isArray(payload.features)) {
        throw new Error('설정 내용을 확인해 주세요.');
      }
      const requested = payload.features;
      if (Object.hasOwn(requested, 'devices')) {
        throw new Error('장치별 설정은 장치 목록에서 저장해 주세요.');
      }
      const saved = await this.savePlatformPatch((platform) => {
        const previous = normalizeFeatures(platform.features);
        return { features: normalizeFeatures({ ...previous, ...requested, devices: previous.devices }) };
      });
      const features = saved.features;
      return { ok: true, features };
    }, '베타 기능 설정을 확인해 주세요.');
  }

  async handleSaveDeviceSettings(payload) {
    return await this.timedRequest('device-settings.save', {}, async () => {
      if (payload?.preference && Object.hasOwn(payload.preference, 'powerSpec')) {
        throw new Error('소비전력 사양은 소비전력 설정에서 저장해 주세요.');
      }
      const id = String(payload?.deviceId ?? '');
      const normalized = normalizeFeatures({ devices: { [id]: payload?.preference } });
      const preference = normalized.devices?.[id];
      const { snapshot, owner } = await this.loadOwnedState();
      const device = snapshot?.families.flatMap((family) => family.devices).find((item) => item.id === id);
      if (!device) {
        throw new Error('장비 목록에서 이 장비를 찾을 수 없습니다. 목록을 새로 확인해 주세요.');
      }
      if (preference?.role && preference.role !== 'original'
        && !supportsDeviceRole(device.deviceType)) {
        throw new Error('이 장비는 표시 형태 변경을 지원하지 않습니다.');
      }
      if (preference?.temperatureSensorId) {
        const sensor = snapshot?.families.flatMap((family) => family.devices)
          .find((item) => item.id === preference.temperatureSensorId);
        if (device.deviceType !== 'IrAirconditioner'
          || !sensor || !['SensorTh', 'SensorTh2', 'SensorRefTh', 'SensorRefTh2'].includes(sensor.deviceType)) {
          throw new Error('선택한 온도계를 사용할 수 없습니다.');
        }
      }
      if (preference?.remoteButtons !== undefined) {
        if (!['IrTv', 'IrSettopbox', 'IrFan'].includes(device.deviceType)
          || (preference.remoteButtons && ['hidden', 'matter'].includes(preference.visibility))) {
          throw new Error('이 장치는 Apple Home 리모컨 버튼을 표시할 수 없습니다.');
        }
      }
      if (preference?.pm25Multiplier !== undefined && device.deviceType !== 'Airpurifier') {
        throw new Error('이 장치에는 PM2.5 보정을 사용할 수 없습니다.');
      }
      const saved = await this.savePlatformPatch(async (platform) => {
        if (!owner || !await this.isCurrentOwner(owner)) {
          throw new Error('로그인 정보가 변경되었습니다. 다시 확인해 주세요.');
        }
        const previous = normalizeFeatures(platform.features);
        if (preference?.freshnessMinutes !== undefined
          && !['SensorTh', 'SensorTh2', 'SensorRefTh', 'SensorRefTh2'].includes(device.deviceType)
          && !previous.meters.some((profile) => profile.model === device.modelName)
          && !(device.deviceType === 'Airpurifier' && preference.pm25Multiplier !== undefined)) {
          throw new Error('이 장치에는 측정값 유효 시간을 설정할 수 없습니다.');
        }
        const devices = { ...previous.devices };
        const nextPreference = { ...preference,
          ...(devices[id]?.powerSpec ? { powerSpec: devices[id].powerSpec } : {}) };
        if (Object.keys(nextPreference).length === 0) {
          delete devices[id];
        } else {
          devices[id] = nextPreference;
        }
        return { features: normalizeFeatures({ ...previous, devices }) };
      });
      return { ok: true, deviceId: id, preference: saved.features.devices?.[id] ?? {} };
    }, '장비 설정을 저장하지 못했습니다.');
  }

  async handleSavePowerSpecs(payload) {
    return await this.timedRequest('power-specs.save', {}, async () => {
      const updates = validatePowerSpecUpdates(payload);
      const { owner, session } = await this.loadOwnedState();
      if (!owner || payload.uiSessionRevision !== this.revisionForAccount(session?.identifier)) {
        throw new PowerSpecsError('power-specs-stale');
      }
      const validateCurrentState = async (platform) => {
        const current = await this.loadOwnedState();
        if (!current.owner || current.owner !== owner || !current.snapshot
          || payload.uiSessionRevision !== this.revisionForAccount(current.session?.identifier)) {
          throw new PowerSpecsError('power-specs-stale');
        }
        const scope = platform.scope ?? { mode: 'first-family' };
        if (!snapshotMatchesScope(current.snapshot, scope)) {
          throw new PowerSpecsError('power-specs-stale');
        }
        // A matching discovery scope proves which full-provider family selection produced this filtered snapshot.
        const available = new Set(current.snapshot.families.flatMap((entry) => entry.devices
          .filter((device) => scope.mode !== 'custom' || isDeviceInScope(device, entry, 0, scope)).map((device) => device.id)));
        const features = normalizeFeatures(platform.features);
        for (const update of updates) {
          if (!available.has(update.deviceId)) {
            throw new PowerSpecsError('power-specs-stale');
          }
          const saved = powerSpecValues(features.devices?.[update.deviceId]?.powerSpec);
          if (saved.activeWatts !== update.expected.activeWatts || saved.standbyWatts !== update.expected.standbyWatts) {
            throw new PowerSpecsError('power-specs-conflict');
          }
        }
        return features;
      };
      const saved = await this.savePlatformPatch(async (platform) => {
        const previous = await validateCurrentState(platform);
        const devices = { ...previous.devices };
        for (const update of updates) {
          const preference = { ...devices[update.deviceId] };
          const powerSpec = {};
          for (const key of ['activeWatts', 'standbyWatts']) {
            if (update[key] !== null) {
              powerSpec[key] = update[key];
            }
          }
          if (Object.keys(powerSpec).length > 0) {
            preference.powerSpec = powerSpec;
          } else {
            delete preference.powerSpec;
          }
          if (Object.keys(preference).length > 0) {
            devices[update.deviceId] = preference;
          } else {
            delete devices[update.deviceId];
          }
        }
        return { features: normalizeFeatures({ ...previous, devices }) };
      }, async () => {
        await validateCurrentState(await this.loadPlatformConfig());
      });
      return { ok: true, uiSessionRevision: payload.uiSessionRevision,
        powerSpecs: updates.map(({ deviceId }) => ({ deviceId, ...powerSpecValues(saved.features.devices?.[deviceId]?.powerSpec) })) };
    }, '소비전력 사양을 저장하지 못했습니다.');
  }

  async handleDiagnostics() {
    return await this.timedRequest('diagnostics', {}, async () => {
      const [{ session, owner, snapshot, runtime }, platform] = await Promise.all([this.loadOwnedState(), this.loadPlatformConfig()]);
      const features = normalizeFeatures(platform.features);
      const runtimeDevices = new Map((runtime?.devices ?? []).map((device) => [device.id, device]));
      const scope = platform.scope ?? { mode: 'first-family' };
      const devices = (snapshot?.families ?? []).flatMap((entry, familyIndex) => entry.devices.map((device) => {
        const observed = runtimeDevices.get(device.id);
        const inScope = isDeviceInScope(device, entry, familyIndex, scope);
        return {
          id: device.id,
          name: features.devices?.[device.id]?.name ?? device.name,
          deviceType: device.deviceType,
          modelName: device.modelName ?? null,
          online: observed?.online ?? null,
          lastSeenAt: observed?.lastSeenAt ?? null,
          lastControlAt: observed?.lastControlAt ?? null,
          lastControl: observed?.lastControl ?? 'unknown',
          temperatureCelsius: Number.isFinite(observed?.temperatureCelsius) ? observed.temperatureCelsius : null,
          hvacSettings: device.deviceType === 'IrAirconditioner' ? normalizeHvacSettings(observed?.hvacSettings) : null,
          purifierSettings: device.deviceType === 'Airpurifier' ? normalizePurifierSettings(observed?.purifierSettings) : null,
          homekit: observed?.homekit ?? false,
          matter: observed?.matter ?? false,
          meterProfileApplied: features.meters.some((profile) => profile.model === device.modelName),
          powerSpecEligibility: powerEstimateSupport(device),
          powerEstimateMeterPriority: features.meters.some((profile) => profile.model === device.modelName
            && Boolean(profile.power || profile.energy)),
          preference: features.devices?.[device.id] ?? {},
          inScope: Boolean(inScope),
          roleChangeSupported: supportsDeviceRole(device.deviceType),
        };
      }));
      if (!await this.isSameOwner(owner)) {
        throw new Error('로그인 정보가 변경되었습니다. 다시 확인해 주세요.');
      }
      return {
        generatedAt: snapshot?.generatedAt ?? null,
        updatedAt: runtime?.updatedAt ?? null,
        uiSessionRevision: this.revisionForAccount(session?.identifier),
        settingsRevision: configurationRevision(scope, features),
        deviceListAvailable: snapshotMatchesScope(snapshot, scope),
        controlsAvailable: runtime?.controlsAvailable === true,
        connection: runtime?.connection ?? { session: 'unknown', realtime: 'unknown' },
        devices,
      };
    }, '장비 상태를 불러오지 못했습니다.');
  }

  async handleDiagnosticsExport() {
    const diagnostics = await this.handleDiagnostics();
    const devices = diagnostics.devices.map((device) => ({
      deviceType: getDeviceCapability(device.deviceType)?.deviceType ?? 'unknown',
      online: device.online,
      homekit: device.homekit,
      matter: device.matter,
      lastControl: device.lastControl,
      meterProfileApplied: device.meterProfileApplied,
    }));
    return {
      version: 1,
      generatedAt: new Date().toISOString(),
      snapshotAt: diagnostics.generatedAt,
      runtimeAt: diagnostics.updatedAt,
      connection: {
        session: ['missing', 'valid', 'expired', 'unknown'].includes(diagnostics.connection?.session)
          ? diagnostics.connection.session : 'unknown',
        realtime: ['connecting', 'connected', 'disconnected', 'unknown'].includes(diagnostics.connection?.realtime)
          ? diagnostics.connection.realtime : 'unknown',
      },
      devices,
    };
  }

  async handleRemoteCommand(payload) {
    return await this.timedRequest('remote-command', {}, async () => {
      await this.requireOwnedDevice(payload?.deviceId, ['IrTv', 'IrSettopbox', 'IrFan']);
      const { sendRuntimeCommand } = await import('../dist/runtime/commands.js');
      await sendRuntimeCommand(this.homebridgeStoragePath,
        { deviceId: String(payload?.deviceId ?? ''), kind: 'remote', command: payload?.command });
      return { ok: true };
    }, '리모컨 명령을 보내지 못했습니다.');
  }

  async handleAirConditionerCommand(payload) {
    return await this.timedRequest('air-conditioner-command', {}, async () => {
      await this.requireOwnedDevice(payload?.deviceId, ['IrAirconditioner']);
      const { sendRuntimeCommand } = await import('../dist/runtime/commands.js');
      await sendRuntimeCommand(this.homebridgeStoragePath,
        { deviceId: String(payload?.deviceId ?? ''), kind: 'air-conditioner', command: payload?.command });
      return { ok: true };
    }, '에어컨 명령을 보내지 못했습니다.');
  }

  async handlePurifierCommand(payload) {
    return await this.timedRequest('purifier-command', {}, async () => {
      await this.requireOwnedDevice(payload?.deviceId, ['Airpurifier']);
      const { sendRuntimeCommand } = await import('../dist/runtime/commands.js');
      await sendRuntimeCommand(this.homebridgeStoragePath,
        { deviceId: String(payload?.deviceId ?? ''), kind: 'purifier', command: payload?.command });
      return { ok: true };
    }, '공기청정기 명령을 보내지 못했습니다.');
  }

  async handleSaveScope(payload) {
    return await this.timedRequest('scope.save', {}, async () => {
      const token = payload?.scopeEditToken;
      if (typeof token !== 'string' || !token) {
        throw new ScopeEditError('scope-edit-unavailable');
      }
      const ticket = this.scopeEdits.get(token);
      if (!ticket || ticket.pending || ticket.expiresAt <= Date.now()) {
        throw new ScopeEditError('scope-edit-stale');
      }
      const { owner } = await this.loadOwnedState();
      if (!owner || owner !== ticket.owner) {
        throw new ScopeEditError('scope-edit-stale');
      }
      const scope = validateScopeSelection(payload?.scope, ticket);
      const validateCommit = async () => {
        if (!await this.isCurrentOwner(ticket.owner) || this.scopeEdits.get(token) !== ticket
          || ticket.expiresAt <= Date.now()) {
          throw new ScopeEditError('scope-edit-stale');
        }
        const current = await this.loadPlatformConfig();
        if (scopeRevision(current.scope) !== ticket.revision) {
          throw new ScopeEditError('scope-edit-stale');
        }
      };
      ticket.pending = true;
      try {
        await this.savePlatformPatch(async (platform) => {
          if (!await this.isCurrentOwner(ticket.owner) || this.scopeEdits.get(token) !== ticket
            || scopeRevision(platform.scope) !== ticket.revision) {
            throw new ScopeEditError('scope-edit-stale');
          }
          return { scope };
        }, validateCommit);
      } catch (error) {
        ticket.pending = false;
        throw error;
      }
      this.scopeEdits.delete(token);
      const scopeEditToken = this.issueScopeEdit(ticket.owner, scope, ticket.options);
      const { snapshot } = await this.loadOwnedState();
      const deviceSummary = createDeviceSupportSummary(snapshot, scope);
      this.log('scope.save.persisted', {
        mode: scope.mode,
        familyCount: scope.includedFamilyIds?.length ?? 0,
      });
      return {
        ok: true,
        scope,
        scopeEditToken,
        deviceSummary,
        issueTemplate: createUnsupportedDeviceIssueTemplate(deviceSummary),
      };
    }, '집/방 설정 저장에 실패했습니다.');
  }

  async isCurrentOwner(owner) {
    const current = await this.sessionStore.load();
    return Boolean(current && sessionFingerprint(current) === owner);
  }

  async isSameOwner(owner) {
    const current = await this.sessionStore.load();
    return (current ? sessionFingerprint(current) : null) === owner;
  }

  issueScopeEdit(owner, scope, options) {
    const now = Date.now();
    for (const [token, ticket] of this.scopeEdits) {
      if (ticket.expiresAt <= now) {
        this.scopeEdits.delete(token);
      }
    }
    while (this.scopeEdits.size >= 64) {
      this.scopeEdits.delete(this.scopeEdits.keys().next().value);
    }
    const token = randomUUID();
    this.scopeEdits.set(token, { owner, revision: scopeRevision(scope), options, expiresAt: now + 30 * 60_000, pending: false });
    return token;
  }

  invalidateScopeEdits(owner) {
    for (const [token, ticket] of this.scopeEdits) {
      if (ticket.owner === owner) {
        this.scopeEdits.delete(token);
      }
    }
  }

  revisionForAccount(identifier) {
    if (typeof identifier === 'string' && identifier && identifier !== this.uiAccountIdentifier) {
      this.uiAccountIdentifier = identifier;
      this.uiSessionRevision = randomUUID();
    }
    return this.uiSessionRevision;
  }

  async loadOwnedState() {
    const session = await this.sessionStore.load();
    const owner = session ? sessionFingerprint(session) : null;
    const [snapshot, runtime] = await Promise.all([
      this.snapshotStore.load(),
      import('../dist/runtime/status.js').then(({ loadRuntimeStatus }) => loadRuntimeStatus(this.homebridgeStoragePath)),
    ]);
    if (!owner || !await this.isCurrentOwner(owner)) {
      return { session: null, owner: null, snapshot: null, runtime: null };
    }
    return {
      session, owner,
      snapshot: snapshot?.ownerFingerprint === owner ? snapshot : null,
      runtime: runtime?.ownerFingerprint === owner ? runtime : null,
    };
  }

  async requireOwnedDevice(value, types) {
    const id = String(value ?? '');
    const { snapshot, owner } = await this.loadOwnedState();
    const device = snapshot?.families.flatMap((entry) => entry.devices).find((entry) => entry.id === id);
    if (!owner || !device || !types.includes(device.deviceType) || !await this.isCurrentOwner(owner)) {
      throw new Error('현재 로그인에서 이 장치를 사용할 수 없습니다. 장치 목록을 다시 확인해 주세요.');
    }
    return device;
  }

  async loadPlatformConfig() {
    const config = await this.loadHomebridgeConfig();
    return findHejhomePlatformConfig(config) ?? { name: 'Hejhome', platform: 'Hejhome' };
  }

  savePlatformPatch(patch, validateBeforeRename) {
    const pending = this.configWrites.catch(() => undefined).then(() => this.writePlatformPatch(patch, validateBeforeRename));
    this.configWrites = pending;
    return pending;
  }

  async writePlatformPatch(patch, validateBeforeRename) {
    const config = await this.loadHomebridgeConfig();
    const platforms = Array.isArray(config.platforms) ? config.platforms : [];
    const platformIndex = platforms.findIndex((entry) => entry?.platform === 'Hejhome');
    const previous = platformIndex >= 0 ? platforms[platformIndex] : { name: 'Hejhome', platform: 'Hejhome' };
    const nextPlatform = { ...previous, ...(typeof patch === 'function' ? await patch(previous) : patch) };
    const nextPlatforms = platformIndex >= 0
      ? platforms.map((entry, index) => index === platformIndex ? nextPlatform : entry)
      : [...platforms, nextPlatform];
    const nextConfig = {
      ...config,
      platforms: nextPlatforms,
    };
    await this.saveHomebridgeConfig(nextConfig, async () => {
      if (JSON.stringify(await this.loadHomebridgeConfig()) !== JSON.stringify(config)) {
        throw new Error('설정이 변경되었습니다. 새로 확인한 뒤 다시 저장해 주세요.');
      }
      await validateBeforeRename?.();
    });
    return nextPlatform;
  }

  async loadHomebridgeConfig() {
    if (!this.homebridgeConfigPath) {
      throw new Error('Homebridge config path is not available.');
    }
    return JSON.parse(await fs.readFile(this.homebridgeConfigPath, 'utf8'));
  }

  async saveHomebridgeConfig(config, validateBeforeRename) {
    if (!this.homebridgeConfigPath) {
      throw new Error('Homebridge config path is not available.');
    }
    const temporaryPath = `${this.homebridgeConfigPath}.hejhome.tmp`;
    try {
      await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o600 });
      await validateBeforeRename?.();
      await fs.rename(temporaryPath, this.homebridgeConfigPath);
    } catch (error) {
      await fs.rm(temporaryPath, { force: true });
      throw error;
    }
  }

  async buildScopeOptions(restClient, families) {
    const familyOptions = [];
    let complete = families.length > 0;
    for (const [index, family] of families.entries()) {
      let rooms = [];
      try {
        rooms = await restClient.getRooms(family.familyId);
      } catch (error) {
        complete = false;
        this.log('scope-options.rooms.error', {
          familyId: family.familyId,
          message: sanitizeForLog(error instanceof Error ? error.message : String(error)),
        }, 'warn');
      }
      familyOptions.push({
        familyId: family.familyId,
        name: family.name,
        selected: index === 0,
        rooms: rooms.map((room) => ({
          roomId: room.room_id,
          name: room.name,
          selected: index === 0,
        })),
      });
    }
    return {
      defaultMode: 'first-family',
      families: familyOptions,
      complete,
    };
  }

  handleUiEvent(payload) {
    const safePayload = sanitizeForLog(payload ?? {});
    const eventName = normalizeUiEventName(safePayload.event);
    const eventData = { ...safePayload };
    delete eventData.event;
    this.log(eventName, eventData);
    return { ok: true };
  }

  async timedRequest(name, payload, fn, userMessage) {
    const startedAt = performance.now();
    this.log(`${name}.start`, summarizePayload(payload));
    try {
      const result = await fn();
      this.log(`${name}.success`, { durationMs: elapsed(startedAt) });
      return result;
    } catch (error) {
      this.log(`${name}.error`, {
        durationMs: elapsed(startedAt),
        error: sanitizeForLog(error instanceof Error ? error.message : String(error)),
      }, 'error');
      throw toRequestError(userMessage, error);
    }
  }

  logAuthEvent(event) {
    this.log(`auth.${event.phase}.${event.status}`, sanitizeForLog(event), event.status === 'error' ? 'error' : 'info');
  }

  log(event, data = {}, level = 'info') {
    const safeData = sanitizeForLog(withoutUiRevisions(data));
    void this.logStore.append(level, `ui.${event}`, safeData).catch((error) => {
      console.error(`[Hejhome UI] log-file.error ${sanitizeForLog(error instanceof Error ? error.message : String(error))}`);
    });
    const line = `[Hejhome UI] ui.${event} ${JSON.stringify(safeData)}`;
    if (level === 'error') {
      console.error(line);
      return;
    }
    console.log(line);
  }
}

function normalizeIdentifier(value) {
  return String(value ?? '').trim();
}

function findHejhomePlatformConfig(config) {
  return (Array.isArray(config?.platforms) ? config.platforms : [])
    .find((entry) => entry?.platform === 'Hejhome');
}

class ScopeEditError extends Error {
  constructor(code) {
    super(code === 'scope-edit-unavailable' ? '집/방 목록을 모두 불러온 뒤 다시 저장해 주세요.'
      : '집/방 목록이나 로그인 정보가 바뀌었습니다. 목록을 다시 확인해 주세요.');
    this.code = code;
  }
}

class PowerSpecsError extends Error {
  constructor(code) {
    super(code === 'power-specs-conflict' ? '저장된 소비전력 사양이 변경되었습니다. 목록을 다시 확인해 주세요.'
      : code === 'power-specs-stale' ? '장비 목록이나 로그인 정보가 변경되었습니다. 목록을 다시 확인해 주세요.'
        : '소비전력 사양은 0~1,000,000 W 사이의 숫자로 입력해 주세요. / Enter power specifications from 0 to 1,000,000 W.');
    this.code = code;
  }
}

function validatePowerSpecUpdates(payload) {
  const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  const watts = (value) => value === null || (typeof value === 'number' && Number.isFinite(value)
    && value >= 0 && value <= MAX_POWER_ESTIMATE_WATTS);
  if (!isObject(payload) || Object.keys(payload).some((key) => !['uiSessionRevision', 'updates'].includes(key))
    || typeof payload.uiSessionRevision !== 'string' || !payload.uiSessionRevision || !Array.isArray(payload.updates)
    || payload.updates.length === 0) {
    throw new PowerSpecsError('power-specs-invalid');
  }
  const ids = new Set();
  return payload.updates.map((update) => {
    if (!isObject(update) || Object.keys(update).some((key) => !['deviceId', 'activeWatts', 'standbyWatts', 'expected'].includes(key))
      || typeof update.deviceId !== 'string' || !update.deviceId.trim() || update.deviceId.length > 128
      || ['__proto__', 'prototype', 'constructor'].includes(update.deviceId) || ids.has(update.deviceId)
      || !isObject(update.expected) || Object.keys(update.expected).some((key) => !['activeWatts', 'standbyWatts'].includes(key))
      || !['activeWatts', 'standbyWatts'].every((key) => watts(update[key]) && watts(update.expected[key]))) {
      throw new PowerSpecsError('power-specs-invalid');
    }
    ids.add(update.deviceId);
    return { deviceId: update.deviceId, activeWatts: update.activeWatts, standbyWatts: update.standbyWatts,
      expected: { activeWatts: update.expected.activeWatts, standbyWatts: update.expected.standbyWatts } };
  });
}

function powerSpecValues(powerSpec) {
  return { activeWatts: powerSpec?.activeWatts ?? null, standbyWatts: powerSpec?.standbyWatts ?? null };
}

function isDeviceInScope(device, entry, familyIndex, scope) {
  const familyId = Number(entry.family.familyId);
  const roomIds = scope.includedRoomsByFamilyId?.[String(familyId)];
  return scope.mode === 'all' || (scope.mode === 'custom'
    ? scope.includedFamilyIds?.includes(familyId) && (!roomIds || roomIds.includes(Number(device.roomId)))
    : familyIndex === 0);
}

function snapshotMatchesScope(snapshot, scope) {
  const provenance = snapshot?.discoveryScope;
  return Boolean(provenance && ['all', 'custom', 'first-family'].includes(provenance.mode)
    && scopeRevision(provenance) === scopeRevision(scope));
}

function scopeRevision(scope) {
  return JSON.stringify(normalizeScope(scope ?? { mode: 'first-family' }));
}

function configurationRevision(scope, features) {
  return createHash('sha256').update(JSON.stringify([scopeRevision(scope), features])).digest('hex');
}

function validateScopeSelection(value, ticket) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ScopeEditError('scope-edit-stale');
  }
  if (value.mode === 'all' || value.mode === 'first-family') {
    return { mode: value.mode };
  }
  if (value.mode !== 'custom' || !Array.isArray(value.includedFamilyIds)
    || !value.includedRoomsByFamilyId || typeof value.includedRoomsByFamilyId !== 'object'
    || Array.isArray(value.includedRoomsByFamilyId)) {
    throw new ScopeEditError('scope-edit-stale');
  }
  const available = new Map(ticket.options.families.map((family) => [Number(family.familyId),
    new Set(family.rooms.map((room) => Number(room.roomId)))]));
  const familyIds = value.includedFamilyIds;
  if (new Set(familyIds).size !== familyIds.length
    || familyIds.some((id) => !Number.isSafeInteger(id) || !available.has(id))) {
    throw new ScopeEditError('scope-edit-stale');
  }
  const selectedRooms = {};
  for (const [key, rooms] of Object.entries(value.includedRoomsByFamilyId)) {
    const familyId = Number(key);
    if (!Number.isSafeInteger(familyId) || String(familyId) !== key || !familyIds.includes(familyId)
      || !Array.isArray(rooms) || new Set(rooms).size !== rooms.length
      || rooms.some((id) => !Number.isSafeInteger(id) || !available.get(familyId)?.has(id))) {
      throw new ScopeEditError('scope-edit-stale');
    }
    selectedRooms[key] = rooms;
  }
  return { mode: 'custom', includedFamilyIds: familyIds, includedRoomsByFamilyId: selectedRooms };
}

function normalizeScope(value) {
  const mode = value?.mode === 'all' || value?.mode === 'custom' || value?.mode === 'first-family'
    ? value.mode
    : 'first-family';
  if (mode !== 'custom') {
    return { mode };
  }

  const includedFamilyIds = Array.isArray(value?.includedFamilyIds)
    ? value.includedFamilyIds
      .map((familyId) => Number(familyId))
      .filter((familyId) => Number.isFinite(familyId))
    : [];
  const includedRoomsByFamilyId = {};
  const sourceRooms = value?.includedRoomsByFamilyId && typeof value.includedRoomsByFamilyId === 'object'
    ? value.includedRoomsByFamilyId
    : {};
  for (const familyId of includedFamilyIds) {
    const key = String(familyId);
    if (!Object.hasOwn(sourceRooms, key)) {
      continue;
    }
    includedRoomsByFamilyId[key] = Array.isArray(sourceRooms[key])
      ? sourceRooms[key]
        .map((roomId) => Number(roomId))
        .filter((roomId) => Number.isFinite(roomId))
      : [];
  }

  return {
    mode: 'custom',
    includedFamilyIds,
    includedRoomsByFamilyId,
  };
}

function normalizeEmailIdentifier(value) {
  const identifier = normalizeIdentifier(value);
  if (!isEmailIdentifier(identifier)) {
    throw new Error('현재 Homebridge 로그인은 이메일 인증만 지원합니다. 헤이홈 앱에 등록한 이메일을 입력해 주세요.');
  }
  return identifier;
}

function describeIdentifier(identifier) {
  return {
    identifierType: isEmailIdentifier(identifier) ? 'email' : 'unsupported',
    identifierLength: identifier.length,
  };
}

function isEmailIdentifier(identifier) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
}

function summarizePayload(payload) {
  const identifier = normalizeIdentifier(payload?.identifier);
  const summary = {
    keys: Object.keys(payload ?? {}),
    identifier: identifier ? describeIdentifier(identifier) : null,
  };
  if (Object.hasOwn(payload ?? {}, 'authCode')) {
    summary.authCodeLength = String(payload?.authCode ?? '').length;
  }
  if (Object.hasOwn(payload ?? {}, 'password')) {
    summary.passwordPresent = String(payload?.password ?? '').length > 0;
  }
  return sanitizeForLog(summary);
}

function normalizeUiEventName(value) {
  const event = String(value ?? '').trim();
  if (/^[a-z0-9][a-z0-9.-]{0,80}$/i.test(event) && !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(event)) {
    return event;
  }
  return 'event';
}

function withoutUiRevisions(value) {
  if (Array.isArray(value)) {
    return value.map(withoutUiRevisions);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value)
      .filter(([key]) => !['scopeEditToken', 'uiSessionRevision', 'settingsRevision'].includes(key))
      .map(([key, nested]) => [key, withoutUiRevisions(nested)]));
  }
  return value;
}

function elapsed(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function isLikelyExpiredSession(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(401|403)\b/.test(message);
}

function toRequestError(message, error) {
  return new RequestError(message, { detail: sanitizeForLog(error instanceof Error ? error.message : String(error)),
    ...(error instanceof ScopeEditError || error instanceof PowerSpecsError ? { code: error.code } : {}) });
}

function normalizeHvacSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    power: typeof source.power === 'boolean' ? source.power : null,
    targetTemperature: Number.isInteger(source.targetTemperature)
      && source.targetTemperature >= 16 && source.targetTemperature <= 30 ? source.targetTemperature : null,
    mode: ['cool', 'heat', 'auto', 'fan', 'dry'].includes(source.mode) ? source.mode : null,
    fanSpeed: ['auto', 'low', 'medium', 'high'].includes(source.fanSpeed) ? source.fanSpeed : null,
  };
}

function normalizePurifierSettings(value) {
  const source = value && typeof value === 'object' ? value : {};
  return {
    power: typeof source.power === 'boolean' ? source.power : null,
    mode: ['auto', 'manual', 'sleep'].includes(source.mode) ? source.mode : null,
  };
}

(() => new HejhomeUiServer())();
