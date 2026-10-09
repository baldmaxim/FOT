import { describe, expect, it } from 'vitest';

import {
  deductionMonthOptions,
  firstInvalidDeductionField,
  isDeductionEntriesChanged,
  toDeductionDrafts,
  validateDeductionEntries,
  type IDeductionEntryDraft,
} from './payrollDeductionEntries';

const draft = (over: Partial<IDeductionEntryDraft> = {}): IDeductionEntryDraft => ({
  key: 'k1', month: '2026-09', kindId: 5, amount: '3000', ...over,
});

describe('toDeductionDrafts', () => {
  it('хвост нулей NUMERIC убирается, ключ — месяц и вид', () => {
    expect(toDeductionDrafts([{ month: '2026-09', kind_id: 5, amount: '3000.50' }])).toEqual([
      { key: 'saved-2026-09-5', month: '2026-09', kindId: 5, amount: '3000.5' },
    ]);
  });
});

describe('validateDeductionEntries', () => {
  it('запрос: месяц, вид, сумма числом; запятая как разделитель; пустая новая строка пропускается', () => {
    const result = validateDeductionEntries([
      draft(),
      draft({ key: 'k2', kindId: 2, amount: '100,5' }),
      draft({ key: 'k3', kindId: null, amount: ' ' }),
    ]);
    expect(result).toEqual({
      errors: null,
      payload: [
        { month: '2026-09', kind_id: 5, amount: 3000 },
        { month: '2026-09', kind_id: 2, amount: 100.5 },
      ],
    });
  });

  it('пустой список — пустой запрос (удалить всё)', () => {
    expect(validateDeductionEntries([])).toEqual({ errors: null, payload: [] });
  });

  it('ошибки по строкам: без вида, без суммы, ноль, три знака, повтор вида за месяц', () => {
    const drafts = [
      draft({ key: 'a', kindId: null, amount: '10' }),
      draft({ key: 'b', amount: '' }),
      draft({ key: 'c', kindId: 2, amount: '0' }),
      draft({ key: 'd', kindId: 3, amount: '1.005' }),
      draft({ key: 'e', amount: '5' }),
      draft({ key: 'f', month: '2026-08', amount: '5' }),
    ];
    const result = validateDeductionEntries(drafts);
    expect(result.payload).toBeNull();
    expect(result.errors).toEqual({
      a: { kind: 'Выберите вид' },
      b: { amount: 'Укажите сумму' },
      c: { amount: 'Введите число больше нуля' },
      d: { amount: 'Не больше двух знаков после запятой' },
      e: { kind: 'Этот вид за месяц уже есть' },
    });
    expect(firstInvalidDeductionField(drafts, result.errors ?? {})).toEqual({ key: 'a', field: 'kind' });
  });
});

describe('isDeductionEntriesChanged', () => {
  const initial = [draft(), draft({ key: 'k2', kindId: 2, amount: '100' })];

  it('порядок строк и добавленная пустая строка — не изменение', () => {
    expect(isDeductionEntriesChanged([initial[1], initial[0], draft({ key: 'n', kindId: null, amount: '' })], initial))
      .toBe(false);
  });

  it('сумма, вид, месяц, удалённая или новая строка — изменение', () => {
    expect(isDeductionEntriesChanged([draft({ amount: '3500' }), initial[1]], initial)).toBe(true);
    expect(isDeductionEntriesChanged([draft({ kindId: 4 }), initial[1]], initial)).toBe(true);
    expect(isDeductionEntriesChanged([draft({ month: '2026-08' }), initial[1]], initial)).toBe(true);
    expect(isDeductionEntriesChanged([initial[0]], initial)).toBe(true);
    expect(isDeductionEntriesChanged([...initial, draft({ key: 'n', kindId: 3, amount: '' })], initial)).toBe(true);
  });
});

describe('deductionMonthOptions', () => {
  it('окно и месяцы строк вне окна, от новых к старым, без повторов', () => {
    expect(deductionMonthOptions(['2026-10', '2026-09'], [draft({ month: '2025-01' }), draft()]))
      .toEqual(['2026-10', '2026-09', '2025-01']);
  });
});
