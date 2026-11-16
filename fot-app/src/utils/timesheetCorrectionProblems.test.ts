import { describe, expect, it } from 'vitest';

import type { TimesheetEmployee, TimesheetEntry } from '../types';
import {
  CORRECTION_NEEDED_LABEL,
  timesheetCorrectionProblems,
  UNDERWORK_TITLE,
  WEEKEND_TITLE,
  ZERO_HOURS_TITLE,
} from './timesheetCorrectionProblems';

// Без графика: выходные — суббота и воскресенье, порог полного дня — 8 ч. Ноябрь 2026: 1-е — воскресенье.
const employee = (id: number, extra: Partial<TimesheetEmployee> = {}): TimesheetEmployee => (
  { id, full_name: `Сотрудник ${id}`, ...extra } as TimesheetEmployee
);
const entry = (employeeId: number, date: string, hours: number, extra: Partial<TimesheetEntry> = {}): TimesheetEntry => ({
  id: null,
  employee_id: employeeId,
  work_date: date,
  status: 'work',
  hours_worked: hours,
  display_hours_worked: hours,
  is_correction: false,
  first_entry: '08:00:00',
  last_exit: '15:00:00',
  ...extra,
} as TimesheetEntry);

const run = (input: {
  employees?: TimesheetEmployee[];
  entries?: TimesheetEntry[];
  weekendMissing?: Array<{ employee_id: number; date: string; without_hours: boolean }>;
  year?: number;
  month?: number;
  todayIso?: string;
}) => timesheetCorrectionProblems({
  employees: input.employees ?? [employee(1)],
  entries: input.entries ?? [],
  weekendMissing: input.weekendMissing ?? [],
  calendar: null,
  year: input.year ?? 2026,
  month: input.month ?? 11,
  showActualHours: true,
  todayIso: input.todayIso ?? '2026-11-16',
});

describe('timesheetCorrectionProblems', () => {
  it('«Неполный» будний день без корректировки — рамка, подсказка и метка «без корр.»', () => {
    const result = run({ entries: [entry(1, '2026-11-02', 7), entry(1, '2026-11-03', 8)] });
    expect([...result.keys]).toEqual(['1_2026-11-02']);
    expect(result.titles.get('1_2026-11-02')).toBe(UNDERWORK_TITLE);
    expect(result.badges.get(1)).toEqual([{ text: '1 без корр.', title: CORRECTION_NEEDED_LABEL }]);
  });

  it('с корректировкой — без рамки, даже если часов меньше графика', () => {
    expect(run({ entries: [entry(1, '2026-11-02', 6, { is_correction: true })] }).keys.size).toBe(0);
  });

  it('сегодня и дальше — без рамки', () => {
    expect(run({ entries: [entry(1, '2026-11-16', 3), entry(1, '2026-11-17', 3)] }).keys.size).toBe(0);
  });

  it('до ноября 2026 — без рамок', () => {
    const result = run({ month: 10, entries: [entry(1, '2026-10-05', 3)], todayIso: '2026-11-16' });
    expect(result.keys.size).toBe(0);
  });

  it('вне окна строки (после перевода, до входа) — без рамки', () => {
    const result = run({
      employees: [employee(1, { transferred_out_date: '2026-11-04' }), employee(2, { joined_date: '2026-11-10' })],
      entries: [entry(1, '2026-11-03', 5), entry(1, '2026-11-05', 5), entry(2, '2026-11-05', 5), entry(2, '2026-11-10', 5)],
    });
    expect([...result.keys].sort()).toEqual(['1_2026-11-03', '2_2026-11-10']);
  });

  it('«СКУД без пары» в будни (проход есть, 0 ч) — рамка с подсказкой про 0 часов и меткой «без часов»', () => {
    const result = run({ entries: [entry(1, '2026-11-02', 0, { last_exit: null })] });
    expect(result.titles.get('1_2026-11-02')).toBe(ZERO_HOURS_TITLE);
    expect(result.badges.get(1)).toEqual([{ text: '1 без часов', title: ZERO_HOURS_TITLE }]);
  });

  it('нет записи (неявка без СКУД) — рамки нет', () => {
    expect(run({ entries: [] }).keys.size).toBe(0);
  });

  it('выходной: рамка только с сервера, проход без часов — подсказка про 0 часов', () => {
    const result = run({
      entries: [entry(1, '2026-11-07', 3)],
      weekendMissing: [
        { employee_id: 1, date: '2026-11-08', without_hours: false },
        { employee_id: 1, date: '2026-11-14', without_hours: true },
        { employee_id: 9, date: '2026-11-08', without_hours: false },
      ],
    });
    expect([...result.keys].sort()).toEqual(['1_2026-11-08', '1_2026-11-14']);
    expect(result.titles.get('1_2026-11-08')).toBe(WEEKEND_TITLE);
    expect(result.titles.get('1_2026-11-14')).toBe(ZERO_HOURS_TITLE);
    expect(result.badges.get(1)).toEqual([
      { text: '1 без корр.', title: CORRECTION_NEEDED_LABEL },
      { text: '1 без часов', title: ZERO_HOURS_TITLE },
    ]);
  });

  it('выходной с сервера на сегодняшний день — без рамки', () => {
    const result = run({ todayIso: '2026-11-14', weekendMissing: [{ employee_id: 1, date: '2026-11-14', without_hours: false }] });
    expect(result.keys.size).toBe(0);
  });
});
