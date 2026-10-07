import { describe, expect, it } from 'vitest';

import type { IWorkSchedule } from '../types/schedule';
import { formatHours, SCHEDULE_TEMPLATE_COLUMNS } from './scheduleTemplatesTable';
import { applyTableView, buildExportTable, columnFilterOptions, setColumnFilter, type ITableView } from './tableView';

const cycle = (work: number, off: number) => Array.from({ length: work + off }, (_, i) => ({ work_hours: i < work ? 8 : 0 }));

const tpl = (over: Partial<IWorkSchedule>): IWorkSchedule => ({
  id: 'id',
  name: 'Шаблон',
  schedule_type: 'shift',
  work_start: '09:00:00',
  work_end: '18:00:00',
  work_hours: 8,
  work_days: [1, 2, 3, 4, 5],
  office_days: null,
  late_threshold_minutes: 0,
  day_overrides: null,
  is_default: false,
  lunch_minutes: 60,
  respects_holidays: true,
  pattern_type: 'cycle',
  expected_saturdays_per_month: 0,
  expected_sundays_per_month: 0,
  full_day_threshold_minutes: null,
  weekend_full_day_threshold_minutes: null,
  cycle_length: 7,
  cycle_days: cycle(5, 2),
  anchor_date: '2025-12-29',
  created_at: '2025-01-01T00:00:00Z',
  updated_at: '2025-01-01T00:00:00Z',
  ...over,
});

const column = (key: string) => {
  const found = SCHEDULE_TEMPLATE_COLUMNS.find(item => item.key === key);
  if (!found) throw new Error(key);
  return found;
};

const VIEW: ITableView = { sort: '', dir: 'asc', filters: {} };

const ROWS = [
  tpl({ id: 'def', name: '5+0', is_default: true }),
  tpl({ id: 'guard', name: '1/1 Охрана', work_start: '00:00:00', work_end: '00:00:00', work_hours: 24, lunch_minutes: 0, cycle_length: 2, cycle_days: cycle(1, 1), anchor_date: '2026-09-23', respects_holidays: false }),
  tpl({ id: 'shift15', name: '15/15', cycle_length: 15, cycle_days: cycle(15, 0), anchor_date: '2026-04-06', work_start: '07:00:00', work_hours: 10 }),
  tpl({ id: 'mon', name: '2/2 мониторинг', cycle_length: 4, cycle_days: cycle(2, 2), lunch_minutes: 0, schedule_type: 'remote' }),
  tpl({ id: 'legacy', name: 'Старый', pattern_type: '5+0', anchor_date: '2026-01-01', lunch_minutes: 30 }),
];

const ids = (rows: IWorkSchedule[]) => rows.map(row => row.id);

describe('SCHEDULE_TEMPLATE_COLUMNS', () => {
  it('тексты ячеек — как на экране', () => {
    const row = ROWS[1];
    expect(column('rhythm').text(row)).toBe('1/1');
    expect(column('anchor').text(row)).toBe('23.09.2026');
    expect(column('shift').text(row)).toBe('00:00–00:00 (24:00)');
    expect(column('lunch').text(row)).toBe('0 мин');
    expect(column('holidays').text(row)).toBe('игнорирует');
    expect(column('type').text(ROWS[3])).toBe('Удалённо');
  });

  it('у legacy-шаблона якоря нет', () => {
    expect(column('anchor').text(ROWS[4])).toBe('—');
    expect(column('anchor').sortValue(ROWS[4])).toBeNull();
  });

  it('formatHours: десятичные часы → Ч:ММ', () => {
    expect(formatHours(8)).toBe('8:00');
    expect(formatHours(10.5)).toBe('10:30');
  });
});

describe('сортировка и фильтры шаблонов', () => {
  it('ритм — по числам, а не по строке: 5/2 раньше 15/0', () => {
    const sorted = applyTableView(ROWS, SCHEDULE_TEMPLATE_COLUMNS, { ...VIEW, sort: 'rhythm' });
    expect(sorted.map(row => column('rhythm').text(row))).toEqual(['1/1', '2/2', '5/2', '5/2', '15/0']);
  });

  it('обед — числом', () => {
    const sorted = applyTableView(ROWS, SCHEDULE_TEMPLATE_COLUMNS, { ...VIEW, sort: 'lunch', dir: 'desc' });
    expect(ids(sorted)).toEqual(['def', 'shift15', 'legacy', 'guard', 'mon']);
  });

  it('пустой якорь — в конце при любом направлении', () => {
    const asc = applyTableView(ROWS, SCHEDULE_TEMPLATE_COLUMNS, { ...VIEW, sort: 'anchor' });
    const desc = applyTableView(ROWS, SCHEDULE_TEMPLATE_COLUMNS, { ...VIEW, sort: 'anchor', dir: 'desc' });
    expect(ids(asc).at(-1)).toBe('legacy');
    expect(ids(desc).at(-1)).toBe('legacy');
  });

  it('без сортировки — порядок сервера', () => {
    expect(ids(applyTableView(ROWS, SCHEDULE_TEMPLATE_COLUMNS, VIEW))).toEqual(ids(ROWS));
  });

  it('варианты фильтра считаются по тексту ячейки', () => {
    expect(columnFilterOptions(ROWS, SCHEDULE_TEMPLATE_COLUMNS, {}, 'type')).toEqual([
      { value: 'Очно', count: 4 },
      { value: 'Удалённо', count: 1 },
    ]);
  });
});

describe('экспорт шаблонов', () => {
  it('выгружает ровно видимые строки в порядке экрана, с «№» и пометками у названия', () => {
    const view = { ...setColumnFilter(VIEW, 'holidays', ['учитывает']), sort: 'lunch', dir: 'asc' as const };
    const visible = applyTableView(ROWS, SCHEDULE_TEMPLATE_COLUMNS, view);
    const table = buildExportTable({
      title: 'Шаблоны графиков',
      subtitle: '',
      fileName: 'x.xlsx',
      columns: SCHEDULE_TEMPLATE_COLUMNS,
      rows: visible,
    });

    expect(table.columns.map(item => item.label)).toEqual(
      ['№', 'Название', 'Ритм', 'Якорь', 'Смена', 'Обед', 'Праздники', 'Тип'],
    );
    expect(table.rows.map(row => row.cells.slice(0, 2))).toEqual([
      [1, '2/2 мониторинг'],
      [2, 'Старый (legacy)'],
      [3, '5+0 (дефолт)'],
      [4, '15/15'],
    ]);
    expect(table.rows[0].cells).toEqual([1, '2/2 мониторинг', '2/2', '29.12.2025', '09:00–18:00 (8:00)', '0 мин', 'учитывает', 'Удалённо']);
  });
});
