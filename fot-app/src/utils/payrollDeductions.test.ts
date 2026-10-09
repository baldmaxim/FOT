import { describe, expect, it } from 'vitest';

import { formatDeductionKinds, sameDeductionKinds, toggleDeductionKind } from './payrollDeductions';

const KINDS = [
  { id: 3, name: 'Корректировка удержаний' },
  { id: 1, name: 'ТМЦ' },
  { id: 7, name: 'Питание' },
];

describe('виды удержаний сотрудника', () => {
  it('отметка — в порядке справочника, а не кликов; повтор не задваивает', () => {
    expect(toggleDeductionKind([7], 3, true, KINDS)).toEqual([3, 7]);
    expect(toggleDeductionKind([3, 7], 1, true, KINDS)).toEqual([3, 1, 7]);
    expect(toggleDeductionKind([3, 7], 7, true, KINDS)).toEqual([3, 7]);
    expect(toggleDeductionKind([3, 1, 7], 1, false, KINDS)).toEqual([3, 7]);
  });

  it('вид, которого ещё нет в загруженном справочнике (только что добавлен), — в конец', () => {
    expect(toggleDeductionKind([7], 42, true, KINDS)).toEqual([7, 42]);
  });

  it('сравнение наборов без учёта порядка', () => {
    expect(sameDeductionKinds([3, 7], [7, 3])).toBe(true);
    expect(sameDeductionKinds([3], [3, 7])).toBe(false);
    expect(sameDeductionKinds([], [])).toBe(true);
  });

  it('подпись — названия через запятую; пусто — пустая строка', () => {
    expect(formatDeductionKinds([3, 7], KINDS)).toBe('Корректировка удержаний, Питание');
    expect(formatDeductionKinds([42], KINDS)).toBe('');
    expect(formatDeductionKinds([], KINDS)).toBe('');
  });
});
