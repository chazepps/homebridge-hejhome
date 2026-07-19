import type { HejSession } from '../types.js';

const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

export interface SessionLogContext {
  identifierType: 'email' | 'phone';
  identifierLength: number;
  autoLogin: true;
  expiresAt: number;
  expiresAtIso: string;
  expiresInMs: number;
  refreshRecommendedAt: number;
  refreshRecommendedAtIso: string;
  accessTokenPresent: boolean;
  sessionCookiePresent: boolean;
}

export function createSessionLogContext(session: HejSession, nowMs = Date.now()): SessionLogContext {
  const refreshRecommendedAt = Math.max(nowMs, session.expiresAt - REFRESH_MARGIN_MS);

  return {
    identifierType: session.identifier.includes('@') ? 'email' : 'phone',
    identifierLength: session.identifier.length,
    autoLogin: true,
    expiresAt: session.expiresAt,
    expiresAtIso: toIso(session.expiresAt),
    expiresInMs: Math.max(0, session.expiresAt - nowMs),
    refreshRecommendedAt,
    refreshRecommendedAtIso: toIso(refreshRecommendedAt),
    accessTokenPresent: session.accessToken.length > 0,
    sessionCookiePresent: session.jsessionId.length > 0,
  };
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}
