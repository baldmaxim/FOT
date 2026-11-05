import { apiClient } from '../api/client';
import type { ITableExportSnapshot } from '../utils/tableView';

/**
 * Строка вкладки «Выходные» (миграция 346): сотрудник ЛИНИЯ или ЛИНИЯ-Общестрой и его выходные со СКУД без
 * корректировки за выбранные месяцы.
 */
export interface IStaffWeekendRow {
  employee_id: number;
  full_name: string;
  /** Отдел на последний показанный день, а не текущий. */
  department: string | null;
  /** Текущая должность. */
  position: string | null;
  /** Дни YYYY-MM-DD по возрастанию. */
  days: string[];
  /** Минуты СКУД за эти дни. */
  total_minutes: number;
}

interface IApiResponse<T> { success: boolean; data: T }

export const STAFF_WEEKENDS_KEY = ['staff-weekends'] as const;

export const staffWeekendService = {
  /** months — значение ?months= (registryMonthsParam). Двенадцать месяцев считаются заметно дольше одного. */
  list: async (months: string, signal?: AbortSignal): Promise<IStaffWeekendRow[]> => {
    const res = await apiClient.get<IApiResponse<IStaffWeekendRow[]>>(
      `/staff-weekends?months=${encodeURIComponent(months)}`,
      { signal, timeoutMs: 120_000 },
    );
    return res.data;
  },

  exportTable: async (table: ITableExportSnapshot): Promise<{ blob: Blob; filename: string }> =>
    apiClient.download('/staff-weekends/export', table.file_name, {
      method: 'POST',
      body: JSON.stringify(table),
      timeoutMs: 120_000,
    }),
};
