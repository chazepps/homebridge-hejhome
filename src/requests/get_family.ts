import { HejhomePlatform } from '../platform.js';
import { hejRequest } from './request.js';

export const getFamilies = async (platform: HejhomePlatform) => {
  if (!platform.token) {
    throw new Error('Failed to retrieve token');
  }

  const { result } = await hejRequest<null, FamilyList>(platform, 'GET', 'dashboard/family');

  return result;
};

interface Family {
  name: string;
  familyId: number;
}

interface FamilyList {
  result: Family[];
}
