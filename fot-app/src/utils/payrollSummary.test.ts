import { describe, expect, it } from 'vitest';

import type { IPayrollSummaryRow } from '../services/payrollSummaryService';
import { PAYROLL_PAID_GROUPS } from './payrollPaid';
import {
  buildSummarySnapshot,
  filterSummaryByCategory,
  filterSummaryByDepartment,
  groupSummaryByObject,
  SUMMARY_NO_DEPARTMENT,
  summaryCategoryTable,
  summaryDepartmentOptions,
  summaryEmployeeColumns,
  summaryEmployeeTotals,
  summaryHasIssues,
  summaryItems,
  summaryObjectColumns,
  summaryObjectTotals,
  summaryPayoutText,
  summaryPeriodLabel,
  toSummaryEmployeeRows,
} from './payrollSummary';
import { applyTableView, matchesNameSearch } from './tableView';

const row = (over: Partial<IPayrollSummaryRow>): IPayrollSummaryRow => ({
  employee_id: 1,
  full_name: 'Акимов Прораб',
  department_id: 'line',
  department: 'ЛИНИЯ',
  position: 'Прораб',
  category: 'itr',
  object_key: 'khimki',
  object_name: 'ЖК Химки',
  amounts: { contract: '100000.00' },
  issues: [],
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

  it('«Служебная квартира» — удержание (статья «Квартиры» 1С), не начисление «Компенсация проживания»', () => {
    const rows = [row({ amounts: { contract: '100000.00', housing: '18900.00', apartment: '32500.00', other_deductions: '6678.00' } })];
    const items = summaryItems(rows);
    const columns = summaryObjectColumns(items);
    expect(columns.map(column => column.label)).toEqual([
      'Объект', 'Чел.', 'К выплате', 'Всего начислено', 'Всего удержано',
      'Зарплата', 'Компенсация проживания', 'Служебная квартира', 'Прочие удержания',
    ]);
    const object = groupSummaryByObject(rows)[0];
    const text = (key: string) => columns.find(column => column.key === key)!.text(object);
    expect(text('accrued')).toMatch(/^118\s900,00$/);
    expect(text('deducted')).toMatch(/^39\s178,00$/);
    expect(text('payout')).toMatch(/^79\s722,00$/);
    // «Оплачено» (данные 1С) — прежнее название статьи.
    expect(PAYROLL_PAID_GROUPS.flatMap(group => group.items).find(item => item.code === 'apartment')?.label).toBe('Квартиры');
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
    expect(payout.text({ object_key: 'x', object_name: 'X', employee_ids: [], not_counted_ids: [], cents: {} })).toBe('—');
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

  it('итоги вкладок: «К выплате» = строка «Итого» вкладки; поиск и фильтр столбца — те же; нет строк — «—»', () => {
    const view = { sort: '', dir: 'asc' as const, filters: { object_name: ['ЖК Химки'] } };
    const payout = (category: 'all' | 'itr' | 'worker' | 'office') => {
      const { objects, columns } = summaryCategoryTable(ROWS, category);
      return summaryPayoutText(applyTableView(objects, columns, view));
    };
    const itrRows = filterSummaryByCategory(ROWS, 'itr');
    const itrVisible = applyTableView(groupSummaryByObject(itrRows), summaryObjectColumns(summaryItems(itrRows)), view);
    expect(payout('itr')).toBe(summaryObjectTotals(summaryItems(itrRows))(itrVisible)?.display.payout);
    expect(payout('all')).toMatch(/^146\s800,50$/);
    expect(payout('itr')).toMatch(/^101\s800,50$/);
    expect(payout('worker')).toMatch(/^45\s000,00$/);
    expect(payout('office')).toBe('—');
  });
});

describe('«Свод»: отдел', () => {
  const DEPARTMENT_ROWS: IPayrollSummaryRow[] = [
    row({ department_id: 'line', department: 'ЛИНИЯ', amounts: { contract: '100000.00' } }),
    row({ employee_id: 2, department_id: 'accounting', department: 'Бухгалтерия', amounts: { contract: '80000.50' } }),
    row({ employee_id: 3, department_id: 'line', department: 'ЛИНИЯ', object_key: 'mytishchi', object_name: 'ЖК Мытищи', amounts: { contract: '50000.25' } }),
    row({ employee_id: 4, department_id: null, department: null, amounts: { contract: '1000.00' } }),
  ];

  it('список — отделы строк по алфавиту, без повторов; без отдела — свой вариант', () => {
    expect(summaryDepartmentOptions(DEPARTMENT_ROWS)).toEqual([
      { value: SUMMARY_NO_DEPARTMENT, label: 'Без отдела' },
      { value: 'accounting', label: 'Бухгалтерия' },
      { value: 'line', label: 'ЛИНИЯ' },
    ]);
    expect(summaryDepartmentOptions([])).toEqual([]);
  });

  it('фильтр: объекты, «Чел.» и суммы только выбранного отдела; пусто — все', () => {
    expect(filterSummaryByDepartment(DEPARTMENT_ROWS, '')).toHaveLength(4);
    expect(filterSummaryByDepartment(DEPARTMENT_ROWS, SUMMARY_NO_DEPARTMENT).map(r => r.employee_id)).toEqual([4]);

    const objects = groupSummaryByObject(filterSummaryByDepartment(DEPARTMENT_ROWS, 'line'));
    expect(objects.map(object => [object.object_name, object.employee_ids, object.cents.contract])).toEqual([
      ['ЖК Химки', [1], 10000000],
      ['ЖК Мытищи', [3], 5000025],
    ]);
  });

  it('сумма по всем отделам равна итогу «Все отделы»', () => {
    const payout = (rows: IPayrollSummaryRow[]) => groupSummaryByObject(rows)
      .reduce((sum, object) => sum + (object.cents.contract ?? 0), 0);
    const byDepartments = summaryDepartmentOptions(DEPARTMENT_ROWS)
      .reduce((sum, option) => sum + payout(filterSummaryByDepartment(DEPARTMENT_ROWS, option.value)), 0);
    expect(byDepartments).toBe(payout(DEPARTMENT_ROWS));
    expect(byDepartments).toBe(23100075);
  });

  it('итоги вкладок считаются от строк отдела', () => {
    const lineRows = filterSummaryByDepartment(DEPARTMENT_ROWS, 'line');
    expect(summaryPayoutText(summaryCategoryTable(lineRows, 'itr').objects)).toMatch(/^150\s000,25$/);
    expect(summaryPayoutText(summaryCategoryTable(lineRows, 'worker').objects)).toBe('—');
  });

  it('сменивший отдел — две строки одного человека с разными ключами, в «Чел.» он один', () => {
    const moved = [
      row({ department_id: 'line', department: 'ЛИНИЯ', amounts: { contract: '100.00' } }),
      row({ department_id: 'accounting', department: 'Бухгалтерия', amounts: { contract: '200.00' } }),
    ];
    const keys = toSummaryEmployeeRows(moved).map(employee => employee.key);
    expect(new Set(keys).size).toBe(2);
    expect(groupSummaryByObject(moved)[0].employee_ids).toEqual([1]);
    expect(groupSummaryByObject(moved)[0].cents.contract).toBe(30000);
  });

  it('экспорт: отдел в подзаголовке и имени файла; без отдела — как раньше', () => {
    const columns = summaryObjectColumns(['contract']);
    const objects = groupSummaryByObject(DEPARTMENT_ROWS);
    const withDepartment = buildSummarySnapshot({
      title: 'Свод', subject: 'ЛИНИЯ Все', periodLabel: 'июль 2026', categoryLabel: 'Все', departmentLabel: 'ЛИНИЯ', columns,
    })(objects);
    expect(withDepartment.subtitle).toMatch(/^Период: июль 2026\. Отдел: ЛИНИЯ\. Категория: Все\. Дата выгрузки: /);
    expect(withDepartment.file_name).toMatch(/^Свод_ЛИНИЯ_Все_\d{4}-\d{2}-\d{2}\.xlsx$/);

    const all = buildSummarySnapshot({ title: 'Свод', subject: 'Все', periodLabel: 'июль 2026', categoryLabel: 'Все', columns })(objects);
    expect(all.subtitle).toMatch(/^Период: июль 2026\. Категория: Все\. Дата выгрузки: /);
  });
});

describe('«Свод»: «Не посчитано» и «Прочие удержания»', () => {
  const ISSUE_ROWS: IPayrollSummaryRow[] = [
    row({ employee_id: 1, amounts: { contract: '100.00' } }),
    row({ employee_id: 2, amounts: {}, issues: ['brigade_output'] }),
    row({ employee_id: 3, amounts: { contract: '50.00' }, issues: ['vacation_pay', 'sick_pay'] }),
  ];

  it('столбца нет, если все посчитаны; у старого бэкенда (без issues) — тоже', () => {
    expect(summaryHasIssues(ROWS)).toBe(false);
    expect(summaryHasIssues([{ ...row({}), issues: undefined }])).toBe(false);
    expect(summaryObjectColumns(summaryItems(ROWS)).map(column => column.key)).not.toContain('not_counted');
    expect(summaryCategoryTable(ROWS, 'all').columns.map(column => column.key)).not.toContain('not_counted');
  });

  it('объекты: число людей после «Чел.», итог — уникальные; сумма неизвестного не становится нулём', () => {
    expect(summaryHasIssues(ISSUE_ROWS)).toBe(true);
    const items = summaryItems(ISSUE_ROWS);
    const columns = summaryObjectColumns(items, true);
    expect(columns.map(column => column.key).slice(0, 4)).toEqual(['object_name', 'employees', 'not_counted', 'payout']);
    const [object] = groupSummaryByObject(ISSUE_ROWS);
    expect(object.employee_ids).toEqual([1, 2, 3]);
    expect(object.not_counted_ids).toEqual([2, 3]);
    expect(columns.find(column => column.key === 'not_counted')?.text(object)).toBe('2');
    expect(summaryObjectTotals(items)([object])?.export).toMatchObject({ employees: 3, not_counted: 2, contract: 150 });
  });

  it('сотрудники: причины подписями; всё посчитано — «—»; итог без числа людей', () => {
    const items = summaryItems(ISSUE_ROWS);
    const employees = toSummaryEmployeeRows(ISSUE_ROWS);
    const column = summaryEmployeeColumns(items, false, true).find(item => item.key === 'not_counted')!;
    expect(employees.map(employee => column.text(employee))).toEqual(['—', 'выработка бригады', 'отпускные, больничные']);
    expect(summaryEmployeeColumns(items, false).map(item => item.key)).not.toContain('not_counted');
  });

  it('«Прочие удержания» — столбец после статей 1С, входит во «Всего удержано» и вычитается из «К выплате»', () => {
    const rows = [row({ amounts: { contract: '1000.00', meals: '100.00', other_deductions: '50.25' } })];
    const items = summaryItems(rows);
    expect(items).toEqual(['contract', 'meals', 'other_deductions']);
    const columns = summaryObjectColumns(items);
    expect(columns.map(column => column.label)).toContain('Прочие удержания');
    const [object] = groupSummaryByObject(rows);
    expect(columns.find(column => column.key === 'deducted')?.exportValue?.(object)).toBe(150.25);
    expect(columns.find(column => column.key === 'payout')?.exportValue?.(object)).toBe(849.75);
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

  it('все 47 статей: снимок ≤ 60 столбцов (лимит сервера), итог последней строкой, имя файла без пробелов', () => {
    const all = Object.fromEntries(PAYROLL_PAID_GROUPS.flatMap(group => group.items.map(item => [item.code, '1'])));
    const rows = toSummaryEmployeeRows([row({ amounts: all })]);
    const items = summaryItems([row({ amounts: all })]);
    expect(items).toHaveLength(47);
    const columns = summaryEmployeeColumns(items, true);
    const snapshot = buildSummarySnapshot({ title: 'Свод', subject: 'ЖК Химки', periodLabel: 'июль 2026', categoryLabel: 'Все', columns })(
      rows, summaryEmployeeTotals(items)(rows)?.export,
    );
    expect(snapshot.columns).toHaveLength(55);
    expect(snapshot.columns.length).toBeLessThanOrEqual(60);
    expect(new Set(snapshot.columns.map(column => column.label)).size).toBe(55);
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
