import { apiClient } from '../api/client';
import type { ITableExportSnapshot } from '../utils/tableView';
import type { IBranchPathNode } from './staffWeekendService';

/**
 * «Управление кадрами» → «Корректировки» (миграция 365): правки часов руководителей за месяц — кадрам проверить.
 * Журнал лёгкий (все видимые отделы сразу: поиск по ФИО идёт по всем); часы «по СКУД» — отдельно, по отделу.
 */

export type StaffCorrectionSource = 'table' | 'request';
export type StaffCorrectionWindow = 'day' | 'object';

export interface IStaffCorrectionRow {
  id: number;
  branch_id: string;
  employee_id: number;
  full_name: string;
  /** YYYY-MM-DD */
  work_date: string;
  /** Тип правки (work, manual, remote…). */
  status: string;
  hours: number | null;
  source: StaffCorrectionSource;
  window: StaffCorrectionWindow;
  object_id: string | null;
  object_name: string | null;
  /** «Табель» — кто поставил; «Заявление» — кто согласовал. */
  author_name: string | null;
  /** «Заявление» — кто подал. */
  applicant_name: string | null;
  changed_at: string;
  reason: string | null;
  attachments_count: number;
}

export interface IStaffCorrectionsList {
  /** Отделы с правками; path — предки от корня до родителя (нет у прежнего сервера). */
  branches: Array<{ id: string; name: string; path?: IBranchPathNode[] }>;
  rows: IStaffCorrectionRow[];
}

export interface IStaffCorrectionSkud {
  norm_hours: number | null;
  skud_hours: number;
  first_entry: string | null;
  last_exit: string | null;
}

interface IApiResponse<T> { success: boolean; data: T }

export const STAFF_CORRECTIONS_KEY = ['staff-corrections'] as const;

export const staffCorrectionsService = {
  list: async (month: string, signal?: AbortSignal): Promise<IStaffCorrectionsList> => {
    const res = await apiClient.get<IApiResponse<IStaffCorrectionsList>>(
      `/staff-corrections?month=${encodeURIComponent(month)}`,
      { signal, timeoutMs: 120_000 },
    );
    return res.data;
  },

  skud: async (month: string, branchId: string, signal?: AbortSignal): Promise<Record<number, IStaffCorrectionSkud>> => {
    const res = await apiClient.get<IApiResponse<Record<number, IStaffCorrectionSkud>>>(
      `/staff-corrections/skud?month=${encodeURIComponent(month)}&branch_id=${encodeURIComponent(branchId)}`,
      { signal, timeoutMs: 120_000 },
    );
    return res.data;
  },

  exportTable: async (table: ITableExportSnapshot): Promise<{ blob: Blob; filename: string }> =>
    apiClient.download('/staff-corrections/export', table.file_name, {
      method: 'POST',
      body: JSON.stringify(table),
      timeoutMs: 120_000,
    }),
};
