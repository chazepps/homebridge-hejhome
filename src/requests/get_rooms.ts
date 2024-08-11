import { HejhomePlatform } from '../platform.js';
import { hejRequest } from './request.js';

export const getRooms = async (platform: HejhomePlatform, familyId: number) => {
  if (!platform.token) {
    throw new Error('Failed to retrieve token');
  }

  const { result } = await hejRequest<null, FamilyDataResult>(
    platform,
    'GET',
    `dashboard/rooms/${familyId}`,
  );

  return result;
};

interface Room {
  name: string;
  room_id: number;
}

interface FamilyData {
  name: string;
  rooms: Room[];
  familyId: number;
}

interface FamilyDataResult {
  result: FamilyData;
}
