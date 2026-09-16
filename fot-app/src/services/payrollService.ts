import { apiClient } from '../api/client';

/** Категория персонала. Задаёт вид оплаты по умолчанию; на расчёт не влияет. */
export type StaffCategory = 'office' | 'itr' | 'worker';
/** Вид оплаты: «по графику» (оклад) или «по часам». */
export type PayrollCalcType = 'salary' | 'hourly';

export const STAFF_CATEGORY_LABELS: Record<StaffCategory, string> = {
  office: 'Офис',
  itr: 'ИТР на объектах',
  worker: 'Рабочие',
};

export const CALC_TYPE_LABELS: Record<PayrollCalcType, string> = {
  salary: 'По графику (оклад)',
  hourly: 'По часам',
};

/** Офис — оклад, стройка — часы. Значение можно переопределить вручную. */
export const defaultCalcTypeFor = (category: StaffCategory): PayrollCalcType =>
  (category === 'office' ? 'salary' : 'hourly');

export interface IPayrollTermsRow {
  employee_id: number;
  full_name: string | null;
  tab_number: string | null;
  department_id: string | null;
  department_name: string | null;
  position_name: string | null;
  /** График, действующий на дату выборки (личный или по умолчанию). */
  schedule_name: string | null;
  /** null — условий на выбранную дату нет: такой сотрудник не попадёт в расчёт. */
  terms_id: number | null;
  staff_category: StaffCategory | null;
  calc_type: PayrollCalcType | null;
  monthly_salary: string | number | null;
  hourly_rate: string | number | null;
  /** Премиальная часть, ₽/мес. */
  bonus_amount: string | number | null;
  /** Компенсация проживания, ₽/мес. */
  housing_compensation: string | number | null;
  staff_units: string | number | null;
  effective_from: string | null;
  effective_to: string | null;
}

export interface IPayrollTermsHistoryRow {
  id: number;
  employee_id: number;
  staff_category: StaffCategory;
  calc_type: PayrollCalcType;
  monthly_salary: string | number | null;
  hourly_rate: string | number | null;
  bonus_amount: string | number | null;
  housing_compensation: string | number | null;
  staff_units: string | number;
  effective_from: string;
  effective_to: string | null;
  change_reason: string | null;
  order_number: string | null;
  order_date: string | null;
  note: string | null;
  created_at: string;
}

export interface IAssignTermsPayload {
  staff_category: StaffCategory;
  calc_type: PayrollCalcType;
  monthly_salary?: number;
  hourly_rate?: number;
  /** Не передано — сумма не задана (прежнее значение очищается). */
  bonus_amount?: number;
  housing_compensation?: number;
  staff_units?: number;
  effective_from: string;
  change_reason?: string;
  order_number?: string;
  order_date?: string;
  note?: string;
}

export interface IAssignResult {
  applied: Array<{ employee_id: number; terms_id: number }>;
  skipped: Array<{ employee_id: number; reason: string; message: string }>;
}

interface IApiResponse<T> { success: boolean; data: T }

/** Итоги считаются сервером по всей отфильтрованной выборке, а не по странице. */
export interface IPayrollTermsListMeta {
  date: string;
  page: number;
  page_size: number;
  total: number;
  /** Сотрудники без условий в своём штате — независимо от фильтров категории и вида оплаты. */
  without_terms_total: number;
  /** Сколько в выборке уже имеют условия. 0 — фильтр по категории / виду оплаты пуст по определению. */
  with_terms_total: number;
  /** false — узел «Подрядные организации» не найден, в списке могут быть их сотрудники. */
  contractors_excluded: boolean;
  /** id узла «Подрядные организации» — его ветку убираем из дерева подразделений. */
  contractor_root_id: string | null;
  /** Курсор следующей порции; null — порция последняя. Поле может отсутствовать у старого бэкенда. */
  next_cursor?: IPayrollTermsCursor | null;
}

/**
 * Ключ сортировки и id последней строки порции — следующая начинается строго после неё.
 * key — значение ключа текстом (суммы тоже текстом, без потери точности); null — пустое.
 */
export interface IPayrollTermsCursor {
  key: string | null;
  isNull: boolean;
  id: number;
}

/** Столбцы с сортировкой (серверный whitelist). */
export type PayrollSortKey = 'name' | 'department' | 'position' | 'schedule' | 'salary' | 'bonus' | 'housing';
export type PayrollSortDir = 'asc' | 'desc';
/** Столбцы с фильтром «список значений»; у ФИО — «содержит». */
export type PayrollValueFilterColumn = Exclude<PayrollSortKey, 'name'>;

/** Фильтры столбцов; null в списке — «(пусто)». */
export interface IPayrollColumnFilters {
  values?: Partial<Record<PayrollValueFilterColumn, (string | null)[]>>;
  text?: { name?: string };
}

export interface IPayrollColumnValues {
  values: { value: string | null; count: number }[];
  /** Вариантов больше 300 — показаны первые, уточняется поиском. */
  truncated: boolean;
}

/** Параметры выборки, общие для списка и вариантов фильтра. */
export interface IPayrollTermsViewParams {
  date?: string;
  departmentId?: string;
  /** Поиск по ФИО и табельному — на сервере, по всему штату. */
  q?: string;
  /** Фильтры столбцов, сериализованные serializePayrollColumnFilters ('' — без фильтров). */
  cf?: string;
}

const appendViewParams = (search: URLSearchParams, params: IPayrollTermsViewParams): void => {
  if (params.date) search.set('date', params.date);
  if (params.departmentId) search.set('department_id', params.departmentId);
  if (params.q) search.set('q', params.q);
  if (params.cf) search.set('cf', params.cf);
};

export interface IPayrollTermsListResult {
  rows: IPayrollTermsRow[];
  meta: IPayrollTermsListMeta;
}

/** Порция подгрузки при прокрутке — максимум, который принимает сервер. */
export const PAYROLL_TERMS_PAGE_SIZE = 500;

export const payrollService = {
  listTerms: async (params: IPayrollTermsViewParams & {
    sort: PayrollSortKey;
    dir: PayrollSortDir;
    pageSize?: number;
    /** Курсор порции; без него — первая порция. */
    cursor?: IPayrollTermsCursor | null;
  }, signal?: AbortSignal): Promise<IPayrollTermsListResult> => {
    const search = new URLSearchParams();
    appendViewParams(search, params);
    search.set('sort', params.sort);
    search.set('dir', params.dir);
    search.set('page_size', String(params.pageSize ?? PAYROLL_TERMS_PAGE_SIZE));
    if (params.cursor) {
      search.set('after_null', params.cursor.isNull ? '1' : '0');
      if (!params.cursor.isNull && params.cursor.key !== null) search.set('after_key', params.cursor.key);
      search.set('after_id', String(params.cursor.id));
    }
    const res = await apiClient.get<IApiResponse<IPayrollTermsRow[]> & { meta: IPayrollTermsListMeta }>(
      `/payroll/terms?${search.toString()}`,
      { signal },
    );
    return { rows: res.data, meta: res.meta };
  },

  /** Варианты фильтра столбца с количеством — без фильтра самого столбца. */
  getColumnValues: async (
    column: PayrollValueFilterColumn,
    valueSearch: string,
    params: IPayrollTermsViewParams,
    signal?: AbortSignal,
  ): Promise<IPayrollColumnValues> => {
    const search = new URLSearchParams();
    appendViewParams(search, params);
    search.set('column', column);
    if (valueSearch) search.set('value_q', valueSearch);
    const res = await apiClient.get<IApiResponse<IPayrollColumnValues>>(
      `/payroll/terms/column-values?${search.toString()}`,
      { signal },
    );
    return res.data;
  },

  getHistory: async (employeeId: number): Promise<IPayrollTermsHistoryRow[]> => {
    const res = await apiClient.get<IApiResponse<IPayrollTermsHistoryRow[]>>(
      `/payroll/terms/employee/${employeeId}`,
    );
    return res.data;
  },

  assign: async (employeeId: number, payload: IAssignTermsPayload): Promise<{ terms_id: number }> => {
    const res = await apiClient.post<IApiResponse<{ terms_id: number }>>(
      `/payroll/terms/employee/${employeeId}`,
      payload,
    );
    return res.data;
  },

  assignBulk: async (employeeIds: number[], payload: IAssignTermsPayload): Promise<IAssignResult> => {
    const res = await apiClient.post<IApiResponse<IAssignResult>>('/payroll/terms/bulk', {
      employee_ids: employeeIds,
      ...payload,
    });
    return res.data;
  },
};
