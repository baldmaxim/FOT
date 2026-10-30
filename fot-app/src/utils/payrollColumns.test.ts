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

describe('столбцы «Условий оплаты»', () => {
  it('вместо «Начислений» — «Выплачено» за полгода', () => {
    expect(PAYROLL_TERMS_TABLE_COLUMNS.map(column => column.label)).toEqual([
      'Подразделение', 'Должность', 'График работы', 'Оклад', 'Премиальная часть', 'Компенсация проживания',
      'Выплачено за посл. полгода',
    ]);
  });
});

describe('столбцы «Расчётов»', () => {
  it('вместо оклада, премии, проживания и «Выплачено» — суммы 1С, затем состав зарплаты (27.10); переработка, проезд '
    + 'и проживание — под «+» у «Доплат» (30.10)', () => {
    expect(PAYROLL_CALC_TABLE_COLUMNS.map(column => column.label)).toEqual([
      'Подразделение', 'Должность', 'График работы', 'К выплате', 'Начислено', 'Удержания',
      'Оклад', 'Начислено по табелю', 'Отпускные', 'Больничные',
      'Перерасчёт за пред. месяц', 'Доплаты', 'Удержания (ФОТ)', 'Сумма', 'Выплаты на карту',
    ]);
    // Прежняя «скрытость» переработки в шестерёнке отбрасывается: столбца на верхнем уровне больше нет.
    expect(keepPayrollTableColumns(parseHiddenPayrollColumns('["calc_overtime","calc_net"]'), PAYROLL_CALC_TABLE_COLUMNS))
      .toEqual(new Set(['calc_net']));
    expect(PAYROLL_TERMS_TABLE_COLUMNS.map(column => column.key)).toEqual([
      'department', 'position', 'schedule', 'salary', 'bonus', 'housing', 'accruals',
    ]);
  });

  it('скрытые в ключе «Расчётов» оклад, премия, проживание и «Выплачено» не считаются', () => {
    const stored = parseHiddenPayrollColumns('["salary","bonus","housing","accruals","position","deductions"]');
    expect([...keepPayrollTableColumns(stored, PAYROLL_CALC_TABLE_COLUMNS)]).toEqual(['position', 'deductions']);
    expect(keepPayrollTableColumns(parseHiddenPayrollColumns('["salary","accruals"]'), PAYROLL_CALC_TABLE_COLUMNS).size).toBe(0);
  });

  it('«Отпускные» и «Больничные» — столбцы расчёта ФОТ (30.10): прежние сохранённые ключи 1С отбрасываются', () => {
    expect(PAYROLL_CALC_TABLE_COLUMNS.filter(column => ['Отпускные', 'Больничные'].includes(column.label)).map(column => column.key))
      .toEqual(['calc_vacation', 'calc_sick']);
    const stored = parseHiddenPayrollColumns('["paid_vacation","paid_sick","calc_sick"]');
    expect([...keepPayrollTableColumns(stored, PAYROLL_CALC_TABLE_COLUMNS)]).toEqual(['calc_sick']);
  });

  it('сохраняются в порядке таблицы', () => {
    expect(serializeHiddenPayrollColumns(new Set(['deductions', 'accrued', 'payout', 'schedule'] as const)))
      .toBe('["schedule","payout","accrued","deductions"]');
  });
});
