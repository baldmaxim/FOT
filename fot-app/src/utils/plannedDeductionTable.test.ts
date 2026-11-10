import { describe, expect, it } from 'vitest';

import type { IPlannedDeductionMonth, IStaffDeduction } from '../services/staffDeductionService';
import {
  buildDeductionMonthRows,
  DEDUCTION_MONTH_COLUMNS,
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

const planned = (id: number, employeeId: number, fullName: string, month: string): IPlannedDeductionMonth => ({
  id, ...person(employeeId, fullName), kind_id: 2, kind_name: 'Займ', subkind_id: null, subkind_name: null,
  amount: '5000.00', month_from: '2026-11', month_to: '2027-01', updated_at: '2026-11-10T09:00:00.000001Z',
  can_edit: true, month,
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
