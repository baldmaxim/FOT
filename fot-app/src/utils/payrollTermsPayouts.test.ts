import { describe, expect, it } from 'vitest';

import type { IPayrollTermsRow } from '../services/payrollService';
import { accrualsByMonthParts } from './payrollAccruals';
import { formatPayrollMoney } from './payrollFormat';
import {
  mergeTermsPayouts,
  TERMS_PAYOUTS_CHUNK,
  termsPayoutsQueryEnabled,
  termsPayoutsQueryKey,
  termsPayoutsRequests,
  type TermsPayoutsState,
} from './payrollTermsPayouts';

const row = (employeeId: number, over: Partial<IPayrollTermsRow> = {}): IPayrollTermsRow => (
  { employee_id: employeeId, ...over } as IPayrollTermsRow
);
const ONE_C = [{ month: '2026-08', amount: '184482.78' }];
const success = (rows: Array<{ employee_id: number; payouts: Array<{ month: string; amount: string }> }>): TermsPayoutsState => (
  { status: 'success', result: { months: ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10'], rows } }
);

describe('«Выплачено» «Условий оплаты»: порции', () => {
  it('запрос порции — её id и её дата: строки прежней даты не считаются по новой', () => {
    const requests = termsPayoutsRequests([
      { rows: [row(1), row(2)], date: '2026-11-09' },
      { rows: [], date: '2026-11-09' },
      { rows: [row(3)], date: '2026-12-01' },
    ]);
    expect(requests).toEqual([{ ids: [1, 2], date: '2026-11-09' }, { ids: [3], date: '2026-12-01' }]);
    expect(termsPayoutsQueryKey(requests[0])).toEqual(['payroll-terms', 'payouts', [1, 2], '2026-11-09']);
  });

  it('порция больше TERMS_PAYOUTS_CHUNK — несколько запросов по порядку строк', () => {
    const ids = Array.from({ length: TERMS_PAYOUTS_CHUNK * 2 + 1 }, (_, index) => index + 1);
    const requests = termsPayoutsRequests([{ rows: ids.map(id => row(id)), date: '2026-11-09' }]);
    expect(requests.map(request => request.ids.length)).toEqual([TERMS_PAYOUTS_CHUNK, TERMS_PAYOUTS_CHUNK, 1]);
    expect(requests.flatMap(request => request.ids)).toEqual(ids);
  });

  it('по одной: следующая — после завершения предыдущей, даже ошибкой; скрытый экран — стоп', () => {
    const pending: TermsPayoutsState = { status: 'pending' };
    const error: TermsPayoutsState = { status: 'error' };
    expect(termsPayoutsQueryEnabled(0, [pending, pending], true)).toBe(true);
    expect(termsPayoutsQueryEnabled(1, [pending, pending], true)).toBe(false);
    expect(termsPayoutsQueryEnabled(1, [error, pending], true)).toBe(true);
    expect(termsPayoutsQueryEnabled(1, [success([]), pending], true)).toBe(true);
    expect(termsPayoutsQueryEnabled(0, [pending], false)).toBe(false);
  });
});

describe('«Выплачено» «Условий оплаты»: слияние', () => {
  const rows = [row(28, { payouts: ONE_C }), row(52, { payouts: ONE_C }), row(99, { payouts: ONE_C })];

  it('успешный ответ заменяет суммы 1С списка; месяц без суммы — нет в ответе; id вне ответа — как был', () => {
    const merged = mergeTermsPayouts(rows, [{ ids: [28, 52, 99], date: '2026-11-09' }], [success([
      { employee_id: 28, payouts: [...ONE_C, { month: '2026-10', amount: '206594.00' }] },
      { employee_id: 52, payouts: [] },
    ])]);
    expect(merged.rows.map(item => [item.employee_id, item.payouts, item.payouts_status])).toEqual([
      [28, [...ONE_C, { month: '2026-10', amount: '206594.00' }], undefined],
      [52, [], undefined],
      [99, ONE_C, undefined],
    ]);
  });

  it('пока считается и при ошибке суммы 1С остаются, у строки — статус', () => {
    const requests = [{ ids: [28], date: '2026-11-09' }, { ids: [52], date: '2026-11-09' }];
    const merged = mergeTermsPayouts(rows.slice(0, 2), requests, [{ status: 'pending' }, { status: 'error' }]);
    expect(merged.rows).toEqual([
      row(28, { payouts: ONE_C, payouts_status: 'pending' }),
      row(52, { payouts: ONE_C, payouts_status: 'error' }),
    ]);
    // Состояния ещё нет (порция не запущена) — тоже «считается».
    expect(mergeTermsPayouts(rows.slice(0, 1), requests.slice(0, 1), []).rows[0].payouts_status).toBe('pending');
  });

  it('ячейка, пока считается: месяц без суммы помечен «…», с суммой — как есть', () => {
    const months = ['2026-08', '2026-09'];
    expect(accrualsByMonthParts(months, ONE_C, true)).toEqual([
      { month: '2026-08', name: 'авг', amount: formatPayrollMoney(184482.78) },
      { month: '2026-09', name: 'сен', amount: null, pending: true },
    ]);
    expect(accrualsByMonthParts(months, ONE_C)?.[1]).toEqual({ month: '2026-09', name: 'сен', amount: null });
  });
});
