/** Encodings observed in the vendor web app's panel/aircondition.jsx.
 * These are commands and target settings; they are not measured room temperature or operating feedback.
 */
export type HvacMode = 'cool' | 'heat' | 'auto' | 'fan' | 'dry';
export type HvacFanSpeed = 'auto' | 'low' | 'medium' | 'high';
export type HvacCommand = { power: boolean } | { temperature: number } | { mode: HvacMode } | { fanSpeed: HvacFanSpeed };

const MODES: Record<HvacMode, string> = { cool: '0', heat: '1', auto: '2', fan: '3', dry: '4' };
const FAN_SPEEDS: Record<HvacFanSpeed, string> = { auto: '0', low: '1', medium: '2', high: '3' };

export function encodeHvacControl(command: HvacCommand): Record<string, string | number | boolean> {
  if (!command || typeof command !== 'object' || Object.keys(command).length !== 1) {
    throw new Error('에어컨 설정은 한 번에 하나씩 변경해 주세요.');
  }
  if ('power' in command && typeof command.power === 'boolean') {
    return { power: command.power };
  }
  if ('temperature' in command && Number.isInteger(command.temperature) && command.temperature >= 16 && command.temperature <= 30) {
    return { temperature: command.temperature };
  }
  if ('mode' in command && Object.hasOwn(MODES, command.mode)) {
    return { mode: MODES[command.mode] };
  }
  if ('fanSpeed' in command && Object.hasOwn(FAN_SPEEDS, command.fanSpeed)) {
    return { fanSpeed: FAN_SPEEDS[command.fanSpeed] };
  }
  throw new Error('지원하지 않는 에어컨 설정입니다. 온도는 16~30°C의 정수로 설정해 주세요.');
}
