import { describe, expect, it } from 'vitest';

import {
  keepPayrollTableColumns,
  parseHiddenPayrollColumns,
  PAYROLL_CALC_TABLE_COLUMNS,
  PAYROLL_TERMS_TABLE_COLUMNS,
  serializeHiddenPayrollColumns,
} from './payrollColumns';

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

describe('столбцы «Расчётов»', () => {
  it('вместо оклада, премии, проживания и «Начислений» — «К выплате» и «Удержания»', () => {
    expect(PAYROLL_CALC_TABLE_COLUMNS.map(column => column.label)).toEqual([
      'Подразделение', 'Должность', 'График работы', 'К выплате', 'Удержания',
    ]);
    expect(PAYROLL_TERMS_TABLE_COLUMNS.map(column => column.key)).toEqual([
      'department', 'position', 'schedule', 'salary', 'bonus', 'housing', 'accruals',
    ]);
  });

  it('скрытые в ключе «Расчётов» оклад, премия, проживание и «Начисления» не считаются', () => {
    const stored = parseHiddenPayrollColumns('["salary","bonus","housing","accruals","position","deductions"]');
    expect([...keepPayrollTableColumns(stored, PAYROLL_CALC_TABLE_COLUMNS)]).toEqual(['position', 'deductions']);
    expect(keepPayrollTableColumns(parseHiddenPayrollColumns('["salary","accruals"]'), PAYROLL_CALC_TABLE_COLUMNS).size).toBe(0);
  });

  it('сохраняются в порядке таблицы', () => {
    expect(serializeHiddenPayrollColumns(new Set(['deductions', 'payout', 'schedule'] as const)))
      .toBe('["schedule","payout","deductions"]');
  });
});
