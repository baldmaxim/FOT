import { apiClient } from '../api/client';

export interface IPortalOnlineSnapshot {
  userIds: string[];
  employeeIds: number[];
}

export const presenceService = {
  // Кто сейчас онлайн на портале (держит Socket.IO-коннект).
  getOnlinePortal(): Promise<IPortalOnlineSnapshot> {
    return apiClient.get<IPortalOnlineSnapshot>('/presence/online');
  },
};
