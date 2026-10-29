/**
 * Экраны вкладки «Выплаты» раздела «Зарплата» (?view=) и сотрудник вкладки «Подробно».
 */
import type { IPayrollTermsRow } from '../services/payrollService';

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
