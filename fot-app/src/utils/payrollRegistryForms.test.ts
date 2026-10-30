import { describe, expect, it } from 'vitest';

import {
  parseOneTimeForm,
  reasonAfterDelete,
  reasonAfterRename,
  sortSupplementReasons,
  supplementReasonOptions,
} from './payrollRegistryForms';

describe('основание разовой доплаты: выпадающий список', () => {
  it('основания — по алфавиту, ё рядом с е', () => {
    const sorted = sortSupplementReasons([{ id: 1, name: 'Резерв' }, { id: 2, name: 'Ёлка' }, { id: 3, name: 'Доплата' }]);
    expect(sorted.map(reason => reason.name)).toEqual(['Доплата', 'Ёлка', 'Резерв']);
  });

  it('основание доплаты не из списка — первой строкой; из списка или пустое — список как есть', () => {
    const names = ['Доплата', 'Премия'];
    expect(supplementReasonOptions(names, 'ПРЕМИЯ')).toEqual(['ПРЕМИЯ', 'Доплата', 'Премия']);
    expect(supplementReasonOptions(names, 'Премия')).toEqual(names);
    expect(supplementReasonOptions(names, '')).toEqual(names);
  });

  it('переименовали выбранное (регистр и пробелы не в счёт) — в форме новое; другое — без изменений', () => {
    expect(reasonAfterRename('Премия', 'Премия', 'Премия квартальная')).toBe('Премия квартальная');
    expect(reasonAfterRename('  ПРЕМИЯ ', 'Премия', 'Премия квартальная')).toBe('Премия квартальная');
    expect(reasonAfterRename('Резерв', 'Премия', 'Премия квартальная')).toBe('Резерв');
    expect(reasonAfterRename('', 'Премия', 'Премия квартальная')).toBe('');
  });

  it('удалили выбранное: новая доплата — выбор сброшен; ✎ — своё основание остаётся, выбранное после смены — сброшено', () => {
    expect(reasonAfterDelete('Премия', 'Премия', null)).toBe('');
    expect(reasonAfterDelete('Премия', 'Премия', 'Премия')).toBe('Премия');
    expect(reasonAfterDelete('Резерв', 'Резерв', 'Премия')).toBe('');
    expect(reasonAfterDelete('Резерв', 'Премия', null)).toBe('Резерв');
  });

  it('основание не выбрано — «Выберите основание»', () => {
    expect(parseOneTimeForm({ selected: true, month: '2026-10', amount: '1000', reason: '' })).toEqual({
      ok: false, field: 'reason', message: 'Выберите основание',
    });
  });
});
