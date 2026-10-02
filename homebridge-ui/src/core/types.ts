import type { DevicePreference, MeterProfile } from '../../../src/features.js';

export type { DevicePreference, MeterProfile };
export type Language = 'ko' | 'en';
export type ThemeMode = 'light' | 'dark';
export type Phase = 'initializing' | 'login' | 'settings' | 'error';
export type Translate = (ko: string, en?: string) => string;
export interface Scope { mode: string; includedFamilyIds?: number[]; includedRoomsByFamilyId?: Record<string, number[]> }
export interface ScopeRoom { roomId: number; name: string; selected?: boolean }
export interface ScopeFamily { familyId: number; name: string; selected?: boolean; rooms: ScopeRoom[] }
export interface Features { matter?: boolean; adaptiveLighting?: boolean; meters?: MeterProfile[]; devices?: Record<string, DevicePreference> }
export interface SupportedModel { deviceType: string; label?: string; modelName?: string; homekit?: string[]; matter?: string[]; [key: string]: unknown }
export interface SessionStatus {
  configured: boolean; sessionValid: boolean; sessionCheckStatus?: string; uiSessionRevision?: string | null;
  expiresAtIso?: string; refreshRecommendedAtIso?: string; features?: Features; scope?: Scope; scopeEditToken?: string | null;
  scopeOptions?: { complete: boolean; families: ScopeFamily[] }; supportedModels?: SupportedModel[];
  deviceSummary?: Record<string, unknown>; issueTemplate?: string; message?: string; [key: string]: unknown;
}
export interface Device {
  id: string; name: string; deviceType: string; modelName?: string; familyName?: string; roomName?: string;
  inScope?: boolean; online?: boolean | null; homekit?: boolean; matter?: boolean; lastControl?: string;
  lastControlAt?: string | null; lastSeenAt?: string | null; temperatureCelsius?: number | null;
  meterProfileApplied?: boolean; roleChangeSupported?: boolean; preference?: DevicePreference;
  powerEstimateMeterPriority?: boolean; powerSpecEligibility?: { supported?: boolean; reason?: string; channelCount?: number };
  hvacSettings?: Record<string, unknown> | null; purifierSettings?: Record<string, unknown> | null;
  [key: string]: unknown;
}
export interface Diagnostics {
  uiSessionRevision?: string | null; generatedAt?: string | null; updatedAt?: string | null;
  controlsAvailable?: boolean; deviceListAvailable?: boolean; connection?: { session?: string; realtime?: string };
  devices: Device[];
}
export interface CachedAccessory { context?: { device?: { id?: string } }; serialNumber?: string; $deviceId?: string }
export interface HomebridgeHost {
  request(path: string, body?: unknown): Promise<unknown>;
  i18nCurrentLang?(): Promise<string>; userCurrentLightingMode?(): Promise<string>;
  getCachedAccessories?(): Promise<CachedAccessory[]>; getCachedMatterAccessories?(): Promise<CachedAccessory[]>;
  addEventListener?(event: string, handler: EventListener): void; removeEventListener?(event: string, handler: EventListener): void;
  toast?: Partial<Record<'success' | 'error' | 'warning' | 'info', (message: string) => void>>;
  fixScrollHeight?(): void; disableSaveButton?(): void; hideSpinner?(): void; showSpinner?(): void; closeSettings?(): void;
}
declare global { interface Window { homebridge: HomebridgeHost } }
export interface ConfirmOptions { title: string; description: string; actionLabel?: string; destructive?: boolean }
export interface RequestOptions { timeoutMs?: number; label?: string; requireControls?: boolean; requireFresh?: boolean; key?: string }
export interface AppSnapshot {
  language: Language; theme: ThemeMode; phase: Phase; status: SessionStatus | null; diagnostics: Diagnostics | null;
  revision: string | null; accountEpoch: number; accountChangePending: boolean; fresh: boolean; ready: boolean;
  writable: boolean; controlsReady: boolean; error: string; notice: string; busy: boolean; hasDirty: boolean;
  hapCache: ReadonlySet<string>; matterCache: ReadonlySet<string>;
}
