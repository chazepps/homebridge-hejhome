import { HejhomePlatform } from '../platform.js';
import { hejRequest } from './request.js';

export const getUser = async (platform: HejhomePlatform) =>
  hejRequest<null, MemberList>(platform, 'GET', 'dashboard/config/user');

interface Member {
  homeName: string;
  admin: boolean;
  name: string;
  uid: string;
  homeId: string | null;
  memberAccount: string;
}

interface MemberList {
  member: Member[];
}
