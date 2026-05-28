import { HomebridgePluginUiServer, RequestError } from '@homebridge/plugin-ui-utils';
import { performance } from 'node:perf_hooks';

import { HejAuthClient } from '../dist/hej/auth.js';
import { HejRestClient } from '../dist/hej/rest.js';
import { DeviceSnapshotStore } from '../dist/storage/deviceSnapshotStore.js';
import { LogStore } from '../dist/storage/logStore.js';
import { SessionStore } from '../dist/storage/sessionStore.js';
import {
  createDeviceSupportSummary,
  createUnsupportedDeviceIssueTemplate,
  SUPPORTED_DEVICE_MODELS,
} from '../dist/utils/deviceSupport.js';
import { sanitizeForLog } from '../dist/utils/redact.js';
import { createSessionLogContext } from '../dist/utils/sessionDiagnostics.js';

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

    this.onRequest('/send-verification', this.handleSendVerification.bind(this));
    this.onRequest('/verify-code', this.handleVerifyCode.bind(this));
    this.onRequest('/login', this.handleLogin.bind(this));
    this.onRequest('/logout', this.handleLogout.bind(this));
    this.onRequest('/session-status', this.handleSessionStatus.bind(this));
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
      this.verifiedIdentifiers.clear();
      this.log('logout.session-cleared', {
        storageScope: 'homebridge-storage/hejhome/session.json',
      });
      return { ok: true };
    }, 'Hejhome 로그아웃에 실패했습니다.');
  }

  async handleSessionStatus() {
    return await this.timedRequest('session-status', {}, async () => {
      const session = await this.sessionStore.load();
      const snapshot = await this.snapshotStore.load();
      const deviceSummary = createDeviceSupportSummary(snapshot);
      const baseStatus = {
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
        try {
          const restClient = new HejRestClient(session, {
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
        }
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

(() => new HejhomeUiServer())();
