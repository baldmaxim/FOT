import { describe, expect, it } from 'vitest';

import type { IPlannedDeductionMonth, IStaffDeduction } from '../services/staffDeductionService';
import { formatPayrollMoney } from './payrollFormat';
import {
  buildDeductionMonthRows,
  DEDUCTION_MONTH_COLUMNS,
  PLANNED_DEDUCTION_COLUMNS,
  plannedDeductionPeriodLabel,
  plannedDeductionRemoval,
  plannedDeductionRemovalQuestion,
} from './plannedDeductionTable';

const person = (employeeId: number, fullName: string) => ({
  employee_id: employeeId, full_name: fullName, department: 'ЛИНИЯ', position: null,
});

const staff = (id: number, employeeId: number, fullName: string, month: string, amount = '300.00'): IStaffDeduction => ({
  id, ...person(employeeId, fullName), kind_id: 1, kind_name: 'Питание', subkind_id: null, subkind_name: null, month, amount,
});

const planned = (
  id: number, employeeId: number, fullName: string, month: string, monthAmount = '5000.00',
): IPlannedDeductionMonth => ({
  id, ...person(employeeId, fullName), kind_id: 2, kind_name: 'Займ', subkind_id: null, subkind_name: null,
  amount: '5000.00', month_from: '2026-11', month_to: '2027-01', last_month_amount: monthAmount === '5000.00' ? null : monthAmount,
  updated_at: '2026-11-10T09:00:00.000001Z', can_edit: true, month, month_amount: monthAmount,
});

describe('«Удержания за месяц»: помесячные и плановые', () => {
  it('совпадающие id двух таблиц и одно плановое в двух месяцах — разные ключи; плановые первыми в месяце', () => {
    const rows = buildDeductionMonthRows(
      [staff(5, 7, 'Каримов Акмал', '2026-11'), staff(6, 3, 'Борисов Антон', '2026-12')],
      [planned(5, 7, 'Каримов Акмал', '2026-11'), planned(5, 7, 'Каримов Акмал', '2026-12')],
      () => false,
    )!;
    expect(rows.map(row => [row.key, row.source, row.month, row.can_edit])).toEqual([
      ['staff:6', 'staff', '2026-12', false],
      ['planned:5:2026-11', 'planned', '2026-11', true],
      ['staff:5', 'staff', '2026-11', false],
      ['planned:5:2026-12', 'planned', '2026-12', true],
    ]);
    expect(new Set(rows.map(row => row.key)).size).toBe(rows.length);
    expect(rows[1].planned?.id).toBe(5);
    expect(rows[2].staff?.id).toBe(5);
  });

  it('сумма планового — этого месяца (последний — своя), ✎ получает сумму периода', () => {
    const rows = buildDeductionMonthRows(
      [],
      [planned(5, 7, 'Каримов Акмал', '2026-12'), planned(5, 7, 'Каримов Акмал', '2027-01', '1500.00')],
      () => true,
    )!;
    expect(rows.map(row => [row.month, row.amount, row.planned?.amount])).toEqual([
      ['2026-12', '5000.00', '5000.00'],
      ['2027-01', '1500.00', '5000.00'],
    ]);
    const amount = DEDUCTION_MONTH_COLUMNS.find(column => column.key === 'amount')!;
    expect(rows.map(row => amount.text(row))).toEqual([formatPayrollMoney('5000.00'), formatPayrollMoney('1500.00')]);
  });

  it('пока не загружено одно из двух — undefined (таблица в загрузке)', () => {
    expect(buildDeductionMonthRows(undefined, [], () => true)).toBeUndefined();
    expect(buildDeductionMonthRows([], undefined, () => true)).toBeUndefined();
  });

  it('столбец «Тип» — сразу после «Вида удержания», в xlsx тоже', () => {
    expect(DEDUCTION_MONTH_COLUMNS.map(column => column.key))
      .toEqual(['full_name', 'department', 'position', 'kind_name', 'source', 'month', 'amount']);
    const [row] = buildDeductionMonthRows([], [planned(1, 7, 'Каримов Акмал', '2026-11')], () => true)!;
    expect(DEDUCTION_MONTH_COLUMNS.find(column => column.key === 'source')!.text(row)).toBe('Плановое');
  });
});

describe('«Плановые удержания»', () => {
  it('«Последний месяц, ₽» — после суммы: сумма или «—», сортировка числом, в xlsx — строкой numeric', () => {
    expect(PLANNED_DEDUCTION_COLUMNS.map(column => column.key)).toEqual(
      ['full_name', 'department', 'position', 'kind_name', 'amount', 'last_month_amount', 'period'],
    );
    const column = PLANNED_DEDUCTION_COLUMNS.find(item => item.key === 'last_month_amount')!;
    const withLast = planned(1, 7, 'Каримов Акмал', '2027-01', '1500.00');
    const without = planned(2, 7, 'Каримов Акмал', '2026-11');
    expect([column.text(withLast), column.text(without)]).toEqual([formatPayrollMoney('1500.00'), '—']);
    expect([column.sortValue(withLast), column.sortValue(without)]).toEqual([1500, null]);
    expect([column.exportValue!(withLast), column.exportValue!(without)]).toEqual(['1500.00', null]);
  });

  it('ширины столбцов в сумме прежние (796 px) — ✎ и 🗑 не уходят за край на 1280', () => {
    expect(PLANNED_DEDUCTION_COLUMNS.reduce((sum, column) => sum + (column.width ?? 0), 0)).toBe(796);
  });
});

describe('период и «Убрать»', () => {
  it('период: «11.2026 – 01.2027», бессрочно — «с 11.2026»', () => {
    expect(plannedDeductionPeriodLabel({ month_from: '2026-11', month_to: '2027-01' })).toBe('11.2026 – 01.2027');
    expect(plannedDeductionPeriodLabel({ month_from: '2026-11', month_to: null })).toBe('с 11.2026');
  });

  it('начало в текущем месяце или позже и кончившееся — удалить, идущее — закрыть (как на сервере)', () => {
    expect(plannedDeductionRemoval({ month_from: '2026-11', month_to: null }, '2026-11')).toBe('remove');
    expect(plannedDeductionRemoval({ month_from: '2026-12', month_to: '2027-01' }, '2026-11')).toBe('remove');
    expect(plannedDeductionRemoval({ month_from: '2026-08', month_to: '2026-10' }, '2026-11')).toBe('remove');
    expect(plannedDeductionRemoval({ month_from: '2026-09', month_to: null }, '2026-11')).toBe('close');
    expect(plannedDeductionRemoval({ month_from: '2026-09', month_to: '2026-11' }, '2026-11')).toBe('close');
  });

  it('вопрос перед «Убрать» говорит, с какого месяца и что прошлые остаются', () => {
    const row = { ...planned(1, 7, 'Каримов Акмал', '2026-11'), month_from: '2026-09', month_to: null };
    expect(plannedDeductionRemovalQuestion(row, '2026-11-10'))
      .toBe('Убрать плановое удержание с 11.2026: Каримов Акмал, Займ, с 09.2026? По 10.2026 удержание останется.');
    expect(plannedDeductionRemovalQuestion({ ...row, month_from: '2026-11' }, '2026-11-10'))
      .toBe('Удалить плановое удержание: Каримов Акмал, Займ, с 11.2026?');
  });
});
