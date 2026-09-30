import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import fs from 'node:fs/promises';
import { watchFile, unwatchFile } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

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
      await this.clearPreviousDeviceState();
      await this.sessionStore.save(session);
      this.pushEvent('hejhome-status-changed', { updated: true });
      this.log('login.session-saved', {
        durationMs: elapsed(saveStartedAt),
        storageScope: 'homebridge-storage/hejhome/session.json',
      });
      return {
        ok: true,
        expiresAt: session.expiresAt,
        expiresAtIso: new Date(session.expiresAt).toISOString(),
        refreshRecommendedAtIso: createSessionLogContext(session).refreshRecommendedAtIso,
      };
    }, 'Hejhome 로그인에 실패했습니다.');
  }

  async handleLogout() {
    return await this.timedRequest('logout', {}, async () => {
      await this.sessionStore.clear();
      await this.clearPreviousDeviceState();
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
      const deviceSummary = createDeviceSupportSummary(snapshot, scope);
      const baseStatus = {
        features: normalizeFeatures(platformConfig.features),
        scope,
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
      if (owner && !await this.isCurrentOwner(owner)) {
        throw new Error('로그인 정보가 변경되었습니다. 다시 확인해 주세요.');
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
        if (Object.keys(preference ?? {}).length === 0) {
          delete devices[id];
        } else {
          devices[id] = preference;
        }
        return { features: normalizeFeatures({ ...previous, devices }) };
      });
      return { ok: true, deviceId: id, preference: saved.features.devices?.[id] ?? {} };
    }, '장비 설정을 저장하지 못했습니다.');
  }

  async handleDiagnostics() {
    return await this.timedRequest('diagnostics', {}, async () => {
      const [{ snapshot, runtime }, platform] = await Promise.all([this.loadOwnedState(), this.loadPlatformConfig()]);
      const features = normalizeFeatures(platform.features);
      const runtimeDevices = new Map((runtime?.devices ?? []).map((device) => [device.id, device]));
      const scope = platform.scope ?? { mode: 'first-family' };
      const devices = (snapshot?.families ?? []).flatMap((entry, familyIndex) => entry.devices.map((device) => {
        const observed = runtimeDevices.get(device.id);
        const familyId = Number(entry.family.familyId);
        const roomIds = scope.includedRoomsByFamilyId?.[String(familyId)];
        const inScope = scope.mode === 'all' || (scope.mode === 'custom'
          ? scope.includedFamilyIds?.includes(familyId) && (!roomIds || roomIds.includes(Number(device.roomId)))
          : familyIndex === 0);
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
          preference: features.devices?.[device.id] ?? {},
          inScope: Boolean(inScope),
          roleChangeSupported: supportsDeviceRole(device.deviceType),
        };
      }));
      return {
        generatedAt: snapshot?.generatedAt ?? null,
        updatedAt: runtime?.updatedAt ?? null,
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
    return await this.timedRequest('scope.save', payload, async () => {
      const scope = normalizeScope(payload?.scope);
      await this.savePlatformScope(scope);
      const { snapshot } = await this.loadOwnedState();
      const deviceSummary = createDeviceSupportSummary(snapshot, scope);
      this.log('scope.save.persisted', {
        mode: scope.mode,
        familyCount: scope.includedFamilyIds?.length ?? 0,
      });
      return {
        ok: true,
        scope,
        deviceSummary,
        issueTemplate: createUnsupportedDeviceIssueTemplate(deviceSummary),
      };
    }, '집/방 설정 저장에 실패했습니다.');
  }

  async isCurrentOwner(owner) {
    const current = await this.sessionStore.load();
    return Boolean(current && sessionFingerprint(current) === owner);
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

  async clearPreviousDeviceState() {
    await Promise.all([
      fs.rm(this.snapshotStore.path, { force: true }), fs.rm(this.statusFile, { force: true }),
    ]);
  }

  async loadPlatformConfig() {
    const config = await this.loadHomebridgeConfig();
    return findHejhomePlatformConfig(config) ?? { name: 'Hejhome', platform: 'Hejhome' };
  }

  async savePlatformScope(scope) {
    return this.savePlatformPatch({ scope });
  }

  savePlatformPatch(patch) {
    const pending = this.configWrites.catch(() => undefined).then(() => this.writePlatformPatch(patch));
    this.configWrites = pending;
    return pending;
  }

  async writePlatformPatch(patch) {
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
    await this.saveHomebridgeConfig(nextConfig);
    return nextPlatform;
  }

  async loadHomebridgeConfig() {
    if (!this.homebridgeConfigPath) {
      throw new Error('Homebridge config path is not available.');
    }
    return JSON.parse(await fs.readFile(this.homebridgeConfigPath, 'utf8'));
  }

  async saveHomebridgeConfig(config) {
    if (!this.homebridgeConfigPath) {
      throw new Error('Homebridge config path is not available.');
    }
    const temporaryPath = `${this.homebridgeConfigPath}.hejhome.tmp`;
    await fs.writeFile(temporaryPath, `${JSON.stringify(config, null, 4)}\n`, { mode: 0o600 });
    await fs.rename(temporaryPath, this.homebridgeConfigPath);
  }

  async buildScopeOptions(restClient, families) {
    const familyOptions = [];
    for (const [index, family] of families.entries()) {
      let rooms = [];
      try {
        rooms = await restClient.getRooms(family.familyId);
      } catch (error) {
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
    const safeData = sanitizeForLog(data);
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
  if (/^[a-z0-9][a-z0-9.-]{0,80}$/i.test(event)) {
    return event;
  }
  return 'event';
}

function elapsed(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function isLikelyExpiredSession(error) {
  const message = error instanceof Error ? error.message : String(error);
  return /\b(401|403)\b/.test(message);
}

function toRequestError(message, error) {
  return new RequestError(message, {
    detail: sanitizeForLog(error instanceof Error ? error.message : String(error)),
  });
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
