import { describe, expect, it } from 'vitest';

import type { IPayrollSummaryRow } from '../services/payrollSummaryService';
import { PAYROLL_PAID_GROUPS } from './payrollPaid';
import {
  buildSummarySnapshot,
  filterSummaryByCategory,
  groupSummaryByObject,
  summaryEmployeeColumns,
  summaryEmployeeTotals,
  summaryItems,
  summaryObjectColumns,
  summaryObjectTotals,
  summaryPeriodLabel,
  toSummaryEmployeeRows,
} from './payrollSummary';
import { applyTableView, matchesNameSearch } from './tableView';

const row = (over: Partial<IPayrollSummaryRow>): IPayrollSummaryRow => ({
  employee_id: 1,
  full_name: 'Акимов Прораб',
  department: 'ЛИНИЯ',
  position: 'Прораб',
  category: 'itr',
  object_key: 'khimki',
  object_name: 'ЖК Химки',
  amounts: { contract: '100000.00' },
  ...over,
});

const ROWS: IPayrollSummaryRow[] = [
  row({ amounts: { contract: '100000.00', travel: '3000.50', meals: '1200.00' } }),
  row({ employee_id: 6, full_name: 'Егоров Рабочий', category: 'worker', amounts: { contract: '45000.00', bonus: '0.00' } }),
  row({ employee_id: 3, full_name: 'Васильев', object_key: 'mytishchi', object_name: 'ЖК Мытищи', amounts: { contract: '50000.00', recalc_prev: '-2500.25' } }),
  // Тот же Акимов в другом месяце — на «Офисе».
  row({ object_key: 'office', object_name: 'Офис', amounts: { contract: '100000.00' } }),
];

describe('«Свод»: объекты', () => {
  it('категория фильтрует строки; «Все» — все', () => {
    expect(filterSummaryByCategory(ROWS, 'all')).toHaveLength(4);
    expect(filterSummaryByCategory(ROWS, 'worker').map(r => r.employee_id)).toEqual([6]);
  });

  it('объект: суммы сотрудников сложены в копейках, «Чел.» — уникальные', () => {
    const objects = groupSummaryByObject(ROWS);
    const khimki = objects.find(object => object.object_key === 'khimki');
    expect(khimki?.employee_ids.sort()).toEqual([1, 6]);
    expect(khimki?.cents).toEqual({ contract: 14500000, travel: 300050, meals: 120000, bonus: 0 });
  });

  it('статьи-столбцы: только ненулевые, в порядке «Оплачено»; сторно (0) — нет', () => {
    expect(summaryItems(ROWS)).toEqual(['contract', 'travel', 'recalc_prev', 'meals']);
    expect(summaryObjectColumns(summaryItems(ROWS)).map(column => column.label)).toEqual([
      'Объект', 'Чел.', 'К выплате', 'Всего начислено', 'Всего удержано',
      'Зарплата', 'Проезд', 'Перерасчёт за предыдущий период', 'Питание',
    ]);
  });

  it('ячейки: нет суммы — «—», отрицательная — со знаком; «Начислено» и «Удержано» раздельно', () => {
    const items = summaryItems(ROWS);
    const columns = summaryObjectColumns(items);
    const text = (key: string, objectKey: string) => {
      const object = groupSummaryByObject(ROWS).find(o => o.object_key === objectKey)!;
      return columns.find(column => column.key === key)!.text(object);
    };
    expect(text('travel', 'mytishchi')).toBe('—');
    expect(text('recalc_prev', 'mytishchi')).toMatch(/^[-−]2\s500,25$/);
    expect(text('accrued', 'mytishchi')).toMatch(/^47\s499,75$/);
    expect(text('deducted', 'mytishchi')).toBe('—');
    expect(text('deducted', 'khimki')).toMatch(/^1\s200,00$/);
  });

  it('«К выплате» — «Всего начислено» минус «Всего удержано»; удержаний нет — равно начисленному', () => {
    const items = summaryItems(ROWS);
    const columns = summaryObjectColumns(items);
    const payout = columns.find(column => column.key === 'payout')!;
    const objects = groupSummaryByObject(ROWS);
    const byKey = (key: string) => objects.find(object => object.object_key === key)!;
    expect(payout.text(byKey('khimki'))).toMatch(/^146\s800,50$/);
    expect(payout.exportValue?.(byKey('khimki'))).toBe(146800.5);
    expect(payout.text(byKey('mytishchi'))).toMatch(/^47\s499,75$/);
    expect(payout.text({ object_key: 'x', object_name: 'X', employee_ids: [], cents: {} })).toBe('—');
    expect(summaryObjectTotals(items)(objects)?.export.payout).toBe(294300.25);
  });

  it('итог — по видимым строкам (после поиска и фильтра столбца); человек на двух объектах — один', () => {
    const items = summaryItems(ROWS);
    const objects = groupSummaryByObject(ROWS);
    const totals = summaryObjectTotals(items);
    const all = totals(objects);
    expect(all?.display.object_name).toBe('Итого');
    expect(all?.export.employees).toBe(3);
    expect(all?.export.contract).toBe(295000);

    const searched = objects.filter(object => matchesNameSearch(object.object_name, 'жк'));
    const filtered = applyTableView(searched, summaryObjectColumns(items), { sort: '', dir: 'asc', filters: { object_name: ['ЖК Химки'] } });
    expect(totals(filtered)?.export.contract).toBe(145000);
    expect(totals([])).toBeNull();
  });
});

describe('«Свод»: сотрудники объекта и xlsx', () => {
  it('«Категория» — только при «Все»; итог по сотрудникам', () => {
    const items = summaryItems(ROWS);
    expect(summaryEmployeeColumns(items, true).map(column => column.key)).toContain('category');
    expect(summaryEmployeeColumns(items, false).map(column => column.key)).not.toContain('category');
    const employees = toSummaryEmployeeRows(ROWS.filter(r => r.object_key === 'khimki'));
    expect(summaryEmployeeTotals(items)(employees)?.export).toMatchObject({ full_name: 'Итого', contract: 145000, meals: 1200 });
  });

  it('все 39 статей: снимок ≤ 50 столбцов (лимит сервера), итог последней строкой, имя файла без пробелов', () => {
    const all = Object.fromEntries(PAYROLL_PAID_GROUPS.flatMap(group => group.items.map(item => [item.code, '1'])));
    const rows = toSummaryEmployeeRows([row({ amounts: all })]);
    const items = summaryItems([row({ amounts: all })]);
    expect(items).toHaveLength(39);
    const columns = summaryEmployeeColumns(items, true);
    const snapshot = buildSummarySnapshot({ title: 'Свод', subject: 'ЖК Химки', periodLabel: 'июль 2026', categoryLabel: 'Все', columns })(
      rows, summaryEmployeeTotals(items)(rows)?.export,
    );
    expect(snapshot.columns).toHaveLength(47);
    expect(snapshot.columns.length).toBeLessThanOrEqual(50);
    expect(new Set(snapshot.columns.map(column => column.label)).size).toBe(47);
    expect(snapshot.rows).toHaveLength(2);
    expect(snapshot.rows[1].cells[0]).toBeNull();
    expect(snapshot.rows[1].cells[1]).toBe('Итого');
    expect(snapshot.file_name).toMatch(/^Свод_ЖК_Химки_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });

  it('подпись периода: пусто — «весь период»', () => {
    expect(summaryPeriodLabel([])).toBe('весь период');
    expect(summaryPeriodLabel(['2026-07'])).toBe('июль 2026');
  });
});
