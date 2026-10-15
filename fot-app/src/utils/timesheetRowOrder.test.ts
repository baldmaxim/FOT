import { describe, expect, it } from 'vitest';
import type { TimesheetEmployee } from '../types/timesheet';
import { sortTimesheetRows } from './timesheetRowOrder';

const row = (
  id: number,
  full_name: string,
  source: TimesheetEmployee['source'],
  department_name: string | null = null,
): TimesheetEmployee => ({
  id,
  full_name,
  source,
  department_name,
  position_id: null,
  position_name: null,
  org_department_id: null,
  employment_status: 'active',
} as TimesheetEmployee);

describe('sortTimesheetRows', () => {
  it('секции по порядку, «Только просмотр» последней', () => {
    const sorted = sortTimesheetRows([
      row(1, 'Агарков', 'view_only', 'Гарантийный отдел'),
      row(2, 'Бачу', 'direct_report', 'ЛИНИЯ'),
      row(3, 'Владимиров', 'self', 'ЛИНИЯ'),
      row(4, 'Вишник', 'direct_report_covered', 'Отдел экономики строительства'),
    ]);
    expect(sorted.map(r => r.id)).toEqual([3, 2, 4, 1]);
  });

  it('внутри «Только просмотр» — по отделу, затем по ФИО', () => {
    const sorted = sortTimesheetRows([
      row(1, 'Остриогло', 'view_only', 'ЛИНИЯ-Общестрой'),
      row(2, 'Шапорев', 'view_only', 'Гарантийный отдел'),
      row(3, 'Абдурахманов', 'view_only', 'ЛИНИЯ-Общестрой'),
      row(4, 'Агарков', 'view_only', 'Гарантийный отдел'),
    ]);
    expect(sorted.map(r => r.full_name)).toEqual(['Агарков', 'Шапорев', 'Абдурахманов', 'Остриогло']);
  });

  it('прочие секции сохраняют порядок ответа', () => {
    const sorted = sortTimesheetRows([
      row(1, 'Яковлев', 'direct_report', 'Б'),
      row(2, 'Андреев', 'direct_report', 'А'),
    ]);
    expect(sorted.map(r => r.id)).toEqual([1, 2]);
  });
});
