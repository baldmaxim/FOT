import { apiClient } from '../api/client';
import type { ITableExportSnapshot } from '../utils/tableView';

/**
 * Сетка вкладки «Выходные» (миграция 346): сотрудник отдела и его выходные со СКУД без корректировки за месяц.
 * Часов здесь нет: их показывает табель, в сводке СКУД обед не вычтен.
 */
export interface IStaffWeekendRow {
  employee_id: number;
  full_name: string;
  /** Текущая должность. */
  position: string | null;
  /** Дни этого отдела, YYYY-MM-DD по возрастанию. */
  days: string[];
}

export type WeekendHalf = 1 | 2;

/** Половина месяца у отдела: что можно сделать кнопками. */
export interface IStaffWeekendPeriod {
  half: WeekendHalf;
  start_date: string;
  end_date: string;
  can_open: boolean;
  can_close: boolean;
}

export interface IStaffWeekendBranch {
  id: string;
  name: string;
  rows: IStaffWeekendRow[];
  periods: IStaffWeekendPeriod[];
}

export interface IStaffWeekendGrid {
  branches: IStaffWeekendBranch[];
  can_manage_periods: boolean;
}

/** Что откроется и кого это затронет. Подача открывается вся, поэтому в окне видны и люди других отделов. */
export interface IStaffWeekendPeriodPreview {
  half: WeekendHalf;
  start_date: string;
  end_date: string;
  expected_approval_ids: number[];
  approvals: Array<{ id: number; label: string; status: string; start_date: string; end_date: string; people_count: number }>;
  others: Array<{ department: string; count: number; names: string[] }>;
}

export interface IStaffWeekendPeriodRef {
  month: string;
  half: WeekendHalf;
  branch_id: string;
}

export interface IStaffWeekendCloseResult {
  closed: number[];
  failed: Array<{ id: number; label: string; error: string; code?: string }>;
}

interface IApiResponse<T> { success: boolean; data: T }

export const STAFF_WEEKENDS_KEY = ['staff-weekends'] as const;

export const staffWeekendService = {
  grid: async (month: string, signal?: AbortSignal): Promise<IStaffWeekendGrid> => {
    const res = await apiClient.get<IApiResponse<IStaffWeekendGrid>>(
      `/staff-weekends/grid?month=${encodeURIComponent(month)}`,
      { signal, timeoutMs: 120_000 },
    );
    return res.data;
  },

  previewPeriod: async ({ month, half, branch_id: branchId }: IStaffWeekendPeriodRef, signal?: AbortSignal): Promise<IStaffWeekendPeriodPreview> => {
    const res = await apiClient.get<IApiResponse<IStaffWeekendPeriodPreview>>(
      `/staff-weekends/periods/preview?month=${encodeURIComponent(month)}&half=${half}&branch_id=${encodeURIComponent(branchId)}`,
      { signal, timeoutMs: 120_000 },
    );
    return res.data;
  },

  /** operation_id — на окно подтверждения: повтор с ним ничего не задвоит. */
  openPeriod: async (body: IStaffWeekendPeriodRef & {
    operation_id: string;
    expected_approval_ids: number[];
    reason: string | null;
  }): Promise<void> => {
    await apiClient.post('/staff-weekends/periods/open', body, { timeoutMs: 120_000 });
  },

  closePeriod: async (body: IStaffWeekendPeriodRef): Promise<IStaffWeekendCloseResult> => {
    const res = await apiClient.post<IApiResponse<IStaffWeekendCloseResult>>('/staff-weekends/periods/close', body, { timeoutMs: 300_000 });
    return res.data;
  },

  exportTable: async (table: ITableExportSnapshot): Promise<{ blob: Blob; filename: string }> =>
    apiClient.download('/staff-weekends/export', table.file_name, {
      method: 'POST',
      body: JSON.stringify(table),
      timeoutMs: 120_000,
    }),
};
