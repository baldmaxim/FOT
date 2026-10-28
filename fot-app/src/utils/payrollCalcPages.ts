/**
 * «Расчёты»: строки списка приходят сразу (defer_calc=1), столбцы ФОТ — отдельным запросом по каждой порции
 * (payrollService.calcColumns). Запросы — по одному, по порядку порций: расчёт тяжёлый, параллельные заняли бы пул БД.
 * Следующая порция стартует, когда предыдущая завершилась — успехом или ошибкой; ответ «ФОТ недоступен» (больше 12
 * месяцев) — на весь период, остальные порции не запрашиваются.
 */
import type { QueryState } from '@tanstack/react-query';

import type {
  IPayrollCalcColumns,
  IPayrollCalcColumnsResult,
  IPayrollTermsRow,
  PayrollPaidMonths,
} from '../services/payrollService';

/** Запрос столбцов ФОТ порции: её id и её месяцы — снимок порции (keepPreviousData держит строки прежнего периода). */
export interface ICalcPageRequest {
  ids: number[];
  months: PayrollPaidMonths;
}

/** Ключ кэша — под 'payroll-terms': существующие сбросы условий, ставок и удержаний перечитают и ФОТ. */
export const calcColumnsQueryKey = (request: ICalcPageRequest) => (
  ['payroll-terms', 'calc-columns', request.ids, request.months] as const
);

/**
 * Порции, которым нужен отдельный расчёт: строки без поля calc. Старый бэкенд считает сам и отдаёт calc (в том числе
 * null) — по наличию поля, не по значению.
 */
export const calcPageRequests = (
  pages: ReadonlyArray<{ rows: readonly IPayrollTermsRow[]; paidMonths: PayrollPaidMonths | null }>,
): ICalcPageRequest[] => pages.flatMap(page => {
  if (page.paidMonths === null) return [];
  const ids = page.rows.filter(row => !('calc' in row)).map(row => row.employee_id);
  return ids.length > 0 ? [{ ids, months: page.paidMonths }] : [];
});

export type CalcQueryState =
  | { status: 'pending' }
  | { status: 'error' }
  | { status: 'success'; result: IPayrollCalcColumnsResult };

/** Состояние из кэша React Query — синхронно, до вызова useQueries: по нему решается, запускать ли следующую порцию. */
export const toCalcQueryState = (state: QueryState<IPayrollCalcColumnsResult> | undefined): CalcQueryState => {
  if (state?.status === 'success' && state.data) return { status: 'success', result: state.data };
  return state?.status === 'error' ? { status: 'error' } : { status: 'pending' };
};

const isUnavailable = (state: CalcQueryState | undefined): boolean => (
  state?.status === 'success' && !state.result.available
);

/**
 * Запускать ли запрос порции index: экран на виду, предыдущая порция завершилась (успехом или ошибкой) и ни одна
 * прежняя не ответила «ФОТ недоступен».
 */
export const calcQueryEnabled = (index: number, states: readonly CalcQueryState[], active: boolean): boolean => {
  if (!active || states.slice(0, index).some(isUnavailable)) return false;
  return index === 0 || (states[index - 1] !== undefined && states[index - 1].status !== 'pending');
};

export interface ICalcMerge {
  rows: IPayrollTermsRow[];
  /** Все порции посчитаны (или ФОТ недоступен) — пустые столбцы ФОТ можно скрывать. */
  ready: boolean;
  /** Хоть одна порция не посчиталась — над таблицей «Повторить». */
  failed: boolean;
}

/**
 * Строки с подмешанными столбцами ФОТ. Порция считается — calc_status 'pending' («…»), не посчиталась — 'error';
 * ФОТ недоступен — строки без calc и без статуса. id порции без ответа (вне охвата) — calc null.
 */
export const mergeCalcColumns = (
  rows: readonly IPayrollTermsRow[],
  requests: readonly ICalcPageRequest[],
  states: readonly CalcQueryState[],
): ICalcMerge => {
  const unavailable = states.some(isUnavailable);
  const calcById = new Map<number, IPayrollCalcColumns | null>();
  const statusById = new Map<number, 'pending' | 'error'>();
  if (!unavailable) {
    requests.forEach((request, index) => {
      const state = states[index] ?? { status: 'pending' };
      if (state.status === 'success') {
        for (const item of state.result.rows) calcById.set(item.employee_id, item.calc);
        for (const id of request.ids) if (!calcById.has(id)) calcById.set(id, null);
      } else {
        for (const id of request.ids) statusById.set(id, state.status);
      }
    });
  }
  return {
    rows: rows.map(row => {
      if ('calc' in row || unavailable) return row;
      const status = statusById.get(row.employee_id);
      if (status) return { ...row, calc_status: status };
      return calcById.has(row.employee_id) ? { ...row, calc: calcById.get(row.employee_id) ?? null } : row;
    }),
    ready: unavailable || requests.every((_, index) => states[index]?.status === 'success'),
    failed: !unavailable && states.some(state => state.status === 'error'),
  };
};
