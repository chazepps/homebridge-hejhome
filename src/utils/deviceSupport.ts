import type { HejDeviceSnapshot } from '../storage/deviceSnapshotStore.js';
import type { HejDevice } from '../types.js';

export interface SupportedDeviceModel {
  deviceType: string;
  label: string;
  homeKitService: string;
}

export interface UnsupportedProductSummary {
  deviceType: string;
  modelName: string | null;
  count: number;
}

export interface DeviceSupportSummary {
  generatedAt: string | null;
  registeredCount: number;
  supportedCount: number;
  unsupportedCount: number;
  unsupportedProducts: UnsupportedProductSummary[];
}

export interface UnsupportedDeviceIssueTemplate {
  title: string;
  body: string;
}

export const SUPPORTED_DEVICE_MODELS: SupportedDeviceModel[] = [
  { deviceType: 'LightRgbw5', label: 'RGBW 조명', homeKitService: 'Lightbulb' },
  { deviceType: 'LedStripRgbw2', label: 'LED 스트립', homeKitService: 'Lightbulb' },
  { deviceType: 'ZigbeeSwitch1', label: '1구 스위치', homeKitService: 'Switch' },
  { deviceType: 'ZigbeeSwitch2', label: '2구 스위치', homeKitService: 'Switch' },
  { deviceType: 'RelayController', label: '릴레이 컨트롤러', homeKitService: 'Switch' },
];

const SUPPORTED_DEVICE_TYPES = new Set(SUPPORTED_DEVICE_MODELS.map((model) => model.deviceType));

export function createDeviceSupportSummary(snapshot: HejDeviceSnapshot | null | undefined): DeviceSupportSummary {
  if (!snapshot) {
    return {
      generatedAt: null,
      registeredCount: 0,
      supportedCount: 0,
      unsupportedCount: 0,
      unsupportedProducts: [],
    };
  }

  const unsupported = new Map<string, UnsupportedProductSummary>();
  const devices = snapshot.families.flatMap((entry) => entry.devices);
  let supportedCount = 0;

  for (const device of devices) {
    if (isSupportedDevice(device)) {
      supportedCount += 1;
      continue;
    }

    const modelName = device.modelName ?? null;
    const key = `${device.deviceType}:${modelName ?? ''}`;
    const current = unsupported.get(key);
    if (current) {
      current.count += 1;
    } else {
      unsupported.set(key, {
        deviceType: device.deviceType,
        modelName,
        count: 1,
      });
    }
  }

  return {
    generatedAt: snapshot.generatedAt,
    registeredCount: devices.length,
    supportedCount,
    unsupportedCount: devices.length - supportedCount,
    unsupportedProducts: [...unsupported.values()].sort((a, b) => {
      const typeOrder = a.deviceType.localeCompare(b.deviceType);
      if (typeOrder !== 0) {
        return typeOrder;
      }
      return (a.modelName ?? '').localeCompare(b.modelName ?? '');
    }),
  };
}

export function createUnsupportedDeviceIssueTemplate(summary: DeviceSupportSummary): UnsupportedDeviceIssueTemplate {
  const firstUnsupported = summary.unsupportedProducts[0];
  const title = firstUnsupported
    ? `[Unsupported Device] ${firstUnsupported.deviceType}${firstUnsupported.modelName ? ` / ${firstUnsupported.modelName}` : ''}`
    : '[Unsupported Device] Hejhome model request';

  const products = summary.unsupportedProducts.length > 0
    ? summary.unsupportedProducts
      .map((product) => `- ${product.deviceType}${product.modelName ? ` / ${product.modelName}` : ''} (${product.count})`)
      .join('\n')
    : '- Device type: \n- Model name: ';

  return {
    title,
    body: [
      '## 아직 지원하지 않는 Hejhome 제품',
      products,
      '',
      '## Home 앱에서 기대하는 동작',
      '- 어떤 장비로 보이면 좋은지:',
      '- 필요한 기능:',
      '',
      '## 장비 목록 정보',
      `- 등록된 장비 수: ${summary.registeredCount}`,
      `- 장비 목록 생성 시각: ${formatKstDateTime(summary.generatedAt)}`,
      '',
      '개인 정보, 로그인 정보, 비밀번호, 이메일 주소, 장비 시리얼 번호는 넣지 마세요.',
    ].join('\n'),
  };
}

function isSupportedDevice(device: HejDevice): boolean {
  return SUPPORTED_DEVICE_TYPES.has(device.deviceType);
}

function formatKstDateTime(value: string | null): string {
  if (!value) {
    return '확인 불가';
  }
  const timeMs = Date.parse(value);
  if (Number.isNaN(timeMs)) {
    return '확인 불가';
  }
  const kst = new Date(timeMs + (9 * 60 * 60 * 1000));
  const year = String(kst.getUTCFullYear()).padStart(4, '0');
  const month = String(kst.getUTCMonth() + 1).padStart(2, '0');
  const day = String(kst.getUTCDate()).padStart(2, '0');
  const hours = String(kst.getUTCHours()).padStart(2, '0');
  const minutes = String(kst.getUTCMinutes()).padStart(2, '0');
  const seconds = String(kst.getUTCSeconds()).padStart(2, '0');
  return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} (KST)`;
}
