import { describe, expect, it } from 'vitest';
import type { TimesheetEmployee } from '../types/timesheet';
import { leftAfterPeriod, sortTimesheetRows } from './timesheetRowOrder';

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

describe('sortTimesheetRows: уволенные и переведённые — по показанному периоду', () => {
  const OCT_END = '2026-10-31';
  const firedOn = (id: number, full_name: string, dismissal: string, leftOn: string): TimesheetEmployee => (
    row(id, full_name, 'department', 'Уволенные', {
      org_department_id: FIRED_DEPT,
      employment_status: 'fired',
      dismissal_date: dismissal,
      transferred_out_date: leftOn,
    })
  );
  const movedOn = (id: number, full_name: string, leftOn: string): TimesheetEmployee => (
    row(id, full_name, 'department', 'Сметный отдел', { org_department_id: 'smeta', transferred_out_date: leftOn })
  );

  it('уволенный в следующем месяце — среди своих в порядке ответа, с отделом табеля', () => {
    const sorted = sortTimesheetRows([
      firedOn(1, 'Абдуназаров', '2026-11-02', '2026-11-03'),
      member(2, 'Карамышев'),
      firedOn(3, 'Маматкулов', '2026-10-26', '2026-10-27'),
      firedOn(4, 'Мирзаев', '2026-11-13', '2026-11-14'),
      member(5, 'Пардаев'),
    ], { departmentId: TENDER, periodEnd: OCT_END });
    expect(sorted.map(r => r.id)).toEqual([1, 2, 4, 5, 3]);
    expect(sorted.map(r => r.department_name)).toEqual([
      'Тендерный отдел', 'Тендерный отдел', 'Тендерный отдел', 'Тендерный отдел', 'Уволенные',
    ]);
  });

  it('подпись меняется только у отдела: статус, отдел и даты строки — как в ответе', () => {
    const source = firedOn(1, 'Мирзаев', '2026-11-13', '2026-11-14');
    const [result] = sortTimesheetRows([source, member(2, 'Пардаев')], { departmentId: TENDER, periodEnd: OCT_END });
    expect(result).toEqual({ ...source, department_name: 'Тендерный отдел' });
    expect(source.department_name).toBe('Уволенные');
  });

  it('уволенный в последний день периода — в блоке уволенных', () => {
    const sorted = sortTimesheetRows([
      firedOn(1, 'Абдуназаров', '2026-10-31', '2026-11-01'),
      member(2, 'Карамышев'),
    ], { departmentId: TENDER, periodEnd: OCT_END });
    expect(sorted.map(r => r.id)).toEqual([2, 1]);
    expect(sorted[1].department_name).toBe('Уволенные');
  });

  it('половина месяца: уволенный 22.10 в «1–15» — свой, в «16–31» — внизу', () => {
    const rows = [firedOn(1, 'Абдуназаров', '2026-10-22', '2026-10-23'), member(2, 'Карамышев')];
    expect(sortTimesheetRows(rows, { departmentId: TENDER, periodEnd: '2026-10-15' }).map(r => r.id)).toEqual([1, 2]);
    expect(sortTimesheetRows(rows, { departmentId: TENDER, periodEnd: OCT_END }).map(r => r.id)).toEqual([2, 1]);
  });

  it('уволенный без дат — внизу, как раньше', () => {
    const sorted = sortTimesheetRows([fired(1, 'Абдуназаров'), member(2, 'Карамышев')], {
      departmentId: TENDER,
      periodEnd: OCT_END,
    });
    expect(sorted.map(r => r.id)).toEqual([2, 1]);
  });

  it('переведённый после периода — свой; переведённый в периоде — в блоке переведённых', () => {
    const sorted = sortTimesheetRows([
      movedOn(1, 'Абрамов', '2026-11-05'),
      movedOn(2, 'Борисов', '2026-10-20'),
      member(3, 'Васильев'),
    ], { departmentId: TENDER, periodEnd: OCT_END });
    expect(sorted.map(r => r.id)).toEqual([1, 3, 2]);
    expect(sorted.map(r => r.department_name)).toEqual(['Тендерный отдел', 'Тендерный отдел', 'Сметный отдел']);
  });

  it('без своих строк подпись — из имени отдела табеля', () => {
    const sorted = sortTimesheetRows([firedOn(1, 'Мирзаев', '2026-11-13', '2026-11-14')], {
      departmentId: TENDER,
      departmentName: 'бр.Менгбоев Г.И.',
      periodEnd: OCT_END,
    });
    expect(sorted[0].department_name).toBe('бр.Менгбоев Г.И.');
  });

  it('без конца периода — прежний порядок: уволенные внизу', () => {
    const sorted = sortTimesheetRows([
      firedOn(1, 'Абдуназаров', '2026-11-02', '2026-11-03'),
      member(2, 'Карамышев'),
    ], { departmentId: TENDER });
    expect(sorted.map(r => r.id)).toEqual([2, 1]);
    expect(sorted[1].department_name).toBe('Уволенные');
  });

  it('другие секции не трогает: уволенный позже среди «Мои сотрудники» — внизу секции', () => {
    const later = row(1, 'Абрамов', 'direct_report', 'Уволенные', {
      employment_status: 'fired',
      dismissal_date: '2026-11-13',
      transferred_out_date: '2026-11-14',
    });
    expect(leftAfterPeriod(later, OCT_END)).toBe(false);
    const sorted = sortTimesheetRows([later, row(2, 'Борисов', 'direct_report', 'ЛИНИЯ')], { periodEnd: OCT_END });
    expect(sorted.map(r => r.id)).toEqual([2, 1]);
  });
});
