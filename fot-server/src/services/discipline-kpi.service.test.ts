import { beforeEach, describe, expect, it, vi } from 'vitest';

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

vi.mock('./schedule.service.js', () => ({
  loadCalendarMonth: vi.fn().mockResolvedValue(null),
}));

import {
  parseDeviationMinutes,
  severityFromLateCount,
  severityFromShortSick,
  severityFromUnpaidDays,
  maxSeverity,
  isAfterHoliday,
  buildLeaveCases,
  aggregateAttendance,
  getDisciplineKpi,
} from './discipline-kpi.service.js';
import type { IDisciplineResult } from '../types/skud.types.js';

beforeEach(() => {
  pgQuery.mockReset();
});

describe('parseDeviationMinutes', () => {
  it('разбирает форматы fmtMinutes', () => {
    expect(parseDeviationMinutes('+15 мин')).toBe(15);
    expect(parseDeviationMinutes('+1ч')).toBe(60);
    expect(parseDeviationMinutes('+1ч 20м')).toBe(80);
    expect(parseDeviationMinutes('+2ч 5м')).toBe(125);
    expect(parseDeviationMinutes('Отсутствие 3ч 30м')).toBe(210);
  });
});

describe('пороги светофора', () => {
  it('опоздания: 0 зелёный, 1-2 жёлтый, 3+ красный', () => {
    expect(severityFromLateCount(0)).toBe('green');
    expect(severityFromLateCount(1)).toBe('yellow');
    expect(severityFromLateCount(2)).toBe('yellow');
    expect(severityFromLateCount(3)).toBe('red');
  });
  it('короткие больничные: 0-2 зелёный, 3-4 жёлтый, 5+ красный', () => {
    expect(severityFromShortSick(2)).toBe('green');
    expect(severityFromShortSick(3)).toBe('yellow');
    expect(severityFromShortSick(5)).toBe('red');
  });
  it('за свой счёт: ≤14 зелёный, >14 красный', () => {
    expect(severityFromUnpaidDays(14)).toBe('green');
    expect(severityFromUnpaidDays(15)).toBe('red');
  });
  it('maxSeverity берёт максимум', () => {
    expect(maxSeverity(['green', 'yellow', 'green'])).toBe('yellow');
    expect(maxSeverity(['green', 'red', 'yellow'])).toBe('red');
    expect(maxSeverity(['green', 'green'])).toBe('green');
  });
});

describe('isAfterHoliday', () => {
  it('старт сразу после праздника → true', () => {
    expect(isAfterHoliday('2026-03-10', new Set(['2026-03-09']))).toBe(true);
  });
  it('шаг назад через выходные до праздника → true', () => {
    // 23.03.2026 Пн ← 22 Вс ← 21 Сб ← 20 Пт (праздник)
    expect(isAfterHoliday('2026-03-23', new Set(['2026-03-20']))).toBe(true);
  });
  it('обычный будень перед стартом → false', () => {
    expect(isAfterHoliday('2026-03-11', new Set(['2026-03-09']))).toBe(false);
  });
});

describe('buildLeaveCases', () => {
  it('группирует по leave_request и помечает задним числом', () => {
    const cases = buildLeaveCases(
      [
        { date: '2026-03-02', leaveId: '5' },
        { date: '2026-03-03', leaveId: '5' },
        { date: '2026-03-04', leaveId: '5' },
      ],
      new Set(),
      new Map([['5', { createdDate: '2026-03-05', startDate: '2026-03-02' }]]),
    );
    expect(cases).toHaveLength(1);
    expect(cases[0].days).toBe(3);
    expect(cases[0].isShort).toBe(true);
    expect(cases[0].isMonFri).toBe(true); // 02.03.2026 — понедельник
    expect(cases[0].retroactive).toBe(true);
  });

  it('ручные дни без заявления → непрерывные серии', () => {
    const cases = buildLeaveCases(
      [
        { date: '2026-03-10', leaveId: null },
        { date: '2026-03-11', leaveId: null },
        { date: '2026-03-13', leaveId: null },
      ],
      new Set(),
      new Map(),
    );
    expect(cases).toHaveLength(2);
    expect(cases[0].days).toBe(2);
    expect(cases[1].days).toBe(1);
    expect(cases.every(c => c.retroactive === false)).toBe(true);
  });
});

describe('aggregateAttendance', () => {
  it('считает типы и сумму минут опозданий', () => {
    const discipline: IDisciplineResult = {
      employees: { 101: { full_name: 'Иванов', position: null, department_id: 'd1', worked_hours: 120, norm_hours: 160 } },
      departments: { d1: 'Отдел 1' },
      violations: [
        { employee_id: 101, date: '2026-03-02', type: 'late', first_entry: '09:10', last_exit: null, total_hours: 8, deviation: '+10 мин' },
        { employee_id: 101, date: '2026-03-03', type: 'late', first_entry: '09:20', last_exit: null, total_hours: 8, deviation: '+20 мин' },
        { employee_id: 101, date: '2026-03-04', type: 'early', first_entry: '09:00', last_exit: '16:00', total_hours: 7, deviation: '-1ч' },
        { employee_id: 999, date: '2026-03-04', type: 'late', first_entry: '10:00', last_exit: null, total_hours: 6, deviation: '+1ч' },
      ],
    };
    const agg = aggregateAttendance(101, discipline);
    expect(agg.lateCount).toBe(2);
    expect(agg.lateMinutes).toBe(30);
    expect(agg.earlyCount).toBe(1);
    expect(agg.workedHours).toBe(120);
    expect(agg.normHours).toBe(160);
  });
});

describe('getDisciplineKpi (оркестрация)', () => {
  const discipline: IDisciplineResult = {
    employees: {
      101: { full_name: 'Иванов', position: null, department_id: 'd1', worked_hours: 0, norm_hours: 0 },
      102: { full_name: 'Петров', position: null, department_id: 'd1', worked_hours: 0, norm_hours: 0 },
      103: { full_name: 'Сидоров', position: null, department_id: 'd1', worked_hours: 0, norm_hours: 0 },
    },
    departments: { d1: 'Отдел 1' },
    violations: [
      { employee_id: 101, date: '2026-03-02', type: 'late', first_entry: '09:10', last_exit: null, total_hours: 8, deviation: '+10 мин' },
      { employee_id: 101, date: '2026-03-03', type: 'late', first_entry: '09:10', last_exit: null, total_hours: 8, deviation: '+10 мин' },
      { employee_id: 101, date: '2026-03-04', type: 'late', first_entry: '09:10', last_exit: null, total_hours: 8, deviation: '+10 мин' },
      { employee_id: 101, date: '2026-03-05', type: 'early', first_entry: '09:00', last_exit: '16:00', total_hours: 7, deviation: '-1ч' },
    ],
  };

  const mockLeaveQueries = () => {
    pgQuery.mockImplementation((sql: string) => {
      if (sql.includes('work_date::text')) {
        return Promise.resolve([
          // emp101 — больничный 02–06.03 (5 дн, короткий), заявление 7
          ...['2026-03-02', '2026-03-03', '2026-03-04', '2026-03-05', '2026-03-06'].map(d => ({
            employee_id: 101, work_date: d, status: 'sick', approval_status: 'approved', source_type: 'leave_request', source_id: '7',
          })),
          // emp101 — больничный на согласовании (pending) — НЕ должен влиять на светофор
          { employee_id: 101, work_date: '2026-03-12', status: 'sick', approval_status: 'pending', source_type: 'leave_request', source_id: '8' },
          // emp102 — за свой счёт 10–12.03, заявление 9
          ...['2026-03-10', '2026-03-11', '2026-03-12'].map(d => ({
            employee_id: 102, work_date: d, status: 'unpaid', approval_status: 'approved', source_type: 'leave_request', source_id: '9',
          })),
          // emp103 — только pending больничный
          { employee_id: 103, work_date: '2026-03-09', status: 'sick', approval_status: 'pending', source_type: 'leave_request', source_id: '10' },
        ]);
      }
      if (sql.includes('COUNT(*)::int AS days')) {
        return Promise.resolve([{ employee_id: 102, days: 16 }]); // превышение лимита 14
      }
      if (sql.includes('FROM leave_requests')) {
        return Promise.resolve([
          { id: 7, created_date: '2026-03-01', start_date: '2026-03-02' }, // заранее
          { id: 9, created_date: '2026-03-15', start_date: '2026-03-10' }, // задним числом
        ]);
      }
      return Promise.resolve([]);
    });
  };

  it('агрегирует отдел: светофор, pending отдельно, лимит unpaid', async () => {
    mockLeaveQueries();
    const result = await getDisciplineKpi({
      scope: 'department',
      subject: 'Отдел 1',
      startMonth: '2026-03',
      endMonth: '2026-03',
      metrics: ['attendance', 'sick', 'unpaid'],
      employeeIds: [101, 102, 103],
      discipline,
    });

    expect(result.totals.attendance).toMatchObject({ lateCount: 3, lateMinutes: 30, earlyCount: 1 });
    expect(result.totals.sick).toMatchObject({ totalDays: 5, caseCount: 1, shortCaseCount: 1, monFriCount: 1 });
    expect(result.totals.unpaid).toMatchObject({ totalDays: 3, caseCount: 1, retroactiveCaseCount: 1, overLimitEmployees: 1 });
    // pending по обоим больничным (emp101 + emp103), без влияния на светофор
    expect(result.totals.pending.sickDays).toBe(2);

    const emp101 = result.rows.find(r => r.employeeId === 101);
    const emp102 = result.rows.find(r => r.employeeId === 102);
    const emp103 = result.rows.find(r => r.employeeId === 103);

    expect(emp101?.severity).toBe('red'); // 3 опоздания
    expect(emp102?.unpaid?.overLimit).toBe(true);
    expect(emp102?.severity).toBe('red'); // 16 > 14
    expect(emp103?.severity).toBe('green'); // только pending → не влияет
    expect(emp103?.pending.sickDays).toBe(1);
    expect(result.overallSeverity).toBe('red');
  });

  it('attendance-only: не трогает БД заявлений, возвращает строку с нулями', async () => {
    const result = await getDisciplineKpi({
      scope: 'employee',
      subject: 'Петров',
      startMonth: '2026-03',
      endMonth: '2026-03',
      metrics: ['attendance'],
      employeeIds: [102],
      discipline,
    });
    expect(pgQuery).not.toHaveBeenCalled();
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0].attendance).toMatchObject({ lateCount: 0, severity: 'green' });
    expect(result.rows[0].sick).toBeNull();
    expect(result.overallSeverity).toBe('green');
  });
});
