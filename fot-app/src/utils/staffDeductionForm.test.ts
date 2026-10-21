import { describe, expect, it } from 'vitest';

import type { IStaffDeductionKind } from '../services/staffDeductionService';
import { amountAfterKindChange, deductionDefaultAmount, parseStaffDeduction } from './staffDeductionForm';

const draft = { selected: true, kindId: 3, subkindId: null, month: '2026-10', amount: '5 000,5' };

describe('parseStaffDeduction', () => {
  it('сумма с пробелами и запятой → число, месяц и вид как есть; без подвида — null', () => {
    expect(parseStaffDeduction(draft)).toEqual({
      ok: true,
      payload: { kind_id: 3, subkind_id: null, month: '2026-10', amount: 5000.5 },
    });
  });

  it('подвид уходит в запрос', () => {
    expect(parseStaffDeduction({ ...draft, subkindId: 9 })).toMatchObject({ ok: true, payload: { kind_id: 3, subkind_id: 9 } });
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

describe('сумма по умолчанию: подвид ?? вид', () => {
  const KINDS: IStaffDeductionKind[] = [
    {
      id: 4,
      name: 'Спецодежда',
      default_amount: '500.00',
      subkinds: [
        { id: 9, kind_id: 4, name: 'Каска', default_amount: '800.00' },
        { id: 10, kind_id: 4, name: 'Перчатки', default_amount: null },
      ],
    },
    { id: 6, name: 'Штрафы', default_amount: null, subkinds: [] },
  ];

  it('у подвида своя — она; у подвида нет — сумма вида; вида нет — null', () => {
    expect(deductionDefaultAmount(KINDS, 4, null)).toBe('500.00');
    expect(deductionDefaultAmount(KINDS, 4, 9)).toBe('800.00');
    expect(deductionDefaultAmount(KINDS, 4, 10)).toBe('500.00');
    expect(deductionDefaultAmount(KINDS, 6, null)).toBeNull();
    expect(deductionDefaultAmount(KINDS, null, null)).toBeNull();
  });

  it('вид 500 → подвид 800 → «Без подвида» снова 500; ручные 700 смена не затирает', () => {
    const step = (current: string, from: [number | null, number | null], to: [number | null, number | null]) =>
      amountAfterKindChange(current, deductionDefaultAmount(KINDS, ...from), deductionDefaultAmount(KINDS, ...to));
    const kind = step('', [null, null], [4, null]);
    expect(kind).toBe('500');
    const helmet = step(kind, [4, null], [4, 9]);
    expect(helmet).toBe('800');
    expect(step(helmet, [4, 9], [4, null])).toBe('500');

    expect(step('700', [4, null], [4, 9])).toBe('700');
    expect(step('700', [4, 9], [4, null])).toBe('700');
    expect(step('700', [4, 9], [6, null])).toBe('700');
  });
});
