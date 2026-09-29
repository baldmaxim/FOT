import { describe, expect, it } from 'vitest';

import type { IObjectKpiObjectStat, IObjectKpiReportRow, IReportPremiumRow } from '../api/objectKpi';
import {
  applyTableView,
  buildExportTable,
  buildMonthColumns,
  columnFilterOptions,
  defaultMonths,
  formatMonthsLabel,
  listWindowMonths,
  OBJECT_STAT_COLUMNS,
  premiumCell,
  setColumnFilter,
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
    expect(ids(applyTableView(rows, OBJECT_STAT_COLUMNS, view()))).toEqual(['a', 'd', 'b', 'c']);
  });

  it('числа — по значению, пустые в конце при любом направлении', () => {
    expect(ids(applyTableView(rows, OBJECT_STAT_COLUMNS, view({ sort: 'pct', dir: 'asc' })))).toEqual(['b', 'd', 'c', 'a']);
    expect(ids(applyTableView(rows, OBJECT_STAT_COLUMNS, view({ sort: 'pct', dir: 'desc' })))).toEqual(['c', 'd', 'b', 'a']);
  });

  it('повторный клик меняет направление, другой столбец — по возрастанию', () => {
    expect(toggleSort(view(), 'object')).toMatchObject({ sort: 'object', dir: 'desc' });
    expect(toggleSort(view({ dir: 'desc' }), 'pct')).toMatchObject({ sort: 'pct', dir: 'asc' });
  });
});

describe('фильтры столбцов', () => {
  it('фильтр по тексту ячейки; снять фильтр — пустым списком', () => {
    const filtered = setColumnFilter(view(), 'manager', ['—']);
    expect(ids(applyTableView(rows, OBJECT_STAT_COLUMNS, filtered))).toEqual(['a']);
    expect(setColumnFilter(filtered, 'manager', []).filters).toEqual({});
  });

  it('варианты — по строкам, прошедшим фильтры остальных столбцов, со счётчиками', () => {
    const filters = { manager: ['Иванов И. И.'] };
    expect(columnFilterOptions(rows, OBJECT_STAT_COLUMNS, filters, 'object')).toEqual([
      { value: 'ЖК Дом 56', count: 1 },
      { value: 'ЖК Alia', count: 1 },
    ]);
    // Свой фильтр столбца на его варианты не влияет.
    expect(columnFilterOptions(rows, OBJECT_STAT_COLUMNS, filters, 'manager').map(item => item.value))
      .toEqual(['Иванов И. И.', 'Петров П. П.', '—']);
  });

  it('выбранное значение, которого в строках больше нет, остаётся в списке с нулём', () => {
    const options = columnFilterOptions(rows, OBJECT_STAT_COLUMNS, { object: ['ЖК Wave'] }, 'object');
    expect(options).toContainEqual({ value: 'ЖК Wave', count: 0 });
  });
});

describe('buildExportTable', () => {
  it('«№» по порядку экрана, суммы — как с сервера, пустое — текстом экрана', () => {
    const visible = applyTableView(rows, OBJECT_STAT_COLUMNS, view({ sort: 'pct', dir: 'desc' }));
    const table = buildExportTable({
      title: 'KPI объектов — Все объекты',
      subtitle: 'Период: август 2026. Все суммы — в рублях, с НДС.',
      fileName: 'KPI.xlsx',
      columns: OBJECT_STAT_COLUMNS,
      rows: visible,
    });

    expect(table.columns.map(column => column.label)).toEqual(
      ['№', 'Объект', 'Руководитель', 'Договор с ДС', 'КС-6', 'Остаток', 'КС-2', 'План', '%'],
    );
    expect(table.rows[0].cells).toEqual([1, 'ЖК Alia', 'Иванов И. И.', '1000.00', '100.00', '900.00', 50, 100, 147.5]);
    expect(table.rows[3].cells.slice(0, 3)).toEqual([4, 'База Химки', '—']);
    expect(table.rows[3].cells.at(-1)).toBe('—');
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

  it('подпись: один месяц, подряд — диапазоном, вразброс — перечнем', () => {
    expect(formatMonthsLabel(['2026-08'])).toBe('август 2026');
    expect(formatMonthsLabel(['2026-09', '2026-07', '2026-08'])).toBe('июль 2026 — сентябрь 2026');
    expect(formatMonthsLabel(['2026-09', '2026-07'])).toBe('июль 2026, сентябрь 2026');
    expect(formatMonthsLabel([])).toBe('');
  });
});
