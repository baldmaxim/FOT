import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Характеризующий (parity) тест getDisciplineViolations.
 *
 * Фиксирует точное поведение ДО оптимизации выборки. Логика правил (опоздание/
 * недоработка/ранний уход/отсутствие) и резолв графиков НЕ меняются — меняется
 * только способ выборки skud_daily_summary (убирается OFFSET-пагинация, фильтр
 * активных сотрудников уходит в SQL). resolveQuery в моке поддерживает обе формы
 * запроса (старую постраничную и новую одиночную) — ожидания неизменны.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./schedule.service.js', () => ({
  resolveSchedulesBulk: vi.fn(async () => new Map()),
  getEffectiveLateThreshold: vi.fn(() => '09:00:00'),
  getScheduleForDate: vi.fn(() => ({ work_start: '09:00:00', work_end: '18:00:00', work_hours: 8 })),
  needsSkudCheck: vi.fn(() => true),
  loadCalendarMonth: vi.fn(async () => null),
  countNormHoursForSchedule: vi.fn(() => 0),
}));

type EmployeeRow = {
  id: number;
  full_name: string;
  position_id: string | null;
  org_department_id: string | null;
  is_archived: boolean;
  employment_status: string;
};
type SummaryRow = {
  employee_id: number;
  date: string;
  first_entry: string | null;
  last_exit: string | null;
  total_hours: number | null;
  is_present: boolean;
};

const mockedState = vi.hoisted(() => ({
  employees: [] as EmployeeRow[],
  summaries: [] as SummaryRow[],
  depts: [] as Array<{ id: string; name: string }>,
  positions: [] as Array<{ id: string; name: string }>,
}));

import { getDisciplineViolations } from './skud-discipline.service.js';

function passesPrefilter(s: SummaryRow): boolean {
  // (first_entry > '09:00:00' OR total_hours < 8)
  const lateish = s.first_entry !== null && s.first_entry > '09:00:00';
  const short = s.total_hours !== null && s.total_hours < 8;
  return lateish || short;
}

function resolveQuery(sql: string, params: unknown[]): unknown[] {
  if (/FROM\s+employees\b/i.test(sql)) {
    return mockedState.employees.filter(
      e => !e.is_archived && e.employment_status === 'active',
    );
  }
  if (/FROM\s+org_departments\b/i.test(sql)) {
    return mockedState.depts;
  }
  if (/FROM\s+positions\b/i.test(sql)) {
    const ids = (params[0] as string[]) ?? [];
    return mockedState.positions.filter(p => ids.includes(p.id));
  }
  if (/FROM\s+skud_daily_summary\b/i.test(sql)) {
    const start = params[0] as string;
    const end = params[1] as string;
    // Агрегатный запрос фактических часов (SUM ... GROUP BY) — без violation-прекоарса.
    if (/SUM\(total_hours\)/i.test(sql)) {
      const empIds = new Set((params[2] as number[]) ?? []);
      const byEmp = new Map<number, number>();
      for (const s of mockedState.summaries) {
        if (!s.is_present || s.date < start || s.date > end || !empIds.has(s.employee_id)) continue;
        byEmp.set(s.employee_id, (byEmp.get(s.employee_id) ?? 0) + (s.total_hours ?? 0));
      }
      return [...byEmp.entries()].map(([employee_id, worked]) => ({ employee_id, worked }));
    }
    const hasEmpFilter = /employee_id\s*=\s*ANY/i.test(sql);
    const empIds = hasEmpFilter ? new Set((params[4] as number[]) ?? []) : null;

    let rows = mockedState.summaries.filter(
      s =>
        s.is_present &&
        s.date >= start &&
        s.date <= end &&
        passesPrefilter(s) &&
        (!empIds || empIds.has(s.employee_id)),
    );
    rows = [...rows].sort((a, b) =>
      a.date === b.date ? a.employee_id - b.employee_id : a.date < b.date ? -1 : 1,
    );

    const limitMatch = /LIMIT\s+(\d+)/i.exec(sql);
    const offsetMatch = /OFFSET\s+(\d+)/i.exec(sql);
    if (limitMatch) {
      const limit = Number(limitMatch[1]);
      const offset = offsetMatch ? Number(offsetMatch[1]) : 0;
      rows = rows.slice(offset, offset + limit);
    }
    return rows.map(s => ({
      employee_id: s.employee_id,
      date: s.date,
      first_entry: s.first_entry,
      last_exit: s.last_exit,
      total_hours: s.total_hours,
      is_present: s.is_present,
    }));
  }
  return [];
}

describe('skud-discipline.service (parity / характеризующий)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T09:30:00+03:00'));
    mockedState.employees = [
      { id: 1, full_name: 'Иванов', position_id: 'p1', org_department_id: 'd1', is_archived: false, employment_status: 'active' },
      { id: 2, full_name: 'Петров', position_id: null, org_department_id: 'd1', is_archived: false, employment_status: 'active' },
      { id: 99, full_name: 'Уволенный', position_id: 'p1', org_department_id: 'd1', is_archived: true, employment_status: 'active' },
    ];
    mockedState.positions = [{ id: 'p1', name: 'Менеджер' }];
    mockedState.depts = [{ id: 'd1', name: 'Отдел 1' }];
    mockedState.summaries = [
      // emp1, не сегодня: опоздание + недоработка + ранний уход
      { employee_id: 1, date: '2026-04-10', first_entry: '09:30:00', last_exit: '17:00:00', total_hours: 6, is_present: true },
      // emp2, не сегодня: недоработка + ранний уход (не опоздал)
      { employee_id: 2, date: '2026-04-15', first_entry: '08:50:00', last_exit: '13:00:00', total_hours: 3, is_present: true },
      // emp1, СЕГОДНЯ (isToday): только опоздание (остальные правила пропускаются)
      { employee_id: 1, date: '2026-04-17', first_entry: '09:45:00', last_exit: null, total_hours: 2, is_present: true },
      // не проходит прекоарс-фильтр → не возвращается запросом
      { employee_id: 2, date: '2026-04-08', first_entry: '09:00:00', last_exit: '18:00:00', total_hours: 8, is_present: true },
      // неактивный сотрудник 500 → отфильтрован (старый код — в JS, новый — в SQL)
      { employee_id: 500, date: '2026-04-12', first_entry: '10:00:00', last_exit: '12:00:00', total_hours: 2, is_present: true },
    ];
    pgQuery.mockReset();
    pgQuery.mockImplementation(async (sql: string, params: unknown[] = []) =>
      resolveQuery(sql, params),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('считает нарушения, исключает неактивных/сегодняшние и сортирует по дате desc', async () => {
    const res = await getDisciplineViolations({ startMonth: '2026-04', endMonth: '2026-04' });

    expect(res.violations).toEqual([
      { employee_id: 1, date: '2026-04-17', type: 'late', first_entry: '09:45:00', last_exit: null, total_hours: 2, deviation: '+45 мин' },
      { employee_id: 2, date: '2026-04-15', type: 'underwork', first_entry: '08:50:00', last_exit: '13:00:00', total_hours: 3, deviation: '-5ч' },
      { employee_id: 2, date: '2026-04-15', type: 'early', first_entry: '08:50:00', last_exit: '13:00:00', total_hours: 3, deviation: '-4ч 50м' },
      { employee_id: 1, date: '2026-04-10', type: 'late', first_entry: '09:30:00', last_exit: '17:00:00', total_hours: 6, deviation: '+30 мин' },
      { employee_id: 1, date: '2026-04-10', type: 'underwork', first_entry: '09:30:00', last_exit: '17:00:00', total_hours: 6, deviation: '-2ч' },
      { employee_id: 1, date: '2026-04-10', type: 'early', first_entry: '09:30:00', last_exit: '17:00:00', total_hours: 6, deviation: '-1ч 30м' },
    ]);

    expect(res.employees).toEqual({
      1: { full_name: 'Иванов', position: 'Менеджер', department_id: 'd1', worked_hours: 8, norm_hours: 0 },
      2: { full_name: 'Петров', position: null, department_id: 'd1', worked_hours: 11, norm_hours: 0 },
    });
    expect(res.departments).toEqual({ d1: 'Отдел 1' });
  });
});
