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
  /** null — условий на выбранную дату нет: такой сотрудник не попадёт в расчёт. */
  terms_id: number | null;
  staff_category: StaffCategory | null;
  calc_type: PayrollCalcType | null;
  monthly_salary: string | number | null;
  hourly_rate: string | number | null;
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
}

export interface IPayrollTermsListResult {
  rows: IPayrollTermsRow[];
  meta: IPayrollTermsListMeta;
}

export const PAYROLL_TERMS_PAGE_SIZE = 100;

export const payrollService = {
  listTerms: async (params: {
    date?: string;
    departmentId?: string;
    staffCategory?: StaffCategory;
    calcType?: PayrollCalcType;
    withoutTerms?: boolean;
    /** Поиск по ФИО и табельному — на сервере, по всему штату. */
    q?: string;
    page?: number;
    pageSize?: number;
  } = {}): Promise<IPayrollTermsListResult> => {
    const search = new URLSearchParams();
    if (params.date) search.set('date', params.date);
    if (params.departmentId) search.set('department_id', params.departmentId);
    if (params.staffCategory) search.set('staff_category', params.staffCategory);
    if (params.calcType) search.set('calc_type', params.calcType);
    if (params.withoutTerms) search.set('without_terms', 'true');
    if (params.q) search.set('q', params.q);
    search.set('page', String(params.page ?? 1));
    search.set('page_size', String(params.pageSize ?? PAYROLL_TERMS_PAGE_SIZE));
    const res = await apiClient.get<IApiResponse<IPayrollTermsRow[]> & { meta: IPayrollTermsListMeta }>(
      `/payroll/terms?${search.toString()}`,
    );
    return { rows: res.data, meta: res.meta };
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
