import { describe, expect, it } from 'vitest';

import type { IPayrollSummaryRow } from '../services/payrollSummaryService';
import { buildSummaryTreeSnapshot, summaryTreeLeaves, summaryTreePeriodText } from './payrollSummaryExport';

const row = (over: Partial<IPayrollSummaryRow>): IPayrollSummaryRow => ({
  employee_id: 1,
  full_name: 'Тудаков Игорь Дмитриевич',
  department_id: 'line',
  department: 'ЛИНИЯ',
  position: 'технический руководитель',
  category: 'itr',
  object_key: 'mark',
  object_name: 'ЖК Марк (лот 33)',
  amounts: { contract: '303333.00' },
  issues: [],
  paid_out: '40375.00',
  ...over,
});

const ROWS: IPayrollSummaryRow[] = [
  row({ employee_id: 2, full_name: 'Кривов', amounts: { contract: '400000.00', meals: '45000.00', other_deductions: '0.10' }, paid_out: '99875.00' }),
  row({ employee_id: 3, full_name: 'Иванов', object_key: 'khimki', object_name: 'База Химки', paid_out: null, issues: ['no_terms', 'sick_pay'] }),
  row({ employee_id: 4, full_name: 'Петров', object_key: 'hidden', object_name: 'Скрытый поиском' }),
  row({ employee_id: 1 }),
];

describe('summaryTreeLeaves', () => {
  it('только видимые объекты, в порядке экрана; начислено и удержано — как в столбцах «Свода»', () => {
    const leaves = summaryTreeLeaves(ROWS, ['khimki', 'mark']);

    expect(leaves.map(leaf => [leaf.object_key, leaf.employee_id])).toEqual([['khimki', 3], ['mark', 2], ['mark', 1]]);
    expect(leaves[1]).toEqual({
      object_key: 'mark',
      object_name: 'ЖК Марк (лот 33)',
      category: 'itr',
      department: 'ЛИНИЯ',
      employee_id: 2,
      full_name: 'Кривов',
      accrued: '400000.00',
      deducted: '45000.10',
      paid_out: '99875.00',
      not_counted: null,
    });
    expect(leaves[0]).toMatchObject({ deducted: null, paid_out: null, not_counted: 'нет условий оплаты, больничные' });
  });

  it('старый бэкенд без paid_out — поля нет (сервер оставит «Выплачено» пустым, а не нулём)', () => {
    const old: IPayrollSummaryRow = row({});
    delete old.paid_out;
    const [leaf] = summaryTreeLeaves([old], ['mark']);
    expect('paid_out' in leaf).toBe(false);
  });

  it('отрицательная сумма — со знаком и копейками', () => {
    const [leaf] = summaryTreeLeaves([row({ amounts: { contract: '-1.50' } })], ['mark']);
    expect(leaf.accrued).toBe('-1.50');
  });
});

describe('summaryTreePeriodText', () => {
  it('подряд — диапазон дат, как в 1С', () => {
    expect(summaryTreePeriodText(['2026-10'])).toBe('за период с 01.10.2026 по 31.10.2026');
    expect(summaryTreePeriodText(['2026-09', '2026-07', '2026-08'])).toBe('за период с 01.07.2026 по 30.09.2026');
    expect(summaryTreePeriodText(['2026-12', '2027-01', '2027-02'])).toBe('за период с 01.12.2026 по 28.02.2027');
  });

  it('вразброс — месяцы перечислением, а не диапазон', () => {
    expect(summaryTreePeriodText(['2026-07', '2026-09'])).toBe('за июль 2026, сентябрь 2026');
  });
});

describe('buildSummaryTreeSnapshot', () => {
  it('«Все» — разбивка «Выплачено», в заголовке отдел и период', () => {
    const snapshot = buildSummaryTreeSnapshot({
      rows: ROWS, objectKeys: ['mark'], months: ['2026-10'], categoryLabel: 'Все', allCategories: true,
    });
    expect(snapshot.split_paid).toBe(true);
    expect(snapshot.title).toBe('Сводная ведомость по объектам (все отделы) за период с 01.10.2026 по 31.10.2026');
    expect(snapshot.file_name).toMatch(/^Свод_Все_\d{4}-\d{2}-\d{2}\.xlsx$/);
    expect(snapshot.leaves).toHaveLength(2);
  });

  it('вкладка и отдел — без разбивки, в заголовке оба', () => {
    const snapshot = buildSummaryTreeSnapshot({
      rows: ROWS, objectKeys: ['mark'], months: ['2026-10'], departmentLabel: 'ЛИНИЯ', categoryLabel: 'ИТР', allCategories: false,
    });
    expect(snapshot.split_paid).toBe(false);
    expect(snapshot.title).toBe('Сводная ведомость по объектам (ЛИНИЯ, ИТР) за период с 01.10.2026 по 31.10.2026');
    expect(snapshot.file_name).toMatch(/^Свод_ЛИНИЯ_ИТР_/);
  });
});
