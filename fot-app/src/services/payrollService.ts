import { apiClient } from '../api/client';
import type {
  IDeductionSubkind,
  IDeductionSubkindsApi,
  IStaffDeduction,
  IStaffDeductionKind,
} from './staffDeductionService';

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
  /** Компенсации проезда и связи, ₽/мес. Проезд условий с миграции 324 не используется — см. travel_rate. */
  travel_compensation?: string | number | null;
  communication_compensation?: string | number | null;
  /**
   * Проезд (миграция 324): ставка «Проезд» за месяц даты выборки, NUMERIC строкой; null — не задана. Положен ли
   * сотруднику — по категории и travel_stopped (travelAllowance). Нет у старого бэкенда.
   */
  travel_rate?: string | null;
  /** В месяце даты выборки есть день «Без проезда». */
  travel_stopped?: boolean;
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
  /** Начисления по месяцам из «Оплачено» (1С ЗУП); без поля ячейка «Начисления» показывает «—». */
  accruals?: IPayrollMonthlyAccrual[] | null;
  /**
   * «Расчёты» (список с paidMonths) — суммы «Оплачено» за месяцы, ₽, NUMERIC строкой; null — сумм нет («—»).
   * Итог «Начислено»; «К выплате» — он минус paid_deductions_total, как в «Своде».
   */
  paid_total?: string | null;
  /** Итог «Удержано», NUMERIC строкой; «0.00» — суммы есть и дают ноль. */
  paid_deductions_total?: string | null;
  /** Статьи «Удержано» по месяцам — для окна удержаний. */
  paid_deductions?: IPayrollPaidAmount[] | null;
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
  /** Категория из окна сотрудника; не передано — сервер ставит по отделу. */
  staff_category?: StaffCategory;
  calc_type: PayrollCalcType;
  monthly_salary?: number;
  hourly_rate?: number;
  /** Не передано — сумма не задана (прежнее значение очищается). */
  bonus_amount?: number;
  housing_compensation?: number;
  communication_compensation?: number;
  staff_units?: number;
  effective_from: string;
  /** Плановая доплата: не передано — не менять, null — снять. Только для одного сотрудника. */
  planned_supplement?: IPlannedSupplementPayload | null;
}

/** Плановая доплата: сумма ₽/мес на период «с — по» включительно; «по» null — бессрочно. */
export interface IPlannedSupplementPayload {
  amount: number;
  date_from: string;
  date_to: string | null;
}

/** Изменение оклада / ставки. Суммы — текстом NUMERIC; разница — только при том же виде оплаты. */
export interface ISalaryChange {
  effective_from: string;
  /** null — действует по сей день. */
  effective_to: string | null;
  calc_type: PayrollCalcType;
  amount: string;
  /** Премия ₽/мес; null — не задана. */
  bonus: string | null;
  /** Оклад + премия; у почасовой — null. */
  total: string | null;
  prev_calc_type: PayrollCalcType | null;
  prev_amount: string | null;
  prev_bonus: string | null;
  prev_total: string | null;
  /** У оклада — разница итога (оклад + премия), у ставки — ставки. */
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

/**
 * Остаток ежегодного отпуска на сегодня: 1С на as_of (или 0 с даты приёма) + 2,33 за месяц − отгулено.
 * Дни — строкой до сотых, как NUMERIC.
 */
export interface IVacationBalance {
  source: '1c' | 'hire';
  as_of: string;
  opening_days: string;
  until: string;
  accrued_months: number;
  accrued_days: string;
  used_days: number;
  unpaid_excess_days: number;
  current_days: string;
}

export interface IEmployeeVacation {
  summary: IVacationSummary;
  history: IVacationPeriod[];
  /** null — остатка 1С нет и принят не после выгрузки: не с чего считать. */
  balance: IVacationBalance | null;
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

/** Условия оплаты, действовавшие в месяце расчётного листка. Сумма — текстом NUMERIC. */
export interface IPayslipTerms {
  effective_from: string;
  /** null — действуют дальше месяца. */
  effective_to: string | null;
  calc_type: PayrollCalcType;
  /** Оклад ₽/мес или ставка ₽/час; null — не задана. */
  amount: string | null;
}

/** К расчётному листку «Истории выплат»: период, дни табеля ФОТ и условия месяца. Суммы — из «Оплачено». */
export interface IPayrollPayslipInfo {
  month: string;
  /** null — сотрудник в месяце не работал (уволен раньше). */
  period_from: string | null;
  period_to: string | null;
  /** Отработано: рабочие дни графика (с плановыми выходными) и выходные сверх графика; null — нет в табеле. */
  worked_days: { workday: number; dayoff: number } | null;
  terms: IPayslipTerms[];
  /** «По ставкам ФОТ» за месяц (миграция 324); нет у старого бэкенда. В «Всего начислено» (ЗУП) не входят. */
  rate_allowances?: IPayslipRateAllowance[];
}

export type PayslipRateAllowanceCode = 'travel' | 'housing' | 'dormitory_allowance';

/** Сумма по ставке «Справочника» за месяц листка — NUMERIC строкой. */
export interface IPayslipRateAllowance {
  code: PayslipRateAllowanceCode;
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

/** Вид удержания — ответ на добавление и переименование в «Справочнике» (список — с подвидами, IStaffDeductionKind). */
export interface IPayrollDeductionKind {
  id: number;
  name: string;
}

/** Значение ставки с месяца effective_from (YYYY-MM) до следующей записи; null — ставку отключили. */
export interface IPayrollRateValue {
  effective_from: string;
  amount: string | null;
}

/** Ставка из справочника («Расчёты» → «Справочник»). Значение — текстом NUMERIC; не задано — null. */
export interface IPayrollRate {
  id: number;
  name: string;
  /** Значение на текущий месяц МСК. */
  amount: string | number | null;
  /** Ставка, привязанная к функционалу (миграция 313): название не меняется, удалить нельзя. */
  code: string | null;
  /** История значений по возрастанию месяца (миграция 324); нет у старого бэкенда. */
  values?: IPayrollRateValue[];
}

/**
 * Код ставки «Доплата за проживание» (миграция 315): у неё кнопка с таблицей доплат, значение — сумма
 * по умолчанию при добавлении сотрудника в эту таблицу.
 */
export const HOUSING_RATE_CODE = 'housing';

/** Код ставки «Доплата за общежитие» (миграция 317): её значение за месяц — сумма всем из таблицы «Общежитие». */
export const DORMITORY_ALLOWANCE_RATE_CODE = 'dormitory_allowance';

/** Учётка из списка доступа к разделу «Зарплата» (миграция 310) — окно «Справочник», только чтение. */
export interface IPayrollSectionUser {
  user_id: string;
  full_name: string | null;
}

/** Название и значение ставки при правке; значение — с месяца effective_month (не передан — с текущего). */
export interface IPayrollRatePayload {
  name: string;
  amount: number | null;
  effective_month?: string;
}

export interface IPayrollTermsListResult {
  rows: IPayrollTermsRow[];
  meta: IPayrollTermsListMeta;
}

/** Порция подгрузки при прокрутке — максимум, который принимает сервер. */
export const PAYROLL_TERMS_PAGE_SIZE = 500;

/** Месяцы сумм «Расчётов» (YYYY-MM); пусто или 'all' — весь период, как у «Свода». */
export type PayrollPaidMonths = string[] | 'all';

export const payrollService = {
  listTerms: async (params: IPayrollTermsViewParams & {
    sort: PayrollSortKey;
    dir: PayrollSortDir;
    pageSize?: number;
    /** Курсор порции; без него — первая порция. */
    cursor?: IPayrollTermsCursor | null;
    /** «Расчёты»: суммы «Оплачено» за эти месяцы вместо «Начислений». */
    paidMonths?: PayrollPaidMonths;
  }, signal?: AbortSignal): Promise<IPayrollTermsListResult> => {
    const search = new URLSearchParams();
    appendViewParams(search, params);
    search.set('sort', params.sort);
    search.set('dir', params.dir);
    search.set('page_size', String(params.pageSize ?? PAYROLL_TERMS_PAGE_SIZE));
    if (params.paidMonths) {
      const { paidMonths } = params;
      search.set('paid_months', paidMonths === 'all' || paidMonths.length === 0 ? 'all' : paidMonths.join(','));
    }
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

  /** Сколько дней отпуска использовано в текущем году, остаток и история отпусков по табелю. */
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

  /** Расчётный листок месяца YYYY-MM: период, дни табеля и условия оплаты. */
  getPayslip: async (employeeId: number, month: string, signal?: AbortSignal): Promise<IPayrollPayslipInfo> => {
    const search = new URLSearchParams({ month });
    const res = await apiClient.get<IApiResponse<IPayrollPayslipInfo>>(
      `/payroll/terms/employee/${employeeId}/payslip?${search.toString()}`,
      { signal },
    );
    return res.data;
  },

  /** Справочник видов удержаний с подвидами — в порядке списка; то же дерево, что у кадров. */
  listDeductionKinds: async (signal?: AbortSignal): Promise<IStaffDeductionKind[]> => {
    const res = await apiClient.get<IApiResponse<IStaffDeductionKind[]>>('/payroll/deduction-kinds', { signal });
    return res.data;
  },

  /** Удержания сотрудника (вид, подвид, месяц, сумма) — в его окне на «Расчётах» только чтение. */
  getEmployeeStaffDeductions: async (employeeId: number, signal?: AbortSignal): Promise<IStaffDeduction[]> => {
    const res = await apiClient.get<IApiResponse<IStaffDeduction[]>>(
      `/payroll/deductions/employee/${employeeId}/staff`,
      { signal },
    );
    return res.data;
  },

  /** Добавить вид удержания; такой уже есть — ApiError 409. */
  addDeductionKind: async (name: string): Promise<IPayrollDeductionKind> => {
    const res = await apiClient.post<IApiResponse<IPayrollDeductionKind>>('/payroll/deduction-kinds', { name });
    return res.data;
  },

  /** Переименовать вид удержания; название занято — ApiError 409. */
  renameDeductionKind: async (kindId: number, name: string): Promise<IPayrollDeductionKind> => {
    const res = await apiClient.patch<IApiResponse<IPayrollDeductionKind>>(`/payroll/deduction-kinds/${kindId}`, { name });
    return res.data;
  },

  /** Удалить вид удержания; назначен сотрудникам — ApiError 409. */
  deleteDeductionKind: async (kindId: number): Promise<void> => {
    await apiClient.delete<IApiResponse<IPayrollDeductionKind>>(`/payroll/deduction-kinds/${kindId}`);
  },

  /** Подвиды видов — тот же справочник, что у кадров, через API «Зарплаты». */
  deductionSubkinds: {
    add: async (kindId, payload) => {
      const res = await apiClient.post<IApiResponse<IDeductionSubkind>>(`/payroll/deduction-kinds/${kindId}/subkinds`, payload);
      return res.data;
    },
    update: async (subkindId, payload) => {
      const res = await apiClient.patch<IApiResponse<IDeductionSubkind>>(`/payroll/deduction-subkinds/${subkindId}`, payload);
      return res.data;
    },
    remove: async subkindId => {
      await apiClient.delete<IApiResponse<IDeductionSubkind>>(`/payroll/deduction-subkinds/${subkindId}`);
    },
  } satisfies IDeductionSubkindsApi,

  /** Справочник ставок — в порядке добавления. */
  listRates: async (signal?: AbortSignal): Promise<IPayrollRate[]> => {
    const res = await apiClient.get<IApiResponse<IPayrollRate[]>>('/payroll/rates', { signal });
    return res.data;
  },

  /** Изменить название и значение ставки; название занято или у ставки с кодом сменили название — ApiError 409. */
  updateRate: async (rateId: number, payload: IPayrollRatePayload): Promise<IPayrollRate> => {
    const res = await apiClient.patch<IApiResponse<IPayrollRate>>(`/payroll/rates/${rateId}`, payload);
    return res.data;
  },

  deleteRate: async (rateId: number): Promise<void> => {
    await apiClient.delete<IApiResponse<IPayrollRate>>(`/payroll/rates/${rateId}`);
  },

  /** Кому доступен раздел «Зарплата» — по алфавиту. Список ведётся в БД. */
  listSectionAccess: async (signal?: AbortSignal): Promise<IPayrollSectionUser[]> => {
    const res = await apiClient.get<IApiResponse<IPayrollSectionUser[]>>('/payroll/section-access', { signal });
    return res.data;
  },

  assign: async (employeeId: number, payload: IAssignTermsPayload): Promise<{ terms_id: number }> => {
    const res = await apiClient.post<IApiResponse<{ terms_id: number }>>(
      `/payroll/terms/employee/${employeeId}`,
      payload,
    );
    return res.data;
  },
};
