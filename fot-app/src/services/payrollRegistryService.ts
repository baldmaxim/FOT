import { apiClient } from '../api/client';
import type { ITableExportSnapshot } from '../utils/tableView';
import { payrollService } from './payrollService';
import type { IStaffDeduction, IStaffDeductionPayload } from './staffDeductionService';

/**
 * Таблицы окна «Справочник» на «Расчётах» (миграции 315, 317): «Доплата за проживание», «Доплата за общежитие»,
 * «Доплата», «Без проезда», «Удержания». Строки — «штат зарплаты» (как список условий оплаты), can_edit — охват
 * правки этого сотрудника (сервер проверит то же при записи).
 */

/**
 * Доплата за проживание — квартира «Проживания» (миграция 320): те же записи, что во вкладке кадров
 * «Проживание». Строка — одно проживание в квартире.
 */
export interface IHousingAllowanceRow {
  /** id проживания: ✎ и 🗑 работают с ним. */
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  /** ₽/мес, numeric строкой. */
  amount: string;
  /** YYYY-MM-DD. */
  check_in: string;
  /** YYYY-MM-DD — день выезда (в нём уже не живёт); живёт — null. */
  check_out: string | null;
  address: string | null;
  can_edit: boolean;
}

export type PayrollSupplementKind = 'planned' | 'one_time';

/** Плановая (одна на сотрудника, та же, что в окне сотрудника) или разовая доплата. */
export interface IPayrollSupplementRow {
  kind: PayrollSupplementKind;
  /** id разовой; у плановой — id версии журнала (старый бэкенд — null). */
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
  /** Плановая: последняя версия журнала (false — прошлый период, только история). Нет у старого бэкенда. */
  is_current?: boolean;
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

/**
 * «Без переработки» (миграция 335) — кому не оплачивать переработку: период «с — по» (по включительно, null —
 * бессрочно). В расчёте «К выплате (ФОТ)» выходы сверх нормы и часы по корректировкам в эти даты не оплачиваются.
 */
export interface IOvertimeStop {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  date_from: string;
  date_to: string | null;
  can_edit: boolean;
}

/** Проживание в общежитии, задевающее период доплаты: выезд — день выезда (в нём уже не живёт), null — живёт. */
export interface IDormitoryStayPeriod {
  check_in: string;
  check_out: string | null;
}

/** «Доплата за общежитие» — кому платят за то, что не живёт в общежитии: период «с — по» (по включительно, null — бессрочно). */
export interface IDormitoryAllowanceRow {
  id: number;
  employee_id: number;
  full_name: string;
  department: string | null;
  position: string | null;
  date_from: string;
  date_to: string | null;
  /** ₽/мес, numeric строкой — значение ставки «Доплата за общежитие», одно на всех; не задано — null. */
  amount: string | null;
  /** В месяцах проживания строка не показывается. */
  dormitory_stays: IDormitoryStayPeriod[];
  can_edit: boolean;
}

/**
 * Удержание (миграция 321): та же запись, что во вкладке кадров «Удержания» (вид, подвид, месяц, сумма), с правом
 * правки строки.
 */
export interface IDeductionRegistryRow extends IStaffDeduction {
  can_edit: boolean;
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

/** Квартира: въезд, выезд (null — живёт), сумма ₽/мес, адрес (необязателен). */
export interface IHousingAllowancePayload {
  check_in: string;
  check_out: string | null;
  amount: number | null;
  address: string | null;
}

export interface IPlannedSupplementFields {
  amount: number;
  date_from: string;
  /** null — бессрочно. */
  date_to: string | null;
}

export interface IOneTimeSupplementFields {
  /** YYYY-MM. */
  month: string;
  amount: number;
  reason: string;
}

/** Период «с — по» строки «Без проезда» и «Доплаты за общежитие». */
export interface IRegistryPeriodFields {
  date_from: string;
  date_to: string | null;
}

export type PayrollRegistryTable =
  | 'housing' | 'supplements' | 'compensation-stops' | 'overtime-stops' | 'dormitory-allowances' | 'deductions'
  | 'summary';

interface IApiResponse<T> { success: boolean; data: T }

/**
 * Ключи под префиксом 'payroll-terms': сохранение окна сотрудника (invalidate ['payroll-terms']) перечитывает
 * и эти таблицы, а запись в таблице сбрасывает тот же префикс — список и окно сотрудника видят новое.
 */
export const PAYROLL_REGISTRY_KEYS = {
  housing: ['payroll-terms', 'registry', 'housing'],
  supplements: ['payroll-terms', 'registry', 'supplements'],
  stops: ['payroll-terms', 'registry', 'compensation-stops'],
  overtimeStops: ['payroll-terms', 'registry', 'overtime-stops'],
  dormitoryAllowances: ['payroll-terms', 'registry', 'dormitory-allowances'],
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

  /** Пересечение с другим проживанием или «Доплатой за общежитие» — ApiError 409. */
  addHousing: async (employeeId: number, payload: IHousingAllowancePayload): Promise<void> => {
    await apiClient.post('/payroll/housing-allowances', { employee_id: employeeId, ...payload });
  },

  updateHousing: async (id: number, payload: IHousingAllowancePayload): Promise<void> => {
    await apiClient.patch(`/payroll/housing-allowances/${id}`, payload);
  },

  removeHousing: async (id: number): Promise<void> => {
    await apiClient.delete(`/payroll/housing-allowances/${id}`);
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
  addStop: async (employeeId: number, fields: IRegistryPeriodFields): Promise<void> => {
    await apiClient.post('/payroll/compensation-stops', { employee_id: employeeId, ...fields });
  },

  updateStop: async (id: number, fields: IRegistryPeriodFields): Promise<void> => {
    await apiClient.patch(`/payroll/compensation-stops/${id}`, fields);
  },

  removeStop: async (id: number): Promise<void> => {
    await apiClient.delete(`/payroll/compensation-stops/${id}`);
  },

  listOvertimeStops: (signal?: AbortSignal) => list<IOvertimeStop>('/payroll/overtime-stops', signal),

  /** Пересечение с другим периодом сотрудника — ApiError 409 OVERTIME_STOP_OVERLAP. */
  addOvertimeStop: async (employeeId: number, fields: IRegistryPeriodFields): Promise<void> => {
    await apiClient.post('/payroll/overtime-stops', { employee_id: employeeId, ...fields });
  },

  updateOvertimeStop: async (id: number, fields: IRegistryPeriodFields): Promise<void> => {
    await apiClient.patch(`/payroll/overtime-stops/${id}`, fields);
  },

  removeOvertimeStop: async (id: number): Promise<void> => {
    await apiClient.delete(`/payroll/overtime-stops/${id}`);
  },

  listDormitoryAllowances: (signal?: AbortSignal) =>
    list<IDormitoryAllowanceRow>('/payroll/dormitory-allowances', signal),

  /**
   * Тот же период уже есть — ответ им же, второй строки нет. ApiError 409: ALLOWANCE_OVERLAP — пересечение,
   * LIVES_IN_DORMITORY — дни проживания в общежитии, HAS_HOUSING — в эти дни доплата за проживание.
   */
  addDormitoryAllowance: async (employeeId: number, fields: IRegistryPeriodFields): Promise<void> => {
    await apiClient.post('/payroll/dormitory-allowances', { employee_id: employeeId, ...fields });
  },

  updateDormitoryAllowance: async (id: number, fields: IRegistryPeriodFields): Promise<void> => {
    await apiClient.patch(`/payroll/dormitory-allowances/${id}`, fields);
  },

  removeDormitoryAllowance: async (id: number): Promise<void> => {
    await apiClient.delete(`/payroll/dormitory-allowances/${id}`);
  },

  /** months — registryMonthsParam выбора. */
  listDeductions: (months: string, signal?: AbortSignal) =>
    list<IDeductionRegistryRow>(withMonths('/payroll/staff-deductions', months), signal),

  /** Вида или подвида уже нет — ApiError 409. */
  addDeduction: async (employeeId: number, payload: IStaffDeductionPayload): Promise<void> => {
    await apiClient.post('/payroll/staff-deductions', { employee_id: employeeId, ...payload });
  },

  updateDeduction: async (id: number, payload: IStaffDeductionPayload): Promise<void> => {
    await apiClient.patch(`/payroll/staff-deductions/${id}`, payload);
  },

  removeDeduction: async (id: number): Promise<void> => {
    await apiClient.delete(`/payroll/staff-deductions/${id}`);
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
