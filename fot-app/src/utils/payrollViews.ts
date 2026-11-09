/**
 * Экраны вкладки «Выплаты» раздела «Зарплата» (?view=) и сотрудник вкладки «Подробно».
 */
import type { IPayrollTermsRow, PayrollDepartmentGroup } from '../services/payrollService';

export type PaymentsView = 'terms' | 'details' | 'calc';

export interface IPaymentsViewOption {
  key: PaymentsView;
  label: string;
}

/** «Подробно» — карточка сотрудника из «Условий оплаты»: тот же ключ /salary/terms, место сразу за списком. */
const TERMS_VIEWS: IPaymentsViewOption[] = [
  { key: 'terms', label: 'Условия оплаты' },
  { key: 'details', label: 'Подробно' },
];

const CALC_VIEWS: IPaymentsViewOption[] = [{ key: 'calc', label: 'Расчёты' }];

/** Экраны по правам — в порядке переключателя. */
export const paymentsViewOptions = (canTerms: boolean, canCalc: boolean): IPaymentsViewOption[] => [
  ...(canTerms ? TERMS_VIEWS : []),
  ...(canCalc ? CALC_VIEWS : []),
];

/** Экран из ?view=, если он доступен по правам; иначе первый доступный. */
export const resolvePaymentsView = (
  requested: string | null,
  options: readonly IPaymentsViewOption[],
): PaymentsView => options.find(option => option.key === requested)?.key ?? options[0]?.key ?? 'terms';

/** Клик по строке: тот же сотрудник — прежняя карточка с введёнными значениями, другой — новая. */
export const openPayrollDetails = (current: IPayrollTermsRow | null, row: IPayrollTermsRow): IPayrollTermsRow => (
  current?.employee_id === row.employee_id ? current : row
);

/**
 * Условия сотрудников изменились (сохранение карточки): карточка одного из них закрывается —
 * её форма собрана до изменения. Карточку другого сотрудника результат не трогает.
 */
export const dropPayrollDetails = (
  current: IPayrollTermsRow | null,
  changedEmployeeIds: readonly number[],
): IPayrollTermsRow | null => (current && changedEmployeeIds.includes(current.employee_id) ? null : current);

/** Сотрудник, открытый в «Подробно» кликом в «Условиях оплаты», — «Расчёты» показывают только его. */
export interface ICalcFocus {
  employeeId: number;
  fullName: string | null;
}

export interface ICalcViewFilters {
  /** Только этот сотрудник — по id, тёзки не попадают. */
  employeeId?: number;
  search: string;
  departmentId: string;
}

/**
 * Фильтры «Расчётов»: открыта карточка — его ФИО в поиске (видно, кто отобран), «Все отделы» и id; иначе — общие с
 * «Условиями оплаты» поиск и отдел. Снимается правкой поиска или отдела на «Расчётах» (крестик — общая таблица).
 */
export const calcViewFilters = (focus: ICalcFocus | null, search: string, departmentId: string): ICalcViewFilters => (
  focus ? { employeeId: focus.employeeId, search: focus.fullName ?? '', departmentId: '' } : { search, departmentId }
);

/** Объект «Свода» в поле «Все объекты»: имя хранится — выбранный объект виден по имени и вне нового списка. */
export interface ICalcObject {
  key: string;
  name: string;
}

/**
 * Фильтры «Расчётов» сверх отдела: группа отделов из списка «Все отделы» (ИТР / Рабочие — по отделу, выбирается
 * вместо отдела) и объект месяца, как в «Своде». null — «Все».
 */
export interface ICalcMonthFilter {
  group: PayrollDepartmentGroup | null;
  object: ICalcObject | null;
}

export const EMPTY_CALC_MONTH_FILTER: ICalcMonthFilter = { group: null, object: null };

/** Открыта карточка — «Расчёты» только этого сотрудника: группа и объект, как и отдел, — «Все». */
export const calcMonthFilterOf = (focus: ICalcFocus | null, filter: ICalcMonthFilter): ICalcMonthFilter => (
  focus ? EMPTY_CALC_MONTH_FILTER : filter
);

/** Вкладка карточки сотрудника раздела «Зарплата». */
export type PayrollCardTab = 'terms' | 'history';

/** Что выбрано в карточке «Подробно»: месяцы (null — по умолчанию) и вкладка. */
export interface IPayrollCardView {
  months: string[] | null;
  tab: PayrollCardTab;
}

/**
 * Что показать при возврате с карточки посещаемости. Лежит в записи истории браузера, поэтому сумм здесь нет:
 * строку сотрудника заново запрашивают с сервера.
 */
export interface IPayrollReturn {
  employeeId: number;
  card: IPayrollCardView;
  search: string;
  departmentId: string;
  calcFocus: ICalcFocus | null;
  /** Нет у записей, сделанных до фильтров группы и объекта. */
  calcMonthFilter?: ICalcMonthFilter;
}

const DEPARTMENT_GROUPS: readonly PayrollDepartmentGroup[] = ['itr', 'worker'];

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

const readCardView = (value: unknown): IPayrollCardView | null => {
  if (!isRecord(value)) return null;
  const { months, tab } = value;
  if (tab !== 'terms' && tab !== 'history') return null;
  if (months === null) return { months: null, tab };
  if (!Array.isArray(months) || months.length === 0) return null;
  const valid = months.filter((month): month is string => typeof month === 'string' && MONTH_PATTERN.test(month));
  return valid.length === months.length ? { months: valid, tab } : null;
};

/** undefined — поля нет (старая запись); null — поле есть, но не такое. */
const readMonthFilter = (value: unknown): ICalcMonthFilter | null | undefined => {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  const { object } = value;
  // Запись до 09.11.2026: группа «Офис» с тех пор влита в «ИТР».
  const group = value.group === 'office' ? 'itr' : value.group;
  if (group !== null && !DEPARTMENT_GROUPS.includes(group as PayrollDepartmentGroup)) return null;
  if (object === null) return { group: group as PayrollDepartmentGroup | null, object: null };
  if (!isRecord(object) || typeof object.key !== 'string' || typeof object.name !== 'string') return null;
  return { group: group as PayrollDepartmentGroup | null, object: { key: object.key, name: object.name } };
};

/** Запись истории браузера → что показать при возврате; любое несоответствие — null целиком. */
export const readPayrollReturn = (state: unknown): IPayrollReturn | null => {
  if (!isRecord(state) || !isRecord(state.payrollReturn)) return null;
  const { employeeId, card, search, departmentId, calcFocus, calcMonthFilter } = state.payrollReturn;
  if (typeof employeeId !== 'number' || !Number.isSafeInteger(employeeId) || employeeId <= 0) return null;
  if (typeof search !== 'string' || typeof departmentId !== 'string') return null;
  const cardView = readCardView(card);
  if (!cardView) return null;
  const monthFilter = readMonthFilter(calcMonthFilter);
  if (monthFilter === null) return null;
  const base = { employeeId, card: cardView, search, departmentId, ...(monthFilter ? { calcMonthFilter: monthFilter } : {}) };
  if (calcFocus === null) return { ...base, calcFocus: null };
  if (!isRecord(calcFocus) || calcFocus.employeeId !== employeeId) return null;
  const { fullName } = calcFocus;
  if (fullName !== null && typeof fullName !== 'string') return null;
  return { ...base, calcFocus: { employeeId, fullName } };
};

/** Карточка посещаемости: календарь на последнем из выбранных месяцев. */
export const employeeCardPath = (employeeId: number, months: readonly string[]): string => {
  const last = [...months].sort().at(-1);
  return last ? `/employees/${employeeId}?date=${last}-01` : `/employees/${employeeId}`;
};
