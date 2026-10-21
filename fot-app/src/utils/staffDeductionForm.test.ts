import { describe, expect, it } from 'vitest';

import { amountAfterKindChange, parseStaffDeduction } from './staffDeductionForm';

const draft = { selected: true, kindId: 3, month: '2026-10', amount: '5 000,5' };

describe('parseStaffDeduction', () => {
  it('сумма с пробелами и запятой → число, месяц и вид как есть', () => {
    expect(parseStaffDeduction(draft)).toEqual({ ok: true, payload: { kind_id: 3, month: '2026-10', amount: 5000.5 } });
  });

  it('ошибка — по первому неверному полю', () => {
    expect(parseStaffDeduction({ ...draft, selected: false })).toMatchObject({ ok: false, field: 'employee' });
    expect(parseStaffDeduction({ ...draft, kindId: null })).toMatchObject({ ok: false, field: 'kind' });
    expect(parseStaffDeduction({ ...draft, month: '' })).toMatchObject({ ok: false, field: 'month' });
    expect(parseStaffDeduction({ ...draft, month: '2026-13' })).toMatchObject({ ok: false, field: 'month' });
    for (const amount of ['', '0', '-5', '10,555', 'abc']) {
      expect(parseStaffDeduction({ ...draft, amount }), amount).toMatchObject({ ok: false, field: 'amount' });
    }
  });
});

describe('amountAfterKindChange', () => {
  it('пусто или сумма прежнего вида — подставляется сумма нового', () => {
    expect(amountAfterKindChange('', null, '5000.00')).toBe('5000');
    expect(amountAfterKindChange('5000', '5000.00', '1500.50')).toBe('1500,5');
    expect(amountAfterKindChange('1500,5', '1500.50', null)).toBe('');
  });

  it('введённую руками сумму смена вида не трогает', () => {
    expect(amountAfterKindChange('700', '5000.00', '1500.50')).toBe('700');
    expect(amountAfterKindChange('700', null, '1500.50')).toBe('700');
  });
});
