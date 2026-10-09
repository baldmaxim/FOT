import { apiClient } from '../api/client';

/** Категория персонала — по отделу сотрудника (её ставит сервер); на расчёт не влияет. */
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

/** Начислено сотруднику за месяц. */
export interface IPayrollMonthlyAccrual {
  /** YYYY-MM. */
  month: string;
  /** Начислено всего за месяц, ₽ (NUMERIC может прийти строкой); null — нет данных. */
  amount: string | number | null;
}

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
  /**
   * Категория по текущему отделу: бригады — рабочие, ЛИНИЯ и ЛИНИЯ-Общестрой — ИТР, остальные — офис.
   * Её карточка показывает и её же сервер запишет при назначении. Нет у старого бэкенда.
   */
  department_category?: StaffCategory;
  calc_type: PayrollCalcType | null;
  monthly_salary: string | number | null;
  hourly_rate: string | number | null;
  /** Премиальная часть, ₽/мес. */
  bonus_amount: string | number | null;
  /** Компенсация проживания, ₽/мес. */
  housing_compensation: string | number | null;
  /** Компенсации проезда и связи, ₽/мес. */
  travel_compensation?: string | number | null;
  communication_compensation?: string | number | null;
  /** Ежемесячное удержание, ₽/мес. */
  deduction_amount?: string | number | null;
  staff_units: string | number | null;
  effective_from: string | null;
  effective_to: string | null;
  /**
   * Последняя сохранённая плановая доплата, ₽/мес, и её период (может быть будущим или прошедшим).
   * null — доплаты нет; поля нет у старого бэкенда.
   */
  planned_supplement_amount?: string | number | null;
  planned_supplement_from?: string | null;
  planned_supplement_to?: string | null;
  /**
   * Начисления по месяцам (придут из 1С ЗУП). Сервер пока не отдаёт — источник подключается
   * отдельно; без поля ячейка «Начисления» показывает «—».
   */
  accruals?: IPayrollMonthlyAccrual[] | null;
  /**
   * Скоуп правки этого сотрудника (сервер проверит то же при сохранении).
   * Может отсутствовать у старого бэкенда — тогда считаем «можно», решит сервер.
   */
  can_edit?: boolean;
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
  travel_compensation: string | number | null;
  communication_compensation: string | number | null;
  deduction_amount: string | number | null;
  staff_units: string | number;
  effective_from: string;
  effective_to: string | null;
  change_reason: string | null;
  order_number: string | null;
  order_date: string | null;
  note: string | null;
  created_at: string;
}

/** Категорию сервер ставит сам — по отделу сотрудника. */
export interface IAssignTermsPayload {
  calc_type: PayrollCalcType;
  monthly_salary?: number;
  hourly_rate?: number;
  /** Не передано — сумма не задана (прежнее значение очищается). */
  bonus_amount?: number;
  housing_compensation?: number;
  travel_compensation?: number;
  communication_compensation?: number;
  deduction_amount?: number;
  staff_units?: number;
  effective_from: string;
  /** Плановая доплата: не передано — не менять, null — снять. Только для одного сотрудника. */
  planned_supplement?: IPlannedSupplementPayload | null;
}

/** Плановая доплата: сумма ₽/мес на период «с — по» включительно. */
export interface IPlannedSupplementPayload {
  amount: number;
  date_from: string;
  date_to: string;
}

/** Изменение оклада / ставки. Суммы — текстом NUMERIC; разница — только при том же виде оплаты. */
export interface ISalaryChange {
  effective_from: string;
  /** null — действует по сей день. */
  effective_to: string | null;
  calc_type: PayrollCalcType;
  amount: string;
  prev_calc_type: PayrollCalcType | null;
  prev_amount: string | null;
  diff: string | null;
  diff_percent: string | null;
  changed_by_name: string | null;
  changed_at: string;
}

/** Изменение плановой доплаты. Суммы — текстом NUMERIC. */
export interface IPlannedSupplementChange {
  id: number;
  /** assigned — первая доплата или после снятия; changed — замена; removed — снята. */
  action: 'assigned' | 'changed' | 'removed';
  /** null — доплата снята. */
  amount: string | null;
  date_from: string | null;
  date_to: string | null;
  prev_amount: string | null;
  prev_date_from: string | null;
  prev_date_to: string | null;
  changed_by_name: string | null;
  changed_at: string;
}

/** Запись истории условий: изменение оклада / ставки или плановой доплаты, новые сверху. */
export type IPayrollTermsChange =
  | (ISalaryChange & { kind: 'salary' })
  | (IPlannedSupplementChange & { kind: 'supplement' });

export type VacationStatus = 'vacation' | 'unpaid' | 'educational_leave';

export const VACATION_STATUS_LABELS: Record<VacationStatus, string> = {
  vacation: 'Ежегодный отпуск',
  unpaid: 'Без сохранения ЗП',
  educational_leave: 'Учебный отпуск',
};

/** Сводка по отпуску на сегодня (Москва). Ежегодный — без нерабочих праздничных (ст. 120 ТК). */
export interface IVacationSummary {
  year: number;
  today: string;
  used_days: number;
  planned_days: number;
  unpaid_days: number;
}

export interface IVacationPeriod {
  start_date: string;
  end_date: string;
  status: VacationStatus;
  calendar_days: number;
  holiday_days: number;
  source: 'leave_request' | 'timesheet';
  leave_request_id: number | null;
  reviewer_name: string | null;
  reviewed_at: string | null;
}

export interface IEmployeeVacation {
  summary: IVacationSummary;
  history: IVacationPeriod[];
}

export interface IAssignResult {
  applied: Array<{ employee_id: number; terms_id: number }>;
  skipped: Array<{ employee_id: number; reason: string; message: string }>;
}

/** Статья «Оплачено» — столбец «Сводной ведомости» ЗУП (подписи и группы — utils/payrollPaid). */
export type PayrollPaidItemCode =
  | 'contract' | 'bonus' | 'sick_leave' | 'vacation'
  | 'housing' | 'travel' | 'overtime' | 'recalc_prev' | 'severance' | 'supplement' | 'planned_supplement' | 'loan'
  | 'meals' | 'workwear' | 'safety_fine' | 'fines' | 'writ_deduction';

/** Сумма ячейки «Оплачено»: месяц YYYY-MM, сумма — текстом NUMERIC. */
export interface IPayrollPaidAmount {
  month: string;
  item: PayrollPaidItemCode;
  amount: string;
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

/** Вид удержания из справочника («Расчёты»). */
export interface IPayrollDeductionKind {
  id: number;
  name: string;
}

/** «Расчёты»: строки списка условий у сотрудников с выбранными видами удержаний. */
export interface IPayrollDeductionsResult {
  rows: IPayrollTermsRow[];
  meta: { date: string; contractors_excluded: boolean };
}

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

  /** История условий: оклад / ставка и плановая доплата одним журналом, новые сверху. */
  getTermsChanges: async (employeeId: number, signal?: AbortSignal): Promise<IPayrollTermsChange[]> => {
    const res = await apiClient.get<IApiResponse<IPayrollTermsChange[]>>(
      `/payroll/terms/employee/${employeeId}/changes`,
      { signal },
    );
    return res.data;
  },

  /** Сколько дней отпуска использовано в текущем году и история отпусков по табелю. */
  getVacation: async (employeeId: number, signal?: AbortSignal): Promise<IEmployeeVacation> => {
    const res = await apiClient.get<IApiResponse<IEmployeeVacation>>(
      `/payroll/vacation/employee/${employeeId}`,
      { signal },
    );
    return res.data;
  },

  /** «Оплачено» за месяцы from — to (YYYY-MM, включительно). */
  getPaid: async (employeeId: number, from: string, to: string, signal?: AbortSignal): Promise<IPayrollPaidAmount[]> => {
    const search = new URLSearchParams({ from, to });
    const res = await apiClient.get<IApiResponse<IPayrollPaidAmount[]>>(
      `/payroll/terms/employee/${employeeId}/paid?${search.toString()}`,
      { signal },
    );
    return res.data;
  },

  /** «Расчёты»: сотрудники хотя бы с одним из видов (kindIds не пуст), по ФИО. */
  listDeductions: async (
    params: { date?: string; kindIds: number[] },
    signal?: AbortSignal,
  ): Promise<IPayrollDeductionsResult> => {
    const search = new URLSearchParams({ kind_ids: params.kindIds.join(',') });
    if (params.date) search.set('date', params.date);
    const res = await apiClient.get<IApiResponse<IPayrollTermsRow[]> & { meta: IPayrollDeductionsResult['meta'] }>(
      `/payroll/deductions?${search.toString()}`,
      { signal },
    );
    return { rows: res.data, meta: res.meta };
  },

  /** Справочник видов удержаний — в порядке столбцов «Расчётов». */
  listDeductionKinds: async (signal?: AbortSignal): Promise<IPayrollDeductionKind[]> => {
    const res = await apiClient.get<IApiResponse<IPayrollDeductionKind[]>>('/payroll/deduction-kinds', { signal });
    return res.data;
  },

  /** Виды удержаний сотрудника — для «Удержания» карточки. */
  getEmployeeDeductions: async (employeeId: number, signal?: AbortSignal): Promise<number[]> => {
    const res = await apiClient.get<IApiResponse<{ kind_ids: number[] }>>(
      `/payroll/deductions/employee/${employeeId}`,
      { signal },
    );
    return res.data.kind_ids;
  },

  /** Заменить виды удержаний сотрудника; ответ — сохранённый набор в порядке справочника. */
  saveEmployeeDeductions: async (employeeId: number, kindIds: number[]): Promise<number[]> => {
    const res = await apiClient.put<IApiResponse<{ kind_ids: number[] }>>(
      `/payroll/deductions/employee/${employeeId}`,
      { kind_ids: kindIds },
    );
    return res.data.kind_ids;
  },

  /** Добавить вид удержания; такой уже есть — ApiError 409. */
  addDeductionKind: async (name: string): Promise<IPayrollDeductionKind> => {
    const res = await apiClient.post<IApiResponse<IPayrollDeductionKind>>('/payroll/deduction-kinds', { name });
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
