import { apiClient } from '../api/client';
import type { ITableExportSnapshot } from '../utils/tableView';
import { payrollService } from './payrollService';

/**
 * Таблицы окна «Справочник» на «Расчётах» (миграция 315): «Доплата за проживание», «Доплата»,
 * «Без проезда», «Удержания». Строки — «штат зарплаты» (как список условий оплаты), can_edit — охват
 * правки этого сотрудника (сервер проверит то же при записи).
 */

/** Доплата за проживание — housing_compensation условий оплаты на сегодня (то же, что в окне сотрудника). */
export interface IHousingAllowanceRow {
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  /** ₽/мес, numeric строкой. */
  amount: string;
  /** YYYY-MM-DD: с какой даты действует эта сумма. */
  effective_from: string;
  can_edit: boolean;
}

export type PayrollSupplementKind = 'planned' | 'one_time';

/** Плановая (одна на сотрудника, та же, что в окне сотрудника) или разовая доплата. */
export interface IPayrollSupplementRow {
  kind: PayrollSupplementKind;
  /** id разовой; у плановой — null. */
  id: number | null;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  /** Плановая — ₽/мес, разовая — ₽; numeric строкой. */
  amount: string;
  /** Плановая: YYYY-MM-DD. */
  date_from: string | null;
  date_to: string | null;
  /** Разовая: YYYY-MM. */
  month: string | null;
  reason: string | null;
  can_edit: boolean;
}

/** «Без проезда» — кому не выплачивать проезд: период «с — по» (по включительно, null — бессрочно). */
export interface ICompensationStop {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  date_from: string;
  date_to: string | null;
  can_edit: boolean;
}

/** Удержания сотрудника: виды (текущий набор, датой не хранятся) и «Сумма, ₽/мес» из условий периода. */
export interface IDeductionRegistryRow {
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  kinds: string[];
  /** id тех же видов — для правки строки. */
  kind_ids: number[];
  amount: string | null;
  can_edit: boolean;
}

/** Удержание из таблицы: виды целиком (пусто — снять все), сумма ₽/мес с даты (null — снять). */
export interface IDeductionRegistryPayload {
  kind_ids: number[];
  amount: number | null;
  effective_from: string;
}

/** Кандидат в «Добавить сотрудника» — строка списка условий оплаты («штат зарплаты»). */
export interface IPayrollRegistryCandidate {
  id: number;
  full_name: string | null;
  department: string | null;
  position: string | null;
  /** Условий (оклада) на сегодня нет — доплату за проживание не добавить. */
  has_terms: boolean;
  /** Есть действующая плановая доплата — добавлять нечего, только ✎ в таблице. */
  has_planned_supplement: boolean;
  can_edit: boolean;
}

export interface IHousingAllowancePayload {
  /** null — снять с даты. */
  amount: number | null;
  effective_from: string;
}

export interface IPlannedSupplementFields {
  amount: number;
  date_from: string;
  date_to: string;
}

export interface IOneTimeSupplementFields {
  /** YYYY-MM. */
  month: string;
  amount: number;
  reason: string;
}

export interface ICompensationStopFields {
  date_from: string;
  date_to: string | null;
}

export type PayrollRegistryTable = 'housing' | 'supplements' | 'compensation-stops' | 'deductions' | 'summary';

interface IApiResponse<T> { success: boolean; data: T }

/**
 * Ключи под префиксом 'payroll-terms': сохранение окна сотрудника (invalidate ['payroll-terms']) перечитывает
 * и эти таблицы, а запись в таблице сбрасывает тот же префикс — список и окно сотрудника видят новое.
 */
export const PAYROLL_REGISTRY_KEYS = {
  housing: ['payroll-terms', 'registry', 'housing'],
  supplements: ['payroll-terms', 'registry', 'supplements'],
  stops: ['payroll-terms', 'registry', 'compensation-stops'],
  deductions: ['payroll-terms', 'registry', 'deductions'],
} as const;
export const PAYROLL_TERMS_PREFIX = ['payroll-terms'] as const;

const SEARCH_LIMIT = 20;

const list = async <T,>(path: string, signal?: AbortSignal): Promise<T[]> =>
  (await apiClient.get<IApiResponse<T[]>>(path, { signal })).data;

/** ?months= таблиц с суммами из условий: 'all' — весь период, иначе YYYY-MM через запятую. */
const withMonths = (path: string, months: string): string => `${path}?months=${encodeURIComponent(months)}`;

export const payrollRegistryService = {
  /** months — registryMonthsParam выбора. */
  listHousing: (months: string, signal?: AbortSignal) =>
    list<IHousingAllowanceRow>(withMonths('/payroll/housing-allowances', months), signal),

  /** Без условий на дату — ApiError 409 NO_TERMS. */
  setHousing: async (employeeId: number, payload: IHousingAllowancePayload): Promise<void> => {
    await apiClient.put(`/payroll/housing-allowances/employee/${employeeId}`, payload);
  },

  listSupplements: (signal?: AbortSignal) => list<IPayrollSupplementRow>('/payroll/supplements', signal),

  /** Уже есть плановая — ApiError 409 SUPPLEMENT_EXISTS. */
  addPlanned: async (employeeId: number, fields: IPlannedSupplementFields): Promise<void> => {
    await apiClient.post('/payroll/supplements/planned', { employee_id: employeeId, ...fields });
  },

  setPlanned: async (employeeId: number, fields: IPlannedSupplementFields): Promise<void> => {
    await apiClient.put(`/payroll/supplements/planned/employee/${employeeId}`, fields);
  },

  removePlanned: async (employeeId: number): Promise<void> => {
    await apiClient.delete(`/payroll/supplements/planned/employee/${employeeId}`);
  },

  addOneTime: async (employeeId: number, fields: IOneTimeSupplementFields): Promise<void> => {
    await apiClient.post('/payroll/supplements/one-time', { employee_id: employeeId, ...fields });
  },

  updateOneTime: async (id: number, fields: IOneTimeSupplementFields): Promise<void> => {
    await apiClient.patch(`/payroll/supplements/one-time/${id}`, fields);
  },

  removeOneTime: async (id: number): Promise<void> => {
    await apiClient.delete(`/payroll/supplements/one-time/${id}`);
  },

  listStops: (signal?: AbortSignal) => list<ICompensationStop>('/payroll/compensation-stops', signal),

  /** Пересечение с другим периодом сотрудника — ApiError 409 STOP_OVERLAP. */
  addStop: async (employeeId: number, fields: ICompensationStopFields): Promise<void> => {
    await apiClient.post('/payroll/compensation-stops', { employee_id: employeeId, ...fields });
  },

  updateStop: async (id: number, fields: ICompensationStopFields): Promise<void> => {
    await apiClient.patch(`/payroll/compensation-stops/${id}`, fields);
  },

  removeStop: async (id: number): Promise<void> => {
    await apiClient.delete(`/payroll/compensation-stops/${id}`);
  },

  /** months — registryMonthsParam выбора. */
  listDeductions: (months: string, signal?: AbortSignal) =>
    list<IDeductionRegistryRow>(withMonths('/payroll/deduction-registry', months), signal),

  /** Сумма без условий на дату — ApiError 409 NO_TERMS (виды тогда тоже не сохраняются). */
  saveDeduction: async (employeeId: number, payload: IDeductionRegistryPayload): Promise<void> => {
    await apiClient.put(`/payroll/deduction-registry/employee/${employeeId}`, payload);
  },

  /** xlsx ровно той таблицы, что на экране: сортировка и фильтры уже применены. */
  exportTable: (table: PayrollRegistryTable) => (snapshot: ITableExportSnapshot): Promise<{ blob: Blob; filename: string }> =>
    apiClient.download(`/payroll/registry/${table}/export`, snapshot.file_name, {
      method: 'POST',
      body: JSON.stringify(snapshot),
      timeoutMs: 120_000,
    }),

  /** «Добавить сотрудника»: «штат зарплаты» по ФИО — тот же поиск, что у списка условий оплаты. */
  searchEmployees: async (term: string, signal: AbortSignal): Promise<IPayrollRegistryCandidate[]> => {
    const { rows } = await payrollService.listTerms({ q: term, sort: 'name', dir: 'asc', pageSize: SEARCH_LIMIT }, signal);
    return rows.map(row => ({
      id: row.employee_id,
      full_name: row.full_name,
      department: row.department_name,
      position: row.position_name,
      has_terms: row.terms_id !== null,
      has_planned_supplement: row.planned_supplement_amount != null,
      can_edit: row.can_edit !== false,
    }));
  },
};
