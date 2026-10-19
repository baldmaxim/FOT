import { describe, expect, it } from 'vitest';

import type { IDeductionRegistryRow, IPayrollSupplementRow } from '../services/payrollRegistryService';
import {
  buildDeductionExport,
  DEDUCTION_COLUMNS,
  HOUSING_COLUMNS,
  SUPPLEMENT_COLUMNS,
  supplementPeriod,
  supplementRowKey,
} from './payrollRegistries';
import {
  oneTimeMonthOptions,
  parseHousingForm,
  parseOneTimeForm,
  parsePlannedForm,
  parseStopForm,
} from './payrollRegistryForms';
import { applyTableView, columnFilterOptions, fitRegistryColumnWidths, matchesNameSearch } from './tableView';

const deduction = (employeeId: number, kinds: string[], amount: string | null = null): IDeductionRegistryRow => ({
  employee_id: employeeId, full_name: `Сотрудник ${employeeId}`, department: null, position: null, kinds, amount,
});

const supplement = (over: Partial<IPayrollSupplementRow>): IPayrollSupplementRow => ({
  kind: 'planned', id: null, employee_id: 1, full_name: 'Акимов С.Ю.', department: null, position: null,
  amount: '5000.00', date_from: '2026-10-01', date_to: '2026-12-31', month: null, reason: null, can_edit: true,
  ...over,
});

describe('«Удержания»: фильтр по отдельным видам', () => {
  const rows = [deduction(1, ['ТМЦ', 'Питание']), deduction(2, ['ТМЦ']), deduction(3, [], '1500.00')];

  it('в списке фильтра — виды по отдельности, без склеек; без вида — «—»', () => {
    expect(columnFilterOptions(rows, DEDUCTION_COLUMNS, {}, 'kinds')).toEqual(expect.arrayContaining([
      { value: 'ТМЦ', count: 2 },
      { value: 'Питание', count: 1 },
      { value: '—', count: 1 },
    ]));
    expect(columnFilterOptions(rows, DEDUCTION_COLUMNS, {}, 'kinds')).toHaveLength(3);
  });

  it('«Питание» находит строку «ТМЦ, Питание»', () => {
    const visible = applyTableView(rows, DEDUCTION_COLUMNS, { sort: '', dir: 'asc', filters: { kinds: ['Питание'] } });
    expect(visible.map(row => row.employee_id)).toEqual([1]);
  });

  it('экспорт: виды текстом ячейки, сумма — числом-строкой с сервера, нет суммы — «—», как на экране', () => {
    const snapshot = buildDeductionExport(rows);
    expect(snapshot.columns.map(column => column.label)).toEqual(['№', 'ФИО', 'Отдел', 'Должность', 'Вид удержания', 'Сумма, ₽/мес']);
    expect(snapshot.rows[0].cells).toEqual([1, 'Сотрудник 1', '—', '—', 'ТМЦ, Питание', '—']);
    expect(snapshot.rows[2].cells[5]).toBe('1500.00');
  });
});

describe('«Доплата»', () => {
  it('период: плановая — даты, разовая — месяц', () => {
    expect(supplementPeriod(supplement({}))).toBe('01.10.2026 – 31.12.2026');
    expect(supplementPeriod(supplement({ kind: 'one_time', id: 5, month: '2026-10', date_from: null, date_to: null })))
      .toBe('октябрь 2026');
  });

  it('ключ строки: плановая — по сотруднику, разовая — по id', () => {
    expect(supplementRowKey(supplement({}))).toBe('planned-1');
    expect(supplementRowKey(supplement({ kind: 'one_time', id: 5 }))).toBe('once-5');
  });

  it('сортировка по периоду ставит разовую по первому числу месяца', () => {
    const rows = [
      supplement({ kind: 'one_time', id: 5, month: '2026-11', date_from: null, date_to: null }),
      supplement({ employee_id: 2, date_from: '2026-10-15' }),
    ];
    const sorted = applyTableView(rows, SUPPLEMENT_COLUMNS, { sort: 'period', dir: 'asc', filters: {} });
    expect(sorted.map(supplementRowKey)).toEqual(['planned-2', 'once-5']);
  });
});

describe('поиск по ФИО', () => {
  it('без учёта регистра и «ё»', () => {
    expect(matchesNameSearch('Карасёв Пётр', 'карасев')).toBe(true);
    expect(matchesNameSearch('Карасёв Пётр', '  ')).toBe(true);
    expect(matchesNameSearch(null, 'кар')).toBe(false);
  });
});

describe('формы', () => {
  it('проживание: без оклада и без суммы — ошибки, сумма с запятой и пробелами', () => {
    expect(parseHousingForm({ selected: true, hasTerms: false, amount: '630', effectiveFrom: '2026-10-19' }))
      .toMatchObject({ ok: false, field: 'employee', message: 'Сначала внесите оклад в окне сотрудника' });
    expect(parseHousingForm({ selected: true, hasTerms: true, amount: '0', effectiveFrom: '2026-10-19' }))
      .toMatchObject({ ok: false, field: 'amount' });
    expect(parseHousingForm({ selected: true, hasTerms: true, amount: '1 250,5', effectiveFrom: '2026-10-19' }))
      .toEqual({ ok: true, payload: { amount: 1250.5, effective_from: '2026-10-19' } });
  });

  it('плановая: окончание раньше начала', () => {
    expect(parsePlannedForm({ selected: true, amount: '5000', dateFrom: '2026-10-01', dateTo: '2026-09-30' }))
      .toMatchObject({ ok: false, field: 'date_to' });
  });

  it('разовая: основание обязательно и без лишних пробелов', () => {
    expect(parseOneTimeForm({ selected: true, month: '2026-10', amount: '100', reason: '   ' }))
      .toMatchObject({ ok: false, field: 'reason' });
    expect(parseOneTimeForm({ selected: true, month: '2026-10', amount: '100', reason: ' Премия  за объект ' }))
      .toEqual({ ok: true, payload: { month: '2026-10', amount: 100, reason: 'Премия за объект' } });
  });

  it('«Не выплачивать»: «по» пусто — бессрочно, один день — можно', () => {
    expect(parseStopForm({ selected: true, dateFrom: '2026-08-01', dateTo: '' }))
      .toEqual({ ok: true, payload: { date_from: '2026-08-01', date_to: null } });
    expect(parseStopForm({ selected: true, dateFrom: '2026-08-01', dateTo: '2026-08-01' })).toMatchObject({ ok: true });
    expect(parseStopForm({ selected: true, dateFrom: '2026-08-01', dateTo: '2026-07-31' }))
      .toMatchObject({ ok: false, field: 'date_to' });
  });

  it('месяцы разовой доплаты: следующий, текущий и 11 прошлых', () => {
    const options = oneTimeMonthOptions('2026-01');
    expect(options).toHaveLength(13);
    expect(options.slice(0, 3)).toEqual(['2026-02', '2026-01', '2025-12']);
    expect(options[12]).toBe('2025-02');
  });
});

describe('ширины столбцов: подпись в одну строку, когда хватает места', () => {
  // ФИО, Отдел 140, Должность 148, Сумма 128, Действует с 160; подпись — 8px на символ.
  const labelWidth = (label: string): number => label.length * 8;
  const fit = (containerWidth: number) => fitRegistryColumnWidths({
    columns: HOUSING_COLUMNS, containerWidth, labelWidth, actionsWidth: 84,
  });

  it('места много — «Сумма, ₽/мес» расширяется (12 × 8 + 58 = 154), остальные уже влезают', () => {
    expect(fit(1700)).toEqual([undefined, 140, 148, 154, 160]);
  });

  it('места нет (как на 1280 с семью столбцами) — компактные ширины', () => {
    // 48 + 170 + 84 + 576 = 878 — запаса нет.
    expect(fit(878)).toEqual([undefined, 140, 148, 128, 160]);
    expect(fit(900)).toEqual([undefined, 140, 148, 128, 160]);
  });

  it('запаса ровно на расширение — расширяется', () => {
    expect(fit(878 + 26)).toEqual([undefined, 140, 148, 154, 160]);
  });
});
