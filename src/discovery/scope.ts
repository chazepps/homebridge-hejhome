import type { HejFamily, HejhomePlatformConfig } from '../types.js';

export interface ResolvedDiscoveryScope {
  familyId: number;
  roomIds?: number[];
}

export function resolveDiscoveryScope(
  config: Pick<HejhomePlatformConfig, 'scope'>,
  families: HejFamily[],
): ResolvedDiscoveryScope[] {
  if (families.length === 0) {
    return [];
  }

  const mode = config.scope?.mode ?? 'first-family';
  if (mode === 'all') {
    return families.map((family) => ({ familyId: family.familyId }));
  }

  if (mode === 'custom') {
    const allowedFamilies = new Set(config.scope?.includedFamilyIds ?? []);
    const roomsByFamily = config.scope?.includedRoomsByFamilyId ?? {};
    const selected = families
      .filter((family) => allowedFamilies.has(family.familyId))
      .map((family) => {
        const roomKey = String(family.familyId);
        const hasExplicitRoomScope = Object.hasOwn(roomsByFamily, roomKey);
        const roomIds = roomsByFamily[roomKey]?.filter((roomId) => Number.isFinite(roomId));
        const scope: ResolvedDiscoveryScope = { familyId: family.familyId };
        if (hasExplicitRoomScope) {
          scope.roomIds = roomIds ?? [];
        }
        return scope;
      });
    if (selected.length > 0) {
      return selected;
    }
  }

  const firstFamily = families[0];
  if (!firstFamily) {
    return [];
  }
  return [{ familyId: firstFamily.familyId }];
}
