import { describe, expect, it } from 'vitest';

import type { IObjectKpiObjectStat, IObjectKpiReportRow, IReportPremiumRow } from '../api/objectKpi';
import {
  applyTableView,
  buildExportTable,
  buildMonthColumns,
  buildObjectColumns,
  columnFilterOptions,
  defaultMonths,
  listWindowMonths,
  objectPremiumCell,
  objectPremiumRequest,
  objectPremiumTotal,
  premiumCell,
  setColumnFilter,
  sumMoneyColumns,
  toggleSort,
  type IKpiTableView,
  type IPremiumView,
} from './objectKpiTable';

const stat = (over: Partial<IObjectKpiObjectStat>): IObjectKpiObjectStat => ({
  skud_object_id: 'obj',
  object_name: 'ЖК А',
  manager_names: ['Иванов И. И.'],
  contract_total: '1000.00',
  ks2_cumulative_before: '100.00',
  remainder: '900.00',
  fact_amount: 50,
  plan_amount: 100,
  completion_pct: 50,
  ...over,
});

/** Премия загружена, но пустая: у строк без manager_months в «Премии» «—». */
const OBJECT_COLUMNS = buildObjectColumns({ state: 'ready', byKey: new Map(), hidden: new Set() });

const view = (over: Partial<IKpiTableView> = {}): IKpiTableView => ({ sort: 'object', dir: 'asc', filters: {}, ...over });

const rows = [
  stat({ skud_object_id: 'b', object_name: 'ЖК Сад 69', manager_names: ['Петров П. П.'], completion_pct: 33.1 }),
  stat({ skud_object_id: 'a', object_name: 'База Химки', manager_names: [], completion_pct: null }),
  stat({ skud_object_id: 'c', object_name: 'ЖК Alia', completion_pct: 147.5 }),
  stat({ skud_object_id: 'd', object_name: 'ЖК Дом 56', completion_pct: 113.8 }),
];
const ids = (list: IObjectKpiObjectStat[]) => list.map(item => item.skud_object_id);

describe('applyTableView: сортировка', () => {
  it('текст — по русскому алфавиту: кириллица раньше латиницы, как в локали ru', () => {
    expect(ids(applyTableView(rows, OBJECT_COLUMNS, view()))).toEqual(['a', 'd', 'b', 'c']);
  });

  it('числа — по значению, пустые в конце при любом направлении', () => {
    expect(ids(applyTableView(rows, OBJECT_COLUMNS, view({ sort: 'pct', dir: 'asc' })))).toEqual(['b', 'd', 'c', 'a']);
    expect(ids(applyTableView(rows, OBJECT_COLUMNS, view({ sort: 'pct', dir: 'desc' })))).toEqual(['c', 'd', 'b', 'a']);
  });

  it('повторный клик меняет направление, другой столбец — по возрастанию', () => {
    expect(toggleSort(view(), 'object')).toMatchObject({ sort: 'object', dir: 'desc' });
    expect(toggleSort(view({ dir: 'desc' }), 'pct')).toMatchObject({ sort: 'pct', dir: 'asc' });
  });
});

describe('фильтры столбцов', () => {
  it('фильтр по тексту ячейки; снять фильтр — пустым списком', () => {
    const filtered = setColumnFilter(view(), 'manager', ['—']);
    expect(ids(applyTableView(rows, OBJECT_COLUMNS, filtered))).toEqual(['a']);
    expect(setColumnFilter(filtered, 'manager', []).filters).toEqual({});
  });

  it('варианты — по строкам, прошедшим фильтры остальных столбцов, со счётчиками', () => {
    const filters = { manager: ['Иванов И. И.'] };
    expect(columnFilterOptions(rows, OBJECT_COLUMNS, filters, 'object')).toEqual([
      { value: 'ЖК Дом 56', count: 1 },
      { value: 'ЖК Alia', count: 1 },
    ]);
    // Свой фильтр столбца на его варианты не влияет.
    expect(columnFilterOptions(rows, OBJECT_COLUMNS, filters, 'manager').map(item => item.value))
      .toEqual(['Иванов И. И.', 'Петров П. П.', '—']);
  });

  it('выбранное значение, которого в строках больше нет, остаётся в списке с нулём', () => {
    const options = columnFilterOptions(rows, OBJECT_COLUMNS, { object: ['ЖК Wave'] }, 'object');
    expect(options).toContainEqual({ value: 'ЖК Wave', count: 0 });
  });
});

describe('buildExportTable', () => {
  it('«№» по порядку экрана, суммы — как с сервера, пустое — текстом экрана', () => {
    const visible = applyTableView(rows, OBJECT_COLUMNS, view({ sort: 'pct', dir: 'desc' }));
    const table = buildExportTable({
      title: 'KPI объектов — Все объекты',
      subtitle: 'Период: август 2026. Все суммы — в рублях, с НДС.',
      fileName: 'KPI.xlsx',
      columns: OBJECT_COLUMNS,
      rows: visible,
    });

    expect(table.columns.map(column => column.label)).toEqual(
      ['№', 'Объект', 'Руководитель', 'Премия', 'Договор с ДС', 'КС-6', 'Остаток', 'КС-2', 'План', '%'],
    );
    expect(table.rows[0].cells).toEqual([1, 'ЖК Alia', 'Иванов И. И.', '—', '1000.00', '100.00', '900.00', 50, 100, 147.5]);
    expect(table.rows[3].cells.slice(0, 3)).toEqual([4, 'База Химки', '—']);
    expect(table.rows[3].cells.at(-1)).toBe('—');
  });

  it('«Итого» — последней строкой без номера, те же суммы, что на экране', () => {
    const table = buildExportTable({
      title: 't',
      subtitle: 's',
      fileName: 'f',
      columns: OBJECT_COLUMNS,
      rows,
      totals: { object: 'Итого', ...sumMoneyColumns(rows, OBJECT_COLUMNS) },
    });
    expect(table.rows).toHaveLength(5);
    expect(table.rows[4]).toEqual({
      cells: [null, 'Итого', null, null, '4000.00', '400.00', '3600.00', '200.00', '400.00', null],
    });
    // Без видимых строк итогов нет — в файле только шапка.
    expect(buildExportTable({ title: 't', subtitle: 's', fileName: 'f', columns: OBJECT_COLUMNS, rows: [], totals: { object: 'Итого' } }).rows)
      .toEqual([]);
  });
});

describe('sumMoneyColumns: строка «Итого»', () => {
  it('только денежные столбцы, суммы — строкой numeric', () => {
    expect(sumMoneyColumns(rows, OBJECT_COLUMNS)).toEqual({
      premium: null,
      contract: '4000.00',
      ks6: '400.00',
      remainder: '3600.00',
      ks2: '200.00',
      plan: '400.00',
    });
  });

  it('копейки без ошибок float на суммах в сотни миллиардов, отрицательный остаток', () => {
    const big = [
      stat({ contract_total: '117412437610.99', remainder: '-100.50', fact_amount: 0.1 }),
      stat({ contract_total: '0.02', remainder: '50.25', fact_amount: 0.2 }),
    ];
    expect(sumMoneyColumns(big, OBJECT_COLUMNS)).toMatchObject({
      contract: '117412437611.01',
      remainder: '-50.25',
      ks2: '0.30',
    });
  });

  it('пустые значения пропускаются; столбец без значений и пустой список — null', () => {
    const partial = [stat({ plan_amount: null, contract_total: null }), stat({ plan_amount: null })];
    expect(sumMoneyColumns(partial, OBJECT_COLUMNS)).toMatchObject({ contract: '1000.00', plan: null });
    expect(sumMoneyColumns([], OBJECT_COLUMNS)).toEqual({
      premium: null, contract: null, ks6: null, remainder: null, ks2: null, plan: null,
    });
  });

  it('по видимым строкам: фильтр столбца меняет итоги', () => {
    const visible = applyTableView(rows, OBJECT_COLUMNS, view({ filters: { manager: ['Иванов И. И.'] } }));
    expect(sumMoneyColumns(visible, OBJECT_COLUMNS)).toMatchObject({ contract: '2000.00', plan: '200.00' });
  });
});

describe('таблица объекта: премия', () => {
  const monthRow = (over: Partial<IObjectKpiReportRow>) => ({
    period_month: '2026-08-01',
    primary_manager_id: 7,
    primary_manager_name: 'Казанцев А. В.',
    fact_amount: '318643745.00',
    months_remaining: 7,
    ...over,
  } as IObjectKpiReportRow);
  const premiumRow = (over: Partial<IReportPremiumRow>): IReportPremiumRow => ({
    employee_id: 7,
    period_month: '2026-08-01',
    status: 'calculated',
    completion_pct: '185.10',
    coefficient: '1.00',
    premium_amount: '300000.00',
    ...over,
  });
  const premiumView = (over: Partial<IPremiumView> = {}): IPremiumView => ({
    state: 'ready',
    byKey: new Map([['7|2026-08-01', premiumRow({})], ['7|2026-07-01', premiumRow({ period_month: '2026-07-01', status: 'no_scale', premium_amount: null })]]),
    hidden: new Set(),
    ...over,
  });

  it('состояния ячейки — как раньше на экране', () => {
    expect(premiumCell(monthRow({}), premiumView())).toMatchObject({ amount: '300000.00', muted: false });
    expect(premiumCell(monthRow({ period_month: '2026-07-01' }), premiumView())).toMatchObject({ text: 'нет шкалы', muted: true });
    expect(premiumCell(monthRow({ primary_manager_id: null }), premiumView()).text).toBe('—');
    expect(premiumCell(monthRow({}), premiumView({ hidden: new Set([7]) }))).toMatchObject({ text: '—', muted: true });
    expect(premiumCell(monthRow({}), premiumView({ state: 'loading' })).text).toBe('…');
    expect(premiumCell(monthRow({ period_month: '2026-09-01' }), premiumView()).text).toBe('—');
  });

  it('в выгрузке премия — суммой, статус — подписью экрана; прогноз помечается', () => {
    const columns = buildMonthColumns(premiumView());
    const table = buildExportTable({
      title: 't',
      subtitle: 's',
      fileName: 'f',
      columns,
      rows: [monthRow({}), monthRow({ period_month: '2026-07-01' }), monthRow({ period_month: '2026-10-01', is_forecast: true })],
      isMuted: row => Boolean(row.is_forecast),
    });
    expect(table.rows[0].cells.slice(0, 3)).toEqual([1, '300000.00', 'август 2026']);
    expect(table.rows[1].cells[1]).toBe('нет шкалы');
    expect(table.rows[2]).toMatchObject({ muted: true });
    expect(table.rows[0]).not.toHaveProperty('muted');
  });
});

describe('«Все объекты»: премия', () => {
  const premiumRow = (employeeId: number, month: string, over: Partial<IReportPremiumRow> = {}): IReportPremiumRow => ({
    employee_id: employeeId,
    period_month: month,
    status: 'calculated',
    completion_pct: '100.00',
    coefficient: '1.00',
    premium_amount: '100000.00',
    ...over,
  });
  const premiumView = (items: IReportPremiumRow[], over: Partial<IPremiumView> = {}): IPremiumView => ({
    state: 'ready',
    byKey: new Map(items.map(item => [`${item.employee_id}|${item.period_month}`, item])),
    hidden: new Set(),
    ...over,
  });
  const months = (...pairs: Array<[number, string]>) =>
    pairs.map(([employeeId, month]) => ({ employee_id: employeeId, period_month: month }));

  it('смена руководителя между месяцами — складываются премии разных людей, в копейках', () => {
    const row = stat({ manager_months: months([7, '2026-07-01'], [8, '2026-08-01']) });
    const premium = premiumView([
      premiumRow(7, '2026-07-01', { premium_amount: '100000.10' }),
      premiumRow(8, '2026-08-01', { premium_amount: '50000.20' }),
    ]);
    expect(objectPremiumCell(row, premium)).toMatchObject({ amount: '150000.30', muted: false });
  });

  it('рассчитанный месяц + «нет плана» — сумма, в подсказке «часть периода»', () => {
    const row = stat({ manager_months: months([7, '2026-07-01'], [7, '2026-08-01']) });
    const cell = objectPremiumCell(row, premiumView([
      premiumRow(7, '2026-07-01'),
      premiumRow(7, '2026-08-01', { status: 'no_plan', premium_amount: null }),
    ]));
    expect(cell.amount).toBe('100000.00');
    expect(cell.title).toContain('Рассчитана только часть периода: 1 из 2 мес.');
  });

  it('нерассчитанные: один статус — короткая подпись, разные — «—»', () => {
    const row = stat({ manager_months: months([7, '2026-07-01'], [7, '2026-08-01']) });
    expect(objectPremiumCell(row, premiumView([
      premiumRow(7, '2026-07-01', { status: 'no_plan', premium_amount: null }),
      premiumRow(7, '2026-08-01', { status: 'no_plan', premium_amount: null }),
    ]))).toMatchObject({ text: 'нет плана', muted: true, amount: null });
    expect(objectPremiumCell(row, premiumView([
      premiumRow(7, '2026-07-01', { status: 'no_plan', premium_amount: null }),
      premiumRow(7, '2026-08-01', { status: 'no_scale', premium_amount: null }),
    ]))).toMatchObject({ text: '—', amount: null });
    // Месяца нет в ответе — тоже «разные причины».
    expect(objectPremiumCell(row, premiumView([
      premiumRow(7, '2026-07-01', { status: 'no_plan', premium_amount: null }),
    ])).text).toBe('—');
  });

  it('скрытый руководитель — вся ячейка «—», даже если второй доступен', () => {
    const row = stat({ manager_months: months([7, '2026-07-01'], [9, '2026-08-01']) });
    const premium = premiumView([premiumRow(7, '2026-07-01')], { hidden: new Set([9]) });
    expect(objectPremiumCell(row, premium)).toMatchObject({ text: '—', muted: true, amount: null });
    expect(objectPremiumTotal([row], premium)).toBeNull();
  });

  it('пара из скрытой строки есть и в доступной — в итоге один раз', () => {
    const hiddenRow = stat({ skud_object_id: 'x', manager_months: months([7, '2026-07-01'], [9, '2026-08-01']) });
    const openRow = stat({ skud_object_id: 'y', manager_months: months([7, '2026-07-01']) });
    const premium = premiumView([premiumRow(7, '2026-07-01')], { hidden: new Set([9]) });
    expect(objectPremiumTotal([hiddenRow, openRow], premium)).toBe('100000.00');
  });

  it('без manager_months (старый бэкенд) — «—»', () => {
    expect(objectPremiumCell(stat({}), premiumView([premiumRow(7, '2026-07-01')]))).toMatchObject({ text: '—', amount: null });
  });

  it('один руководитель на двух объектах — в строках по сумме, в «Итого» один раз', () => {
    const rowsOfOne = [
      stat({ skud_object_id: 'a', manager_months: months([7, '2026-09-01']) }),
      stat({ skud_object_id: 'b', manager_months: months([7, '2026-09-01']) }),
    ];
    const premium = premiumView([premiumRow(7, '2026-09-01', { premium_amount: '168000.00' })]);
    expect(rowsOfOne.map(row => objectPremiumCell(row, premium).amount)).toEqual(['168000.00', '168000.00']);
    expect(objectPremiumTotal(rowsOfOne, premium)).toBe('168000.00');
  });

  it('calculated без суммы или с мусором — не результат; ноль — валидная премия', () => {
    const row = stat({ manager_months: months([7, '2026-07-01'], [7, '2026-08-01']) });
    const broken = objectPremiumCell(row, premiumView([
      premiumRow(7, '2026-07-01', { premium_amount: null }),
      premiumRow(7, '2026-08-01', { premium_amount: 'abc' }),
    ]));
    expect(broken).toMatchObject({ text: '—', amount: null });

    const zero = objectPremiumCell(row, premiumView([
      premiumRow(7, '2026-07-01', { premium_amount: '0.00' }),
      premiumRow(7, '2026-08-01', { premium_amount: '0' }),
    ]));
    expect(zero.amount).toBe('0.00');
    expect(zero.title).not.toContain('часть периода');
  });

  it('повтор пары в manager_months — N из M по уникальным', () => {
    const row = stat({ manager_months: months([7, '2026-07-01'], [7, '2026-07-01'], [7, '2026-08-01']) });
    const cell = objectPremiumCell(row, premiumView([premiumRow(7, '2026-07-01')]));
    expect(cell.amount).toBe('100000.00');
    expect(cell.title).toContain('1 из 2 мес.');
  });

  it('загрузка и ошибка — итог null, ячейки «…» и «н/д»', () => {
    const row = stat({ manager_months: months([7, '2026-07-01']) });
    const items = [premiumRow(7, '2026-07-01')];
    expect(objectPremiumTotal([row], premiumView(items, { state: 'loading' }))).toBeNull();
    expect(objectPremiumTotal([row], premiumView(items, { state: 'error' }))).toBeNull();
    expect(objectPremiumCell(row, premiumView(items, { state: 'loading' })).text).toBe('…');
    expect(objectPremiumCell(row, premiumView(items, { state: 'error' })).text).toBe('н/д');
  });

  it('итог — по строкам после фильтра столбца', () => {
    const premium = premiumView([premiumRow(7, '2026-09-01'), premiumRow(8, '2026-09-01', { premium_amount: '50000.00' })]);
    const columns = buildObjectColumns(premium);
    const list = [
      stat({ skud_object_id: 'a', manager_names: ['Иванов И. И.'], manager_months: months([7, '2026-09-01']) }),
      stat({ skud_object_id: 'b', manager_names: ['Петров П. П.'], manager_months: months([8, '2026-09-01']) }),
    ];
    const visible = applyTableView(list, columns, view({ filters: { manager: ['Петров П. П.'] } }));
    expect(objectPremiumTotal(visible, premium)).toBe('50000.00');
    // Сортировка по премии — по сумме.
    expect(ids(applyTableView(list, columns, view({ sort: 'premium', dir: 'desc' })))).toEqual(['a', 'b']);
  });

  it('экспорт: рассчитанная премия — числом, статус — текстом', () => {
    const premium = premiumView([
      premiumRow(7, '2026-09-01'),
      premiumRow(8, '2026-09-01', { status: 'no_plan', premium_amount: null }),
    ]);
    const table = buildExportTable({
      title: 't',
      subtitle: 's',
      fileName: 'f',
      columns: buildObjectColumns(premium),
      rows: [
        stat({ skud_object_id: 'a', manager_months: months([7, '2026-09-01']) }),
        stat({ skud_object_id: 'b', manager_months: months([8, '2026-09-01']) }),
      ],
    });
    expect(table.rows[0].cells[3]).toBe('100000.00');
    expect(table.rows[1].cells[3]).toBe('нет плана');
  });
});

describe('objectPremiumRequest', () => {
  const period = { from: '2026-01', to: '2026-10' };

  it('«Все объекты»: до базового окна — не звать', () => {
    expect(objectPremiumRequest({ objectId: '', tablePeriod: undefined, basePeriod: undefined, activeMonths: [] })).toBeNull();
    expect(objectPremiumRequest({ objectId: '', tablePeriod: undefined, basePeriod: undefined, activeMonths: ['2026-09'] })).toBeNull();
  });

  it('«Все объекты»: выбранные месяцы — отсортированным набором; пустой выбор — весь период', () => {
    expect(objectPremiumRequest({ objectId: '', tablePeriod: undefined, basePeriod: period, activeMonths: ['2026-09', '2026-07'] }))
      .toEqual({ period: null, objectId: null, months: ['2026-07', '2026-09'] });
    expect(objectPremiumRequest({ objectId: '', tablePeriod: undefined, basePeriod: period, activeMonths: [] }))
      .toEqual({ period: null, objectId: null, months: null });
  });

  it('объект: ждёт окно таблицы, выбор месяцев не учитывает', () => {
    expect(objectPremiumRequest({ objectId: 'obj', tablePeriod: undefined, basePeriod: period, activeMonths: ['2026-09'] })).toBeNull();
    expect(objectPremiumRequest({ objectId: 'obj', tablePeriod: period, basePeriod: undefined, activeMonths: ['2026-09'] }))
      .toEqual({ period, objectId: 'obj', months: null });
  });
});

describe('месяцы', () => {
  it('окно по порядку', () => {
    expect(listWindowMonths({ from: '2025-11', to: '2026-02' })).toEqual(['2025-11', '2025-12', '2026-01', '2026-02']);
  });

  it('по умолчанию — прошлый месяц, если он в окне; иначе весь период', () => {
    const options = ['2026-07', '2026-08', '2026-09'];
    expect(defaultMonths(options, '2026-09')).toEqual(['2026-08']);
    expect(defaultMonths(['2026-09'], '2026-09')).toEqual([]);
    expect(defaultMonths(['2025-12', '2026-01'], '2026-01')).toEqual(['2025-12']);
  });
});
