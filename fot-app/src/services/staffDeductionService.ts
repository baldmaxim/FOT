import { apiClient } from '../api/client';
import type { ITableExportSnapshot } from '../utils/tableView';
import type { IDormitoryCandidate } from './dormitoryService';

/**
 * Удержание сотрудника (миграции 318, 321): вид, подвид (необязателен), месяц удержания, сумма. Те же записи ведут
 * кадры и «Зарплата» («Справочник» → «Удержания»). Отдел и должность — текущие.
 */
export interface IStaffDeduction {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  kind_id: number;
  kind_name: string;
  /** Без подвида — null. */
  subkind_id: number | null;
  subkind_name: string | null;
  /** YYYY-MM. */
  month: string;
  /** NUMERIC как строка: «5000.00». */
  amount: string;
}

export interface IStaffDeductionPayload {
  kind_id: number;
  /** null — без подвида. */
  subkind_id: number | null;
  /** YYYY-MM. */
  month: string;
  amount: number;
}

/**
 * Плановое удержание (миграция 357): вид, подвид, сумма ₽/мес на месяцы «с — по» (по — null, бессрочно); в каждом
 * месяце периода удерживается вся сумма, в последнем — last_month_amount, если задана (миграция 362). Те же записи
 * ведут кадры и «Зарплата».
 */
export interface IPlannedDeduction {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  kind_id: number;
  kind_name: string;
  subkind_id: number | null;
  subkind_name: string | null;
  /** ₽/мес, NUMERIC строкой. */
  amount: string;
  /** YYYY-MM. */
  month_from: string;
  /** YYYY-MM; null — бессрочно. */
  month_to: string | null;
  /** Сумма в месяце month_to вместо amount, NUMERIC строкой; null — как в остальных месяцах. */
  last_month_amount: string | null;
  /** Метка версии строки: правка и «Убрать» присылают её обратно (уже изменили — 409 PLANNED_DEDUCTION_STALE). */
  updated_at: string;
  /** Право правки строки (у кадров — всегда true, решает право вкладки). */
  can_edit: boolean;
}

/** Плановое удержание в одном месяце — строка «Удержаний за месяц» (та же развёртка, что в расчёте). */
export interface IPlannedDeductionMonth extends IPlannedDeduction {
  /** YYYY-MM. */
  month: string;
  /** Удержание в этом месяце (в последнем — last_month_amount, если задана); amount — сумма периода для ✎. */
  month_amount: string;
}

export interface IPlannedDeductionPayload {
  kind_id: number;
  subkind_id: number | null;
  amount: number;
  /** YYYY-MM. */
  month_from: string;
  /** YYYY-MM; null — бессрочно. */
  month_to: string | null;
  /** Сумма в последнем месяце; null — как в остальных. */
  last_month_amount: number | null;
}

/** Что сделал «Убрать»: закрыл период месяцем перед текущим или удалил строку. */
export type PlannedDeductionRemoval = 'closed' | 'removed';

/** Подвид вида удержания (миграция 321): «Спецодежда» → «Каска»; своя сумма по умолчанию. */
export interface IDeductionSubkind {
  id: number;
  kind_id: number;
  name: string;
  /** NUMERIC как строка; не задана — null (берётся сумма вида). */
  default_amount: string | null;
}

/** Вид удержания с подвидами — общий справочник кадров и «Зарплаты». */
export interface IStaffDeductionKind {
  id: number;
  name: string;
  /** NUMERIC как строка; не задана — null. */
  default_amount: string | null;
  /** В порядке добавления. */
  subkinds: IDeductionSubkind[];
}

/** Вид без подвидов — ответ на добавление и правку вида. */
export type StaffDeductionKindEntry = Omit<IStaffDeductionKind, 'subkinds'>;

/** Подвиды из окна справочника: кадры и «Зарплата» ходят каждый в свой API (свои права), справочник один. */
export interface IDeductionSubkindsApi {
  /** Такой у вида уже есть — ApiError 409. */
  add: (kindId: number, payload: IStaffDeductionKindPayload) => Promise<IDeductionSubkind>;
  update: (subkindId: number, payload: IStaffDeductionKindPayload) => Promise<IDeductionSubkind>;
  /** Подвид назначен сотрудникам — ApiError 409. */
  remove: (subkindId: number) => Promise<void>;
}

/** Название и сумма по умолчанию — вида или подвида. */
export interface IStaffDeductionKindPayload {
  name: string;
  default_amount: number | null;
}

interface IApiResponse<T> { success: boolean; data: T }

/** «Добавить сотрудника»: работающие и уволенные за месяцы выбора; уволенному — месяц не позже увольнения. */
export interface IStaffDeductionCandidate extends IDormitoryCandidate {
  /** YYYY-MM-DD; работающий — null (старый сервер поля не присылает). */
  dismissal_date?: string | null;
}

export const STAFF_DEDUCTIONS_KEY = ['staff-deductions'] as const;
export const STAFF_DEDUCTION_KINDS_KEY = ['staff-deduction-kinds'] as const;

/** ?months= списков: месяцы YYYY-MM через запятую (registryMonthsParam). */
const withMonths = (path: string, months: string): string => `${path}?months=${encodeURIComponent(months)}`;

/** Плановые удержания одного раздела: кадры и «Зарплата» ходят в свои пути (свои права), записи одни. */
export const plannedDeductionApi = (base: string) => ({
  /** Периоды, задевающие месяцы. */
  list: async (months: string, signal?: AbortSignal): Promise<IPlannedDeduction[]> =>
    (await apiClient.get<IApiResponse<IPlannedDeduction[]>>(withMonths(base, months), { signal })).data,

  /** По месяцам — строка на каждый месяц, где удержание идёт (как в расчёте). */
  listByMonth: async (months: string, signal?: AbortSignal): Promise<IPlannedDeductionMonth[]> =>
    (await apiClient.get<IApiResponse<IPlannedDeductionMonth[]>>(withMonths(`${base}/by-month`, months), { signal })).data,

  /** Пересечение того же вида и подвида — ApiError 409 PLANNED_DEDUCTION_EXISTS. */
  add: async (employeeId: number, payload: IPlannedDeductionPayload): Promise<void> => {
    await apiClient.post(base, { employee_id: employeeId, ...payload });
  },

  /** Строку уже изменили — ApiError 409 PLANNED_DEDUCTION_STALE. */
  update: async (row: Pick<IPlannedDeduction, 'id' | 'updated_at'>, payload: IPlannedDeductionPayload): Promise<void> => {
    await apiClient.patch(`${base}/${row.id}`, { ...payload, expected_updated_at: row.updated_at });
  },

  /** «Убрать»: идущее закрывается месяцем перед текущим, остальное удаляется; уже изменили — 409. */
  remove: async (row: Pick<IPlannedDeduction, 'id' | 'updated_at'>): Promise<PlannedDeductionRemoval> => {
    const res = await apiClient.delete<{ success: boolean; action: PlannedDeductionRemoval }>(`${base}/${row.id}`, {
      body: JSON.stringify({ expected_updated_at: row.updated_at }),
    });
    return res.action;
  },
});

export type IPlannedDeductionApi = ReturnType<typeof plannedDeductionApi>;

export const staffDeductionService = {
  list: async (signal?: AbortSignal): Promise<IStaffDeduction[]> => {
    const res = await apiClient.get<IApiResponse<IStaffDeduction[]>>('/staff-deductions', { signal });
    return res.data;
  },

  searchEmployees: async (search: string, signal?: AbortSignal): Promise<IStaffDeductionCandidate[]> => {
    const res = await apiClient.get<IApiResponse<IStaffDeductionCandidate[]>>(
      `/staff-deductions/employees/search?q=${encodeURIComponent(search)}`,
      { signal },
    );
    return res.data;
  },

  add: async (employeeId: number, payload: IStaffDeductionPayload): Promise<IStaffDeduction> => {
    const res = await apiClient.post<IApiResponse<IStaffDeduction>>('/staff-deductions', { employee_id: employeeId, ...payload });
    return res.data;
  },

  update: async (deductionId: number, payload: IStaffDeductionPayload): Promise<IStaffDeduction> => {
    const res = await apiClient.patch<IApiResponse<IStaffDeduction>>(`/staff-deductions/${deductionId}`, payload);
    return res.data;
  },

  remove: async (deductionId: number): Promise<void> => {
    await apiClient.delete<IApiResponse<IStaffDeduction>>(`/staff-deductions/${deductionId}`);
  },

  /** xlsx ровно той таблицы, что на экране: сортировка и фильтры уже применены. */
  exportTable: async (table: ITableExportSnapshot): Promise<{ blob: Blob; filename: string }> =>
    apiClient.download('/staff-deductions/export', table.file_name, {
      method: 'POST',
      body: JSON.stringify(table),
      timeoutMs: 120_000,
    }),

  /** Плановые удержания (миграция 357) — вкладка «Плановые удержания» кадров. */
  planned: plannedDeductionApi('/staff-deductions/planned'),

  /** xlsx вкладки «Плановые удержания» — лист «Плановые удержания». */
  exportPlannedTable: async (table: ITableExportSnapshot): Promise<{ blob: Blob; filename: string }> =>
    apiClient.download('/staff-deductions/planned/export', table.file_name, {
      method: 'POST',
      body: JSON.stringify(table),
      timeoutMs: 120_000,
    }),

  /** Виды с подвидами — то же дерево, что у «Зарплаты». */
  listKinds: async (signal?: AbortSignal): Promise<IStaffDeductionKind[]> => {
    const res = await apiClient.get<IApiResponse<IStaffDeductionKind[]>>('/staff-deductions/kinds', { signal });
    return res.data;
  },

  /** Такой вид уже есть — ApiError 409. Ответ — вид без подвидов. */
  addKind: async (payload: IStaffDeductionKindPayload): Promise<StaffDeductionKindEntry> => {
    const res = await apiClient.post<IApiResponse<StaffDeductionKindEntry>>('/staff-deductions/kinds', payload);
    return res.data;
  },

  updateKind: async (kindId: number, payload: IStaffDeductionKindPayload): Promise<StaffDeductionKindEntry> => {
    const res = await apiClient.patch<IApiResponse<StaffDeductionKindEntry>>(`/staff-deductions/kinds/${kindId}`, payload);
    return res.data;
  },

  /** Вид назначен сотрудникам — ApiError 409. */
  removeKind: async (kindId: number): Promise<void> => {
    await apiClient.delete<IApiResponse<IStaffDeductionKind>>(`/staff-deductions/kinds/${kindId}`);
  },

  subkinds: {
    add: async (kindId, payload) => {
      const res = await apiClient.post<IApiResponse<IDeductionSubkind>>(`/staff-deductions/kinds/${kindId}/subkinds`, payload);
      return res.data;
    },
    update: async (subkindId, payload) => {
      const res = await apiClient.patch<IApiResponse<IDeductionSubkind>>(`/staff-deductions/subkinds/${subkindId}`, payload);
      return res.data;
    },
    remove: async subkindId => {
      await apiClient.delete<IApiResponse<IDeductionSubkind>>(`/staff-deductions/subkinds/${subkindId}`);
    },
  } satisfies IDeductionSubkindsApi,
};
