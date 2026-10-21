import { apiClient } from '../api/client';
import type { ITableExportSnapshot } from '../utils/tableView';

/** Общежитие компании или квартира — «Доплата за проживание» «Зарплаты» (миграция 320). */
export type DormitoryStayKind = 'dormitory' | 'apartment';

/** Проживание сотрудника (миграции 314, 320). Отдел и должность — текущие. */
export interface IDormitoryStay {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  kind: DormitoryStayKind;
  /** YYYY-MM-DD. */
  check_in: string;
  /** YYYY-MM-DD; живёт — null. */
  check_out: string | null;
  /** У общежития — всегда; у квартиры — если указали. */
  address: string | null;
  /** Только у квартиры: ₽/мес, numeric строкой. */
  amount: string | null;
}

/** Работающий сотрудник для «Добавить сотрудника». */
export interface IDormitoryCandidate {
  id: number;
  full_name: string;
  department: string | null;
  position: string | null;
}

export interface IDormitoryStayPayload {
  check_in: string;
  check_out: string | null;
  address: string | null;
  /** Только у квартиры. */
  amount: number | null;
}

interface IApiResponse<T> { success: boolean; data: T }

/** Общий префикс: правка во вкладке кадров перечитывает и таблицу «Справочника». */
export const DORMITORY_STAYS_KEY = ['dormitory-stays'] as const;
export const PAYROLL_DORMITORY_STAYS_KEY = [...DORMITORY_STAYS_KEY, 'payroll'] as const;
/** Под тем же префиксом: сохранение проживания перечитывает и подсказки адресов. */
export const DORMITORY_ADDRESSES_KEY = [...DORMITORY_STAYS_KEY, 'addresses'] as const;

export const dormitoryService = {
  /** «Управление кадрами» → «Проживание»: общежития и квартиры, охват списка кадров. */
  list: async (signal?: AbortSignal): Promise<IDormitoryStay[]> => {
    const res = await apiClient.get<IApiResponse<IDormitoryStay[]>>('/dormitory/stays', { signal });
    return res.data;
  },

  /** «Зарплата» → «Справочник» → «Общежитие» (кнопка в шапке): только общежития, охват условий оплаты. */
  listForPayroll: async (signal?: AbortSignal): Promise<IDormitoryStay[]> => {
    const res = await apiClient.get<IApiResponse<IDormitoryStay[]>>('/payroll/dormitory-stays', { signal });
    return res.data;
  },

  searchEmployees: async (search: string, signal?: AbortSignal): Promise<IDormitoryCandidate[]> => {
    const res = await apiClient.get<IApiResponse<IDormitoryCandidate[]>>(
      `/dormitory/employees/search?q=${encodeURIComponent(search)}`,
      { signal },
    );
    return res.data;
  },

  /** Сохранённые адреса (миграция 319) — подсказки «Адрес / номер»; не пропадают вместе с проживаниями. */
  listAddresses: async (signal?: AbortSignal): Promise<string[]> => {
    const res = await apiClient.get<IApiResponse<string[]>>('/dormitory/addresses', { signal });
    return res.data;
  },

  /**
   * Пересечение с другим проживанием сотрудника — ApiError 409; квартира в днях «Доплаты за общежитие» или без
   * ставки «Доплата за проживание» (сумму квартиры сервер берёт из неё) — тоже 409.
   */
  add: async (employeeId: number, kind: DormitoryStayKind, payload: IDormitoryStayPayload): Promise<IDormitoryStay> => {
    const res = await apiClient.post<IApiResponse<IDormitoryStay>>(
      '/dormitory/stays',
      { employee_id: employeeId, kind, ...payload },
    );
    return res.data;
  },

  update: async (stayId: number, payload: IDormitoryStayPayload): Promise<IDormitoryStay> => {
    const res = await apiClient.patch<IApiResponse<IDormitoryStay>>(`/dormitory/stays/${stayId}`, payload);
    return res.data;
  },

  remove: async (stayId: number): Promise<void> => {
    await apiClient.delete<IApiResponse<IDormitoryStay>>(`/dormitory/stays/${stayId}`);
  },

  /** xlsx ровно той таблицы, что на экране: сортировка и фильтры уже применены. */
  exportTable: async (table: ITableExportSnapshot): Promise<{ blob: Blob; filename: string }> =>
    apiClient.download('/dormitory/stays/export', table.file_name, {
      method: 'POST',
      body: JSON.stringify(table),
      timeoutMs: 120_000,
    }),
};
