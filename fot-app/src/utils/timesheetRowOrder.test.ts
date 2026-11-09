import { describe, expect, it } from 'vitest';
import type { TimesheetEmployee } from '../types/timesheet';
import { sortTimesheetRows } from './timesheetRowOrder';

const row = (
  id: number,
  full_name: string,
  source: TimesheetEmployee['source'],
  department_name: string | null = null,
  extra: Partial<TimesheetEmployee> = {},
): TimesheetEmployee => ({
  id,
  full_name,
  source,
  department_name,
  position_id: null,
  position_name: null,
  org_department_id: null,
  employment_status: 'active',
  ...extra,
} as TimesheetEmployee);

const TENDER = 'tender-dept';
const FIRED_DEPT = 'fired-folder';
const member = (id: number, full_name: string): TimesheetEmployee => (
  row(id, full_name, 'department', 'Тендерный отдел', { org_department_id: TENDER })
);
const fired = (id: number, full_name: string): TimesheetEmployee => (
  row(id, full_name, 'department', 'Уволенные', { org_department_id: FIRED_DEPT, employment_status: 'fired' })
);
const moved = (id: number, full_name: string, department: string): TimesheetEmployee => (
  row(id, full_name, 'department', department, { org_department_id: department })
);

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

  it('уволенные — одним блоком в конце секции отдела, свои — в порядке ответа', () => {
    const sorted = sortTimesheetRows([
      fired(1, 'Карамышев'),
      member(2, 'Коваленко'),
      fired(3, 'Козлов'),
      member(4, 'Кузьмин'),
    ], { departmentId: TENDER });
    expect(sorted.map(r => r.id)).toEqual([2, 4, 1, 3]);
  });

  it('переведённые — блоками по новому отделу между своими и уволенными', () => {
    const sorted = sortTimesheetRows([
      moved(1, 'Абрамов', 'Сметный отдел'),
      fired(2, 'Борисов'),
      member(3, 'Васильев'),
      moved(4, 'Гусев', 'Ведущие'),
      moved(5, 'Дёмин', 'Сметный отдел'),
      member(6, 'Егоров'),
    ], { departmentId: TENDER });
    expect(sorted.map(r => r.id)).toEqual([3, 6, 4, 1, 5, 2]);
  });

  it('без отдела табеля переведённых не выделяет, уволенных — вниз', () => {
    const sorted = sortTimesheetRows([
      moved(1, 'Абрамов', 'Сметный отдел'),
      fired(2, 'Борисов'),
      member(3, 'Васильев'),
    ]);
    expect(sorted.map(r => r.id)).toEqual([1, 3, 2]);
  });

  it('уволенный в другой секции не уходит из неё', () => {
    const sorted = sortTimesheetRows([
      fired(1, 'Абрамов'),
      row(2, 'Борисов', 'direct_report', 'ЛИНИЯ', { employment_status: 'fired' }),
      row(3, 'Васильев', 'direct_report', 'ЛИНИЯ'),
      member(4, 'Гусев'),
    ], { departmentId: TENDER });
    expect(sorted.map(r => r.id)).toEqual([3, 2, 4, 1]);
  });

  it('«Только просмотр»: уволенные последними, остальные по отделу и ФИО', () => {
    const sorted = sortTimesheetRows([
      row(1, 'Агарков', 'view_only', 'Уволенные', { employment_status: 'fired' }),
      row(2, 'Шапорев', 'view_only', 'ЛИНИЯ'),
      row(3, 'Бачу', 'view_only', 'Гарантийный отдел'),
    ], { departmentId: TENDER });
    expect(sorted.map(r => r.id)).toEqual([3, 2, 1]);
  });
});
