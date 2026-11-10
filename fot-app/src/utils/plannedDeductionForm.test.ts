import { describe, expect, it } from 'vitest';
import { QueryClient } from '@tanstack/react-query';

import { DEDUCTION_QUERY_KEYS, invalidateDeductionQueries } from './deductionQueries';
import { mergeHistory } from './payrollHistory';
import {
  monthToAfterFromChange,
  parsePlannedDeduction,
  plannedFromMonthOptions,
  plannedToMonthOptions,
  withKeptKind,
} from './staffDeductionForm';
import type { IPayrollTermsChange, IPlannedDeductionChange } from '../services/payrollService';

const draft = {
  selected: true, kindId: 3, subkindId: null, amount: '5 000,5', monthFrom: '2026-11', monthTo: '2027-01',
};

describe('окно планового удержания', () => {
  it('разбор: сумма до копеек, «по» пусто — бессрочно, «по» раньше «с» и без вида — ошибка поля', () => {
    expect(parsePlannedDeduction(draft)).toEqual({
      ok: true,
      payload: { kind_id: 3, subkind_id: null, amount: 5000.5, month_from: '2026-11', month_to: '2027-01' },
    });
    expect(parsePlannedDeduction({ ...draft, monthTo: '' })).toMatchObject({ ok: true, payload: { month_to: null } });
    expect(parsePlannedDeduction({ ...draft, monthTo: '2026-10' })).toMatchObject({ ok: false, field: 'month_to' });
    expect(parsePlannedDeduction({ ...draft, kindId: null })).toMatchObject({ ok: false, field: 'kind' });
    expect(parsePlannedDeduction({ ...draft, selected: false })).toMatchObject({ ok: false, field: 'employee' });
    expect(parsePlannedDeduction({ ...draft, amount: '10,005' })).toMatchObject({ ok: false, field: 'amount' });
  });

  it('«С месяца»: 11 назад … 12 вперёд; месяц правки вне диапазона остаётся', () => {
    const options = plannedFromMonthOptions('2026-11');
    expect([options[0], options.at(-1), options.length]).toEqual(['2025-12', '2027-11', 24]);
    expect(plannedFromMonthOptions('2026-11', '2024-03')[0]).toBe('2024-03');
  });

  it('«По месяц»: от «С» до 5 лет вперёд (дальше 12 месяцев можно); правка дальше — остаётся', () => {
    const options = plannedToMonthOptions('2026-11', '2026-11');
    expect([options[0], options.at(-1)]).toEqual(['2026-11', '2031-11']);
    expect(options).toContain('2029-12');
    expect(plannedToMonthOptions('2026-11', '2026-11', '2035-06').at(-1)).toBe('2035-06');
    // «По» раньше нового «С» в список не попадает.
    expect(plannedToMonthOptions('2027-02', '2026-11', '2026-12')[0]).toBe('2027-02');
  });

  it('«По» после смены «С»: раньше — становится «С», бессрочно — остаётся', () => {
    expect(monthToAfterFromChange('2026-12', '2027-01')).toBe('2027-01');
    expect(monthToAfterFromChange('', '2027-01')).toBe('');
    expect(monthToAfterFromChange('2027-03', '2027-01')).toBe('2027-03');
  });

  it('удалённые из справочника вид и подвид правки остаются в списках', () => {
    const kinds = [{ id: 1, name: 'Питание', default_amount: null, subkinds: [] }];
    expect(withKeptKind(kinds)).toBe(kinds);
    expect(withKeptKind(kinds, { kind_id: 9, kind_name: 'Займ', subkind_id: 4, subkind_name: 'Старый' })).toEqual([
      ...kinds,
      { id: 9, name: 'Займ', default_amount: null, subkinds: [{ id: 4, kind_id: 9, name: 'Старый', default_amount: null }] },
    ]);
  });
});

describe('история карточки и сброс кэша', () => {
  it('условия и плановые удержания — одним журналом, новые сверху; пока не загружено — undefined', () => {
    const terms = [{ kind: 'supplement', id: 1, changed_at: '2026-11-01T10:00:00Z' }] as unknown as IPayrollTermsChange[];
    const deductions = [
      { id: 7, action: 'assigned', changed_at: '2026-11-05T10:00:00.000001Z' },
      { id: 6, action: 'assigned', changed_at: '2026-10-01T10:00:00Z' },
    ] as unknown as IPlannedDeductionChange[];
    expect(mergeHistory(terms, undefined)).toBeUndefined();
    expect(mergeHistory(terms, deductions)!.map(entry => entry.key)).toEqual(['deduction-7', 'terms-supplement-0', 'deduction-6']);
  });

  it('правка удержаний сбрасывает «Свод», «Табель → Зарплата», «Расчёты» и обе вкладки', async () => {
    const client = new QueryClient();
    const keys = [
      ['payroll-summary', 'data', '2026-11'], ['timesheet-salary', 'dep', '2026-11'], ['payroll-terms', 'calc-columns'],
      ['staff-deductions', 'planned', 'periods', '2026-11'], ['payroll-terms', 'registry', 'planned-deductions', 'x'],
    ];
    for (const key of keys) client.setQueryData(key, 1);
    await invalidateDeductionQueries(client);
    for (const key of keys) expect(client.getQueryState(key)?.isInvalidated, key.join('/')).toBe(true);
    expect(DEDUCTION_QUERY_KEYS).toContainEqual(['payroll-summary']);
  });
});
