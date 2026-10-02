import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type PropsWithChildren } from 'react';
import { AlertDialog, Flex, Theme } from '@radix-ui/themes';
import { Button } from './radix.js';
import { AppController } from './controller.js';
import type { AppSnapshot, ConfirmOptions, HomebridgeHost, RequestOptions, Translate } from './types.js';
export * from './types.js';
export { StaleAccountError, isEmailIdentifier } from './controller.js';

export interface AppContextValue extends AppSnapshot {
  t: Translate;
  request<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  mutate<T>(path: string, body?: unknown, options?: RequestOptions): Promise<T>;
  refreshStatus(): Promise<void>; refreshDiagnostics(): Promise<void>; initialize(): Promise<void>;
  confirm(options: ConfirmOptions): Promise<boolean>; setDirty(key: string, dirty: boolean): void;
  beginLogin(): void; login(identifier: string, password: string): Promise<void>; logout(): Promise<void>; close(): Promise<void>;
  resolveAccountChange(): Promise<void>; notify(kind: 'success' | 'error' | 'warning' | 'info', message: string): void;
}
const ControllerContext = createContext<AppController | null>(null);
const AppContext = createContext<AppContextValue | null>(null);
interface PendingConfirmation { options: ConfirmOptions; resolve(value: boolean): void }

export function AppProvider({ children, host }: PropsWithChildren<{ host?: HomebridgeHost }>) {
  const [controller] = useState(() => new AppController(host ?? window.homebridge));
  const snapshot = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const confirmationRef = useRef<PendingConfirmation | null>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    controller.setConfirmHandler((options) => new Promise<boolean>((resolve) => {
      confirmationRef.current?.resolve(false);
      returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      const pending = { options, resolve };
      confirmationRef.current = pending;
      setConfirmation(pending);
    }));
    return () => {
      confirmationRef.current?.resolve(false); controller.setConfirmHandler(async () => false);
    };
  }, [controller]);
  const settle = (accepted: boolean) => {
    confirmationRef.current?.resolve(accepted);
    confirmationRef.current = null;
    setConfirmation(null);
  };
  useEffect(() => {
    let active = true;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let appearanceTimer: ReturnType<typeof setInterval> | undefined;
    let freshnessTimer: ReturnType<typeof setInterval> | undefined;
    let subscribed = false;
    const onStatus = () => {
      if (document.hidden) {
        return;
      }
      void controller.refreshDiagnostics();
    };
    const stop = () => {
      controller.setPaused(true);
      if (subscribed) {
        controller.host.removeEventListener?.('hejhome-status-changed', onStatus); subscribed = false;
      }
      clearInterval(pollTimer); clearInterval(appearanceTimer); clearInterval(freshnessTimer);
      pollTimer = undefined; appearanceTimer = undefined; freshnessTimer = undefined;
    };
    const start = () => {
      if (!active || document.hidden || subscribed) {
        return;
      }
      controller.setPaused(false);
      controller.host.addEventListener?.('hejhome-status-changed', onStatus);
      subscribed = true;
      pollTimer = setInterval(() => void controller.refreshDiagnostics(), 10000);
      appearanceTimer = setInterval(() => void controller.updateAppearance(), 3000);
      freshnessTimer = setInterval(controller.tick, 1000);
    };
    const resume = () => {
      start(); void controller.updateAppearance(); void controller.refreshDiagnostics();
    };
    const visibility = () => {
      if (document.hidden) {
        stop();
      } else {
        resume();
      }
    };
    start();
    void controller.initialize();
    document.addEventListener('visibilitychange', visibility);
    window.addEventListener('pagehide', stop); window.addEventListener('pageshow', resume);
    return () => {
      active = false; stop();
      document.removeEventListener('visibilitychange', visibility);
      window.removeEventListener('pagehide', stop); window.removeEventListener('pageshow', resume);
    };
  }, [controller]);
  useEffect(() => {
    document.documentElement.lang = snapshot.language;
    document.documentElement.dataset.hejTheme = snapshot.theme;
    controller.host.fixScrollHeight?.();
  }, [controller, snapshot.language, snapshot.theme, snapshot.phase, snapshot.accountChangePending]);
  useEffect(() => {
    if (snapshot.phase === 'settings' && !snapshot.accountChangePending) {
      void controller.refreshDiagnostics();
    }
  }, [controller, snapshot.phase, snapshot.accountEpoch, snapshot.accountChangePending]);
  useEffect(() => {
    if (typeof ResizeObserver === 'undefined') {
      return;
    }
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => controller.host.fixScrollHeight?.());
    });
    observer.observe(document.body);
    return () => {
      observer.disconnect(); cancelAnimationFrame(frame);
    };
  }, [controller]);
  const value = useMemo<AppContextValue>(() => ({ ...snapshot, t: controller.t, request: controller.request,
    mutate: controller.mutate, refreshStatus: controller.refreshStatus, refreshDiagnostics: controller.refreshDiagnostics,
    initialize: controller.initialize, confirm: controller.confirm, setDirty: controller.setDirty,
    beginLogin: controller.beginLogin, login: controller.login, logout: controller.logout, close: controller.close,
    resolveAccountChange: controller.resolveAccountChange, notify: controller.notify }), [controller, snapshot]);
  return <ControllerContext.Provider value={controller}><AppContext.Provider value={value}>
    <Theme appearance={snapshot.theme} accentColor="jade" grayColor="slate" radius="medium" panelBackground="solid">
      {children}
      <AlertDialog.Root open={Boolean(confirmation)} onOpenChange={(open) => {
        if (!open) {
          settle(false);
        }
      }}>
        <AlertDialog.Content maxWidth="440px" onCloseAutoFocus={(event) => {
          event.preventDefault();
          if (returnFocusRef.current?.isConnected) {
            returnFocusRef.current.focus();
          }
        }}>
          <AlertDialog.Title>{confirmation?.options.title}</AlertDialog.Title>
          <AlertDialog.Description>{confirmation?.options.description}</AlertDialog.Description>
          <Flex gap="3" justify="end" mt="5" wrap="wrap">
            <AlertDialog.Cancel><Button variant="soft" color="gray" onClick={() => settle(false)}>{controller.t('취소', 'Cancel')}</Button></AlertDialog.Cancel>
            <AlertDialog.Action><Button highContrast color={confirmation?.options.destructive ? 'red' : 'jade'} onClick={() => settle(true)}>
              {confirmation?.options.actionLabel ?? controller.t('변경사항 버리기', 'Discard changes')}
            </Button></AlertDialog.Action>
          </Flex>
        </AlertDialog.Content>
      </AlertDialog.Root>
    </Theme>
  </AppContext.Provider></ControllerContext.Provider>;
}
export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) {
    throw new Error('useApp must be used inside AppProvider');
  }
  return value;
}
export function useDraft<T>(key: string, baseline: T) {
  const controller = useContext(ControllerContext);
  if (!controller) {
    throw new Error('useDraft must be used inside AppProvider');
  }
  const { accountEpoch } = useApp();
  const draft = useMemo(() => controller.getDraft(key, baseline), [controller, key, accountEpoch]);
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot);
  useEffect(() => {
    draft.receive(baseline);
  }, [draft, baseline]);
  return { ...snapshot, setValue: draft.setValue, reset: draft.reset, resetTo: draft.resetTo, save: draft.save };
}
