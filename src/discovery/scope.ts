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
        const roomIds = roomsByFamily[String(family.familyId)]?.filter((roomId) => Number.isFinite(roomId));
        const scope: ResolvedDiscoveryScope = { familyId: family.familyId };
        if (roomIds && roomIds.length > 0) {
          scope.roomIds = roomIds;
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
