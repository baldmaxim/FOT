import { describe, expect, it } from 'vitest';

import type { IStaffWeekendRow } from '../services/staffWeekendService';
import { buildStaffWeekendExport, STAFF_WEEKEND_COLUMNS, staffWeekendMonthOptions } from './staffWeekendTable';
import { applyTableView, columnFilterOptions } from './tableView';

const dzhumaev: IStaffWeekendRow = {
  employee_id: 1,
  full_name: 'Джумаев Абдусаттор Хуррамович',
  department: 'ЛИНИЯ-Общестрой',
  position: 'Начальник участка отделочных работ',
  days: ['2026-10-04', '2026-10-11', '2026-10-17', '2026-10-18', '2026-10-24', '2026-10-25', '2026-10-31'],
  total_minutes: 2682,
};
const sokurov: IStaffWeekendRow = {
  employee_id: 2,
  full_name: 'Сокуров Георгий Леонидович',
  department: 'ЛИНИЯ',
  position: null,
  days: ['2026-10-17', '2026-10-24'],
  total_minutes: 408,
};

const column = (key: string) => {
  const found = STAFF_WEEKEND_COLUMNS.find(item => item.key === key);
  if (!found) throw new Error(`нет столбца ${key}`);
  return found;
};

describe('staffWeekendMonthOptions', () => {
  it('текущий и 11 прошлых, по возрастанию, через границу года и без будущих', () => {
    const options = staffWeekendMonthOptions('2026-11');
    expect(options).toHaveLength(12);
    expect(options[0]).toBe('2025-12');
    expect(options[11]).toBe('2026-11');
  });

  it('один и тот же календарный месяц не встречается дважды: ДД.ММ однозначен', () => {
    const calendarMonths = staffWeekendMonthOptions('2026-11').map(month => month.slice(5, 7));
    expect(new Set(calendarMonths).size).toBe(12);
  });
});

describe('столбцы «Выходных»', () => {
  it('строка на экране: дни, часы с одним знаком, даты ДД.ММ', () => {
    expect(column('days_count').text(dzhumaev)).toBe('7');
    expect(column('hours').text(dzhumaev)).toBe('44,7');
    expect(column('dates').text(dzhumaev)).toBe('04.10, 11.10, 17.10, 18.10, 24.10, 25.10, 31.10');
  });

  it('пустая должность — прочерк', () => {
    expect(column('position').text(sokurov)).toBe('—');
  });

  it('список дат не обрезается двумя строками', () => {
    expect(column('dates').wrap).toBe(true);
  });

  it('часы сортируются по числу: 408 мин раньше 2682', () => {
    const rows = applyTableView([dzhumaev, sokurov], STAFF_WEEKEND_COLUMNS, { sort: 'hours', dir: 'asc', filters: {} });
    expect(rows.map(row => row.employee_id)).toEqual([2, 1]);
  });

  it('даты сортируются по самой ранней дате', () => {
    const rows = applyTableView([sokurov, dzhumaev], STAFF_WEEKEND_COLUMNS, { sort: 'dates', dir: 'asc', filters: {} });
    expect(rows.map(row => row.employee_id)).toEqual([1, 2]);
  });

  it('фильтр по одной дате: в списке отдельные даты, строка проходит, если дата в ней есть', () => {
    const options = columnFilterOptions([dzhumaev, sokurov], STAFF_WEEKEND_COLUMNS, {}, 'dates').map(option => option.value);
    expect(options).toContain('04.10');
    expect(options).toContain('17.10');
    expect(options).not.toContain('04.10, 11.10, 17.10, 18.10, 24.10, 25.10, 31.10');

    const rows = applyTableView([dzhumaev, sokurov], STAFF_WEEKEND_COLUMNS, { sort: 'full_name', dir: 'asc', filters: { dates: ['04.10'] } });
    expect(rows.map(row => row.employee_id)).toEqual([1]);
  });
});

describe('buildStaffWeekendExport', () => {
  it('те же строки и значения, что на экране; месяцы — в подзаголовке', () => {
    const snapshot = buildStaffWeekendExport([dzhumaev], ['2026-10']);
    expect(snapshot.columns.map(item => item.label)).toEqual(['№', 'ФИО', 'Отдел', 'Должность', 'Дней', 'Часы', 'Даты']);
    expect(snapshot.rows[0]?.cells).toEqual([
      1,
      'Джумаев Абдусаттор Хуррамович',
      'ЛИНИЯ-Общестрой',
      'Начальник участка отделочных работ',
      7,
      '44,7',
      '04.10, 11.10, 17.10, 18.10, 24.10, 25.10, 31.10',
    ]);
    expect(snapshot.subtitle).toMatch(/^Месяцы: /);
    expect(snapshot.subtitle).toMatch(/2026/);
    expect(snapshot.file_name).toMatch(/^Выходные_\d{4}-\d{2}-\d{2}\.xlsx$/);
  });
});
