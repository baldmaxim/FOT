import { apiClient } from '../api/client';

export interface IR2Status {
  enabled: boolean;
  bucket_name: string;
  has_account_id: boolean;
  has_access_key: boolean;
  has_secret_key: boolean;
}

export interface IR2TestResult {
  connected: boolean;
  error?: string;
}

export interface ISigurMonitorSettings {
  enabled: boolean;
  failureThreshold: number;
  recoveryThreshold: number;
  silenceWindowMinutes: number;
  baselineLookbackDays: number;
  baselineMinEvents: number;
  alertCooldownMinutes: number;
  timezone: string;
}

export interface ITimesheetReminderSettings {
  enabled: boolean;
  timezone: string;
  openingReminderHour: number;
  deadlineMorningHour: number;
  deadlineAfternoonHour: number;
  escalationHour: number;
  overdueHour: number;
}

interface ApiResponse<T> {
  data: T;
}

export const settingsService = {
  getR2Status: async (): Promise<IR2Status> => {
    const res = await apiClient.get<ApiResponse<IR2Status>>('/settings/r2/status');
    return res.data;
  },

  saveR2: async (data: {
    account_id?: string;
    access_key_id?: string;
    secret_access_key?: string;
    bucket_name?: string;
  }): Promise<{ enabled: boolean; bucket_name: string }> => {
    const res = await apiClient.put<ApiResponse<{ enabled: boolean; bucket_name: string }>>('/settings/r2', data);
    return res.data;
  },

  testR2: async (): Promise<IR2TestResult> => {
    const res = await apiClient.post<ApiResponse<IR2TestResult>>('/settings/r2/test', {});
    return res.data;
  },

  getSigurMonitorSettings: async (): Promise<ISigurMonitorSettings> => {
    const res = await apiClient.get<ApiResponse<ISigurMonitorSettings>>('/settings/sigur-monitor');
    return res.data;
  },

  saveSigurMonitorSettings: async (data: ISigurMonitorSettings): Promise<ISigurMonitorSettings> => {
    const res = await apiClient.put<ApiResponse<ISigurMonitorSettings>>('/settings/sigur-monitor', data);
    return res.data;
  },

  getTimesheetReminderSettings: async (): Promise<ITimesheetReminderSettings> => {
    const res = await apiClient.get<ApiResponse<ITimesheetReminderSettings>>('/settings/timesheet-reminders');
    return res.data;
  },

  saveTimesheetReminderSettings: async (data: ITimesheetReminderSettings): Promise<ITimesheetReminderSettings> => {
    const res = await apiClient.put<ApiResponse<ITimesheetReminderSettings>>('/settings/timesheet-reminders', data);
    return res.data;
  },
};
