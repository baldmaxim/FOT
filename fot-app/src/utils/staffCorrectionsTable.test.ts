import { describe, expect, it } from 'vitest';

import type { IStaffCorrectionTableRow } from './staffCorrectionsTable';
import {
  authorText,
  buildStaffCorrectionsExport,
  differenceHours,
  formatChangedAt,
  formatCorrectionHours,
  NO_OBJECT_PASSES_TEXT,
  SKUD_PENDING_TEXT,
  skudText,
  STAFF_CORRECTION_COLUMNS,
} from './staffCorrectionsTable';

const row = (extra: Partial<IStaffCorrectionTableRow> = {}): IStaffCorrectionTableRow => ({
  id: 1,
  branch_id: 'line',
  employee_id: 10,
  full_name: 'Пахомов В. В.',
  work_date: '2026-11-06',
  status: 'manual',
  hours: 10,
  source: 'table',
  window: 'day',
  object_id: null,
  object_name: null,
  author_name: 'Иванов И. И.',
  applicant_name: null,
  changed_at: '2026-11-07T07:15:00.000Z',
  reason: 'вышел позже',
  attachments_count: 1,
  skud: { norm_hours: 8, skud_hours: 6.5, first_entry: '08:12:00', last_exit: '15:20:00' },
  ...extra,
});

const cell = (key: string, value: IStaffCorrectionTableRow): string => (
  STAFF_CORRECTION_COLUMNS.find(column => column.key === key)!.text(value)
);

describe('таблица «Корректировки»', () => {
  it('часы: целые без минут, дробные — ч:мм', () => {
    expect(formatCorrectionHours(10)).toBe('10');
    expect(formatCorrectionHours(6.5)).toBe('6:30');
    expect(formatCorrectionHours(-1.5)).toBe('−1:30');
    expect(formatCorrectionHours(null)).toBe('—');
  });

  it('по СКУД: часы и вход–выход; пока считается — «…»; объект без проходов — словами', () => {
    expect(skudText(row())).toBe('6:30 (08:12–15:20)');
    expect(skudText(row({ skud: null }))).toBe(SKUD_PENDING_TEXT);
    expect(skudText(row({ window: 'object', object_id: 'o', skud: { norm_hours: 8, skud_hours: 0, first_entry: null, last_exit: null } })))
      .toBe(NO_OBJECT_PASSES_TEXT);
    expect(skudText(row({ window: 'object', object_id: 'o', skud: { norm_hours: 8, skud_hours: 4.25, first_entry: null, last_exit: null } })))
      .toBe('4:15');
  });

  it('разница «правка − СКУД» со знаком', () => {
    expect(differenceHours(row())).toBe(3.5);
    expect(cell('difference', row())).toBe('+3:30');
    expect(cell('difference', row({ hours: 6 }))).toBe('−0:30');
    expect(cell('difference', row({ skud: null }))).toBe(SKUD_PENDING_TEXT);
  });

  it('корректировка — часы, тип отдельно; источник и автор; у заявления — согласовавший и подавший', () => {
    expect(cell('hours', row())).toBe('10');
    expect(cell('status', row())).toBe('Корректировка табеля');
    expect(cell('source', row())).toBe('Табель');
    expect(authorText(row())).toBe('Иванов И. И.');
    const fromRequest = row({ source: 'request', author_name: 'Иванов И. И.', applicant_name: 'Пахомов В. В.' });
    expect(cell('source', fromRequest)).toBe('Заявление');
    expect(authorText(fromRequest)).toBe('Иванов И. И. (согласовал), подал Пахомов В. В.');
  });

  it('время правки — по МСК', () => {
    expect(formatChangedAt('2026-11-07T07:15:00.000Z')).toBe('07.11 10:15');
  });

  it('экспорт — ровно переданные строки в порядке экрана, столбцы экрана с «№»', () => {
    const snapshot = buildStaffCorrectionsExport([row({ id: 2, full_name: 'Б' }), row({ id: 1, full_name: 'А' })], '2026-11', 'ЛИНИЯ');
    expect(snapshot.title).toBe('Корректировки руководителей — ЛИНИЯ');
    expect(snapshot.columns.map(column => column.label)).toEqual(['№', ...STAFF_CORRECTION_COLUMNS.map(column => column.label)]);
    expect(snapshot.rows.map(item => item.cells[1])).toEqual(['Б', 'А']);
    expect(snapshot.file_name).toBe('Корректировки ЛИНИЯ 2026-11.xlsx');
  });
});
