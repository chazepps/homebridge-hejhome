import type { HejDeviceState } from '../types.js';

export const COVERING_FIELDS = ['percentState', 'percentControl', 'workState'] as const;

export function coveringPercent(value: unknown): number | undefined {
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value.trim()))) {
    return undefined;
  }
  const percent = Number(value);
  return Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : undefined;
}

export function coveringWorkState(value: unknown): 'open' | 'close' | 'stop' | undefined {
  switch (typeof value === 'string' ? value.trim().toLowerCase() : undefined) {
    case 'open':
    case 'opening':
      return 'open';
    case 'close':
    case 'closing':
      return 'close';
    case 'stop':
    case 'stopped':
      return 'stop';
    default:
      return undefined;
  }
}

export function readCoveringState(state: HejDeviceState | null | undefined) {
  return {
    percentState: coveringPercent(state?.percentState),
    percentControl: coveringPercent(state?.percentControl),
    workState: coveringWorkState(state?.workState) ?? coveringWorkState(state?.work_state),
  };
}
