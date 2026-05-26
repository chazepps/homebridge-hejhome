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
      '## Unsupported Hejhome product',
      products,
      '',
      '## Expected HomeKit behavior',
      '- Service type:',
      '- Required characteristics:',
      '',
      '## Snapshot context',
      `- Registered devices: ${summary.registeredCount}`,
      `- Snapshot generated at: ${summary.generatedAt ?? 'not available'}`,
      '',
      'Do not include access tokens, cookies, passwords, email addresses, or device serial numbers.',
    ].join('\n'),
  };
}

function isSupportedDevice(device: HejDevice): boolean {
  return SUPPORTED_DEVICE_TYPES.has(device.deviceType);
}
