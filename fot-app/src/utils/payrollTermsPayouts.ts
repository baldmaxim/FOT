/**
 * «Условия оплаты» → «Выплачено» (решение пользователя 09.11.2026): список сразу присылает суммы 1С («Оплачено»), а
 * месяц без «Зарплаты» 1С считает ФОТ — отдельным запросом по каждой порции (payrollService.termsPayouts). Запросы —
 * по одному, по порядку порций: расчёт тяжёлый. Суммы порции заменяются только её успешным ответом: пока он считается
 * или не удался, на экране остаются суммы 1С из списка.
 */
import type { QueryState } from '@tanstack/react-query';

import type {
  IPayrollMonthlyAccrual,
  IPayrollTermsPayoutsResult,
  IPayrollTermsRow,
} from '../services/payrollService';

/** Запрос порции: её id и дата, с которой она загружена (keepPreviousData держит строки прежней даты). */
export interface ITermsPayoutsRequest {
  ids: number[];
  date: string;
}

/** Ключ кэша — под 'payroll-terms': сбросы условий, ставок и удержаний перечитают и «Выплачено». */
export const termsPayoutsQueryKey = (request: ITermsPayoutsRequest) => (
  ['payroll-terms', 'payouts', request.ids, request.date] as const
);

/**
 * Сколько сотрудников в одном запросе. Порция списка — 500, а расчёт 500 человек за полгода идёт ~20 с без бригад
 * (прод, 09.11.2026): по 100 верхние строки заполняются через несколько секунд, и запрос не упирается в таймаут прокси.
 */
export const TERMS_PAYOUTS_CHUNK = 100;

/** Запросы по порциям списка, в их порядке, по TERMS_PAYOUTS_CHUNK id; пустая порция запроса не даёт. */
export const termsPayoutsRequests = (
  pages: ReadonlyArray<{ rows: readonly IPayrollTermsRow[]; date: string }>,
): ITermsPayoutsRequest[] => pages.flatMap(page => {
  const ids = page.rows.map(row => row.employee_id);
  return Array.from({ length: Math.ceil(ids.length / TERMS_PAYOUTS_CHUNK) }, (_, index) => ({
    ids: ids.slice(index * TERMS_PAYOUTS_CHUNK, (index + 1) * TERMS_PAYOUTS_CHUNK),
    date: page.date,
  }));
});

export type TermsPayoutsState =
  | { status: 'pending' }
  | { status: 'error' }
  | { status: 'success'; result: IPayrollTermsPayoutsResult };

/** Состояние из кэша React Query — синхронно, до useQueries: по нему решается, запускать ли следующую порцию. */
export const toTermsPayoutsState = (state: QueryState<IPayrollTermsPayoutsResult> | undefined): TermsPayoutsState => {
  if (state?.status === 'success' && state.data) return { status: 'success', result: state.data };
  return state?.status === 'error' ? { status: 'error' } : { status: 'pending' };
};

/** Запускать ли порцию index: экран на виду и предыдущая порция завершилась — успехом или ошибкой. */
export const termsPayoutsQueryEnabled = (
  index: number,
  states: readonly TermsPayoutsState[],
  active: boolean,
): boolean => active && (index === 0 || (states[index - 1] !== undefined && states[index - 1].status !== 'pending'));

export interface ITermsPayoutsMerge {
  rows: IPayrollTermsRow[];
}

/**
 * Строки с «Выплачено» порций: успешный ответ заменяет payouts строки (месяцев без суммы в нём нет — «—»); порция
 * считается или не посчиталась — payouts списка (1С) остаются, payouts_status 'pending' или 'error'. id, которого нет
 * в ответе (вне охвата расчёта), — без изменений.
 */
export const mergeTermsPayouts = (
  rows: readonly IPayrollTermsRow[],
  requests: readonly ITermsPayoutsRequest[],
  states: readonly TermsPayoutsState[],
): ITermsPayoutsMerge => {
  const payoutsById = new Map<number, IPayrollMonthlyAccrual[]>();
  const statusById = new Map<number, 'pending' | 'error'>();
  requests.forEach((request, index) => {
    const state = states[index] ?? { status: 'pending' };
    if (state.status === 'success') {
      for (const item of state.result.rows) payoutsById.set(item.employee_id, item.payouts);
    } else {
      for (const id of request.ids) statusById.set(id, state.status);
    }
  });
  return {
    rows: rows.map(row => {
      const status = statusById.get(row.employee_id);
      if (status) return { ...row, payouts_status: status };
      const payouts = payoutsById.get(row.employee_id);
      return payouts ? { ...row, payouts } : row;
    }),
  };
};
