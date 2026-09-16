import { describe, expect, it } from 'vitest';
import {
  countActivePayrollColumnFilters,
  isPayrollColumnFilterActive,
  normalizePayrollColumnFilters,
  serializePayrollColumnFilters,
  setPayrollColumnFilter,
} from './payrollColumnFilters';
import { formatPayrollFilterValue, formatPayrollMoney } from './payrollFormat';

describe('payrollColumnFilters', () => {
  it('нормализация: пустые убираются, значения без дублей, по алфавиту, «пусто» в конце; ФИО обрезается', () => {
    expect(normalizePayrollColumnFilters({
      values: { position: [null, 'Монтажник', 'Маляр', 'Монтажник'], schedule: [] },
      text: { name: '  ов  ' },
    })).toEqual({
      values: { position: ['Маляр', 'Монтажник', null] },
      text: { name: 'ов' },
    });
    expect(normalizePayrollColumnFilters({ values: { bonus: [] }, text: { name: '   ' } })).toEqual({});
  });

  it('сериализация стабильна: порядок выбора не меняет строку; без фильтров — пустая строка', () => {
    const a = serializePayrollColumnFilters({ values: { salary: ['мес:175000.00', 'час:450.0000'], position: ['Маляр'] } });
    const b = serializePayrollColumnFilters({ values: { position: ['Маляр'], salary: ['час:450.0000', 'мес:175000.00'] } });
    expect(a).toBe(b);
    expect(JSON.parse(a)).toEqual({ values: { position: ['Маляр'], salary: ['мес:175000.00', 'час:450.0000'] } });
    expect(serializePayrollColumnFilters({})).toBe('');
    expect(serializePayrollColumnFilters({ values: { housing: [] } })).toBe('');
  });

  it('установка и снятие фильтра столбца, подсчёт активных', () => {
    let filters = setPayrollColumnFilter({}, 'schedule', ['6+0 (10ч)', null]);
    filters = setPayrollColumnFilter(filters, 'name', 'Абд');
    expect(isPayrollColumnFilterActive(filters, 'schedule')).toBe(true);
    expect(isPayrollColumnFilterActive(filters, 'name')).toBe(true);
    expect(isPayrollColumnFilterActive(filters, 'bonus')).toBe(false);
    expect(countActivePayrollColumnFilters(filters)).toBe(2);

    filters = setPayrollColumnFilter(filters, 'schedule', null);
    filters = setPayrollColumnFilter(filters, 'name', null);
    expect(filters).toEqual({});
    expect(countActivePayrollColumnFilters(filters)).toBe(0);
  });

  it('не больше 200 значений в фильтре столбца (лимит сервера)', () => {
    const many = Array.from({ length: 250 }, (_, i) => `Отдел ${String(i).padStart(3, '0')}`);
    expect(normalizePayrollColumnFilters({ values: { department: many } }).values?.department).toHaveLength(200);
  });
});

describe('payrollFormat', () => {
  it('суммы в формате ячейки', () => {
    expect(formatPayrollMoney('175000.00')).toBe((175000).toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
    expect(formatPayrollMoney(null)).toBeNull();
    expect(formatPayrollMoney('abc')).toBeNull();
  });

  it('варианты фильтра: вид оплаты у оклада, «не задано» для пустых, текст — как есть', () => {
    const money = (n: number) => n.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    expect(formatPayrollFilterValue('salary', 'мес:175000.00')).toBe(`${money(175000)} ₽/мес`);
    expect(formatPayrollFilterValue('salary', 'час:450.0000')).toBe(`${money(450)} ₽/час`);
    expect(formatPayrollFilterValue('bonus', '0.00')).toBe(`${money(0)} ₽/мес`);
    expect(formatPayrollFilterValue('salary', null)).toBe('Оклад не задан');
    expect(formatPayrollFilterValue('schedule', null)).toBe('Без графика');
    expect(formatPayrollFilterValue('position', 'Монтажник')).toBe('Монтажник');
  });
});
