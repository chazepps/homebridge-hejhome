import type { HejSession } from '../types.js';

export const HEJ_CLIENT_ID = '62f4020744ca4510827d3b4a4d2c7e7f';
export const HEJ_CLIENT_SECRET = 'fcd4302cece447a9ab009296f649d2c0';

const SQUARE_ORIGIN = 'https://square.hej.so';
const TWO_FACTOR_ORIGIN = 'https://2factor.goqual.com';

export interface LoginRequest {
  identifier: string;
  password: string;
  autoLogin?: boolean;
}

export interface HejAuthClientOptions {
  fetch?: typeof fetch;
  logger?: (event: HejAuthLogEvent) => void;
  now?: () => number;
  requestTimeoutMs?: number;
}

export interface HejAuthLogEvent {
  phase: string;
  status: 'start' | 'success' | 'error';
  durationMs?: number;
  httpStatus?: number;
  message?: string;
}

export class HejAuthClient {
  private readonly fetchImpl: typeof fetch;
  private readonly logger: ((event: HejAuthLogEvent) => void) | undefined;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;

  constructor(options: HejAuthClientOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.logger = options.logger;
    this.now = options.now ?? Date.now;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30000;
  }

  async sendVerificationCode(identifier: string): Promise<void> {
    if (!isEmail(identifier)) {
      throw new Error('Hejhome SMS verification is not supported. Use the email address registered in the Hejhome app.');
    }

    const response = await this.fetchWithTiming('2fa.send', verificationEndpoint(), {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ email: identifier }),
    });

    await ensureOk(response, 'Failed to send Hejhome verification code');
  }

  async verifyCode(identifier: string, authCode: string): Promise<void> {
    if (!/^\d{6}$/.test(authCode)) {
      throw new Error('Hejhome verification code must be exactly six digits');
    }

    const response = await this.fetchWithTiming('2fa.verify', `${TWO_FACTOR_ORIGIN}/api/2factor/verify`, {
      method: 'POST',
      headers: jsonHeaders(),
      body: JSON.stringify({ username: identifier, authCode }),
    });

    await ensureOk(response, 'Failed to verify Hejhome verification code');
  }

  async loginWithPassword(request: LoginRequest): Promise<HejSession> {
    if (!request.identifier.trim()) {
      throw new Error('Hejhome identifier is required');
    }
    if (!request.password) {
      throw new Error('Hejhome password is required');
    }

    const loginResponse = await this.fetchWithTiming('oauth.login', `${SQUARE_ORIGIN}/oauth/login?vendor=shop`, {
      method: 'POST',
      headers: {
        accept: 'text/plain, */*; q=0.01',
        'accept-language': 'ko-kr',
        authorization: makeBasicAuth(request.identifier, request.password),
        'content-type': 'application/x-www-form-urlencoded',
        'x-requested-with': 'XMLHttpRequest, XMLHttpRequest',
      },
    });
    await ensureOk(loginResponse, 'Failed to login to Hejhome');

    const jsessionId = parseJSessionId(loginResponse.headers.get('set-cookie'));
    if (!jsessionId) {
      throw new Error('Hejhome login did not return a session cookie');
    }

    const usernameCookie = encodeURIComponent(request.identifier);
    const code = await this.getAuthorizationCode(usernameCookie, jsessionId);
    const token = await this.exchangeAuthorizationCode(code, usernameCookie, jsessionId);

    return {
      identifier: request.identifier,
      autoLogin: true,
      accessToken: token.accessToken,
      jsessionId,
      usernameCookie,
      expiresAt: this.now() + token.expiresIn * 1000,
    };
  }

  private async getAuthorizationCode(usernameCookie: string, jsessionId: string): Promise<string> {
    const authorizeUrl = `${SQUARE_ORIGIN}/oauth/authorize?${new URLSearchParams({
      client_id: HEJ_CLIENT_ID,
      redirect_uri: `${SQUARE_ORIGIN}/list`,
      response_type: 'code',
      scope: 'shop',
    }).toString()}`;
    const response = await this.fetchWithTiming('oauth.authorize', authorizeUrl, {
      method: 'GET',
      redirect: 'manual',
      headers: {
        cookie: `username=${usernameCookie}; JSESSIONID=${jsessionId}; autoLogin=true`,
      },
    });
    const location = response.headers.get('location') ?? response.url;
    const code = location ? new URL(location, SQUARE_ORIGIN).searchParams.get('code') : null;
    if (!code) {
      throw new Error('Hejhome authorization did not return an OAuth code');
    }
    return code;
  }

  private async exchangeAuthorizationCode(
    code: string,
    usernameCookie: string,
    jsessionId: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const response = await this.fetchWithTiming('oauth.token', `${SQUARE_ORIGIN}/oauth/token`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/javascript, */*; q=0.01',
        authorization: makeBasicAuth(HEJ_CLIENT_ID, HEJ_CLIENT_SECRET),
        'content-type': 'application/x-www-form-urlencoded',
        cookie: `username=${usernameCookie}; JSESSIONID=${jsessionId}; autoLogin=true`,
        'x-requested-with': 'XMLHttpRequest',
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code,
        client_id: HEJ_CLIENT_ID,
        redirect_uri: `${SQUARE_ORIGIN}/list`,
      }),
    });
    await ensureOk(response, 'Failed to exchange Hejhome OAuth code');

    const body = await response.json() as { access_token?: string; expires_in?: number };
    if (!body.access_token) {
      throw new Error('Hejhome OAuth response did not include an access token');
    }

    return {
      accessToken: body.access_token,
      expiresIn: body.expires_in ?? 24 * 60 * 60,
    };
  }

  private async fetchWithTiming(phase: string, input: string | URL, init: RequestInit): Promise<Response> {
    const startedAt = this.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, this.requestTimeoutMs);

    this.emitLog({ phase, status: 'start' });

    try {
      const response = await this.fetchImpl(input, {
        ...init,
        signal: controller.signal,
      });
      this.emitLog({
        phase,
        status: 'success',
        durationMs: this.now() - startedAt,
        httpStatus: response.status,
      });
      return response;
    } catch (error) {
      const isAbort = error instanceof Error && error.name === 'AbortError';
      this.emitLog({
        phase,
        status: 'error',
        durationMs: this.now() - startedAt,
        message: isAbort
          ? `request timed out after ${this.requestTimeoutMs}ms`
          : error instanceof Error
            ? error.message
            : String(error),
      });
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  private emitLog(event: HejAuthLogEvent): void {
    this.logger?.(event);
  }
}

function verificationEndpoint(): string {
  return `${TWO_FACTOR_ORIGIN}/api/2factor/send/email?vendor=web`;
}

function isEmail(identifier: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(identifier);
}

function jsonHeaders(): HeadersInit {
  return {
    accept: '*/*',
    'content-type': 'application/json;charset=UTF-8',
  };
}

function makeBasicAuth(id: string, password: string): string {
  return `Basic ${Buffer.from(`${id}:${password}`, 'utf8').toString('base64')}`;
}

function parseJSessionId(setCookie: string | null): string | null {
  return setCookie?.match(/JSESSIONID=([^;]+)/)?.[1] ?? null;
}

async function ensureOk(response: Response, message: string): Promise<void> {
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`${message}: HTTP ${response.status}${text ? ` ${text}` : ''}`);
  }
}
