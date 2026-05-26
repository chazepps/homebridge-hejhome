import { createHash } from 'node:crypto';

import type { HejSession } from '../types.js';

const REFRESH_MARGIN_MS = 24 * 60 * 60 * 1000;

export interface SecretPreview {
  prefix4: string;
  length: number;
  sha256_8: string;
}

export interface SessionLogContext {
  identifierType: 'email' | 'phone';
  identifierLength: number;
  autoLogin: true;
  expiresAt: number;
  expiresAtIso: string;
  expiresInMs: number;
  refreshRecommendedAt: number;
  refreshRecommendedAtIso: string;
  accessTokenPreview: SecretPreview;
  sessionCookiePreview: SecretPreview;
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
    accessTokenPreview: previewSecret(session.accessToken),
    sessionCookiePreview: previewSecret(session.jsessionId),
  };
}

function previewSecret(value: string): SecretPreview {
  return {
    prefix4: value.slice(0, 4),
    length: value.length,
    sha256_8: createHash('sha256').update(value).digest('hex').slice(0, 8),
  };
}

function toIso(value: number): string {
  return new Date(value).toISOString();
}
