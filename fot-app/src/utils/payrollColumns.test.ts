import { describe, expect, it } from 'vitest';

import { parseHiddenPayrollColumns, serializeHiddenPayrollColumns } from './payrollColumns';

describe('скрытые столбцы таблицы условий оплаты', () => {
  it('пусто или нет значения — все столбцы видны', () => {
    expect(parseHiddenPayrollColumns(null).size).toBe(0);
    expect(parseHiddenPayrollColumns('').size).toBe(0);
  });

  it('битое значение и не массив — все столбцы видны', () => {
    expect(parseHiddenPayrollColumns('{not json').size).toBe(0);
    expect(parseHiddenPayrollColumns('{"department":true}').size).toBe(0);
  });

  it('неизвестные ключи отбрасываются, «Сотрудник» скрыть нельзя', () => {
    expect([...parseHiddenPayrollColumns('["bonus","name","nope",1,"accruals"]')]).toEqual(['bonus', 'accruals']);
  });

  it('сохраняется в порядке таблицы, пустой выбор — удаление ключа', () => {
    expect(serializeHiddenPayrollColumns(new Set(['accruals', 'department']))).toBe('["department","accruals"]');
    expect(serializeHiddenPayrollColumns(new Set())).toBeNull();
  });

  it('туда и обратно без потерь', () => {
    const hidden = new Set(['position', 'housing'] as const);
    expect([...parseHiddenPayrollColumns(serializeHiddenPayrollColumns(hidden))]).toEqual(['position', 'housing']);
  });
});
