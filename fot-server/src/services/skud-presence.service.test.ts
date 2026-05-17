import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Характеризующий (parity) тест getPresence.
 *
 * Назначение: зафиксировать ТОЧНОЕ числовое поведение текущей реализации ДО
 * переноса агрегации в SQL. Ожидаемые значения вычислены вручную из исходной
 * JS-логики (computeExitMetrics, fallback total_hours, punctuality, сортировка
 * по статусу). После рефакторинга в SQL правится только симуляция запросов в
 * resolveQuery — ожидаемые значения остаются неизменными => паритет гарантирован.
 */

const { pgQuery } = vi.hoisted(() => ({ pgQuery: vi.fn() }));

vi.mock('../config/postgres.js', () => ({
  query: pgQuery,
  queryOne: vi.fn(),
  execute: vi.fn(),
  withTransaction: vi.fn(),
}));

type EmployeeRow = {
  id: number;
  full_name: string;
  org_department_id: string | null;
  position_id: string | null;
  is_archived: boolean;
  employment_status: string;
};
type EventRow = {
  employee_id: number;
  event_date: string;
  event_time: string;
  direction: 'entry' | 'exit';
  access_point: string | null;
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
  events: [] as EventRow[],
  summaries: [] as SummaryRow[],
  depts: [] as Array<{ id: string; parent_id: string | null; name: string }>,
  positions: [] as Array<{ id: string; name: string }>,
  internalPoints: new Set<string>(),
}));

vi.mock('./skud-shared.service.js', () => ({
  getAllDepartmentsTree: vi.fn(async () =>
    mockedState.depts.map(d => ({ ...d, sigur_department_id: null })),
  ),
  getInternalAccessPoints: vi.fn(async () => mockedState.internalPoints),
}));

import { getPresence, invalidatePresenceCache } from './skud-presence.service.js';

/**
 * Симулирует текущие SQL-запросы getPresence на in-memory фикстурах.
 * При переносе агрегации в SQL менять ТОЛЬКО эту функцию (не ожидания тестов).
 */
function resolveQuery(sql: string, params: unknown[]): unknown[] {
  if (/FROM\s+employees\b/i.test(sql)) {
    const hasDeptFilter = /org_department_id\s*=\s*ANY/i.test(sql);
    const deptIds = hasDeptFilter ? ((params[0] as string[]) ?? []) : null;
    return mockedState.employees.filter(
      e =>
        !e.is_archived &&
        e.employment_status === 'active' &&
        (!deptIds || (e.org_department_id != null && deptIds.includes(e.org_department_id))),
    );
  }
  if (/FROM\s+org_departments\b/i.test(sql)) {
    const ids = (params[0] as string[]) ?? [];
    return mockedState.depts.filter(d => ids.includes(d.id)).map(d => ({ id: d.id, name: d.name }));
  }
  if (/FROM\s+positions\b/i.test(sql)) {
    const ids = (params[0] as string[]) ?? [];
    return mockedState.positions.filter(p => ids.includes(p.id));
  }
  if (/FROM\s+skud_events\b/i.test(sql)) {
    // Новый SQL: внутренние точки отфильтрованы запросом ($3), порядок ASC.
    const date = params[0] as string;
    const empIds = new Set((params[1] as number[]) ?? []);
    const internalArr = (params[2] as string[] | null) ?? null;
    return mockedState.events
      .filter(e => {
        if (e.event_date !== date || !empIds.has(e.employee_id)) return false;
        if (internalArr && e.access_point && e.access_point !== '' && internalArr.includes(e.access_point)) {
          return false;
        }
        return true;
      })
      .sort((a, b) =>
        a.employee_id !== b.employee_id
          ? a.employee_id - b.employee_id
          : a.event_time < b.event_time ? -1 : a.event_time > b.event_time ? 1 : 0,
      )
      .map(e => ({
        employee_id: e.employee_id,
        event_time: e.event_time,
        direction: e.direction,
        access_point: e.access_point,
      }));
  }
  if (/FROM\s+skud_daily_summary\b/i.test(sql)) {
    const isMonth = /GROUP\s+BY\s+employee_id/i.test(sql);
    if (isMonth) {
      const start = params[0] as string;
      const end = params[1] as string;
      const empIds = new Set((params[2] as number[]) ?? []);
      const agg = new Map<number, { total: number; on_time: number }>();
      for (const s of mockedState.summaries) {
        if (!s.is_present || s.date < start || s.date > end || !empIds.has(s.employee_id)) continue;
        let rec = agg.get(s.employee_id);
        if (!rec) {
          rec = { total: 0, on_time: 0 };
          agg.set(s.employee_id, rec);
        }
        rec.total++;
        if (s.first_entry !== null && s.first_entry <= '09:00:00') rec.on_time++;
      }
      return [...agg.entries()].map(([employee_id, r]) => ({
        employee_id,
        total: r.total,
        on_time: r.on_time,
      }));
    }
    const date = params[0] as string;
    const empIds = new Set((params[1] as number[]) ?? []);
    return mockedState.summaries
      .filter(s => s.date === date && empIds.has(s.employee_id))
      .map(s => ({
        employee_id: s.employee_id,
        first_entry: s.first_entry,
        total_hours: s.total_hours,
      }));
  }
  return [];
}

describe('skud-presence.service (parity / характеризующий)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-17T09:30:00+03:00'));
    mockedState.employees = [];
    mockedState.events = [];
    mockedState.summaries = [];
    mockedState.positions = [];
    mockedState.internalPoints = new Set();
    mockedState.depts = [{ id: 'dept-1', parent_id: null, name: 'Отдел 1' }];
    pgQuery.mockReset();
    pgQuery.mockImplementation(async (sql: string, params: unknown[] = []) =>
      resolveQuery(sql, params),
    );
    invalidatePresenceCache();
  });

  afterEach(() => {
    invalidatePresenceCache();
    vi.useRealTimers();
  });

  it('возвращает [] когда нет активных сотрудников', async () => {
    const res = await getPresence({ departmentId: 'dept-1' });
    expect(res).toEqual([]);
  });

  it('считает статусы, метрики, fallback total_hours, пунктуальность и сортировку', async () => {
    mockedState.internalPoints = new Set(['Внутренняя']);
    mockedState.positions = [{ id: 'pos-1', name: 'Менеджер' }];
    mockedState.employees = [
      { id: 1, full_name: 'Иванов', org_department_id: 'dept-1', position_id: 'pos-1', is_archived: false, employment_status: 'active' },
      { id: 2, full_name: 'Петров', org_department_id: 'dept-1', position_id: 'pos-1', is_archived: false, employment_status: 'active' },
      { id: 3, full_name: 'Сидоров', org_department_id: 'dept-1', position_id: null, is_archived: false, employment_status: 'active' },
      { id: 4, full_name: 'Архивный', org_department_id: 'dept-1', position_id: 'pos-1', is_archived: true, employment_status: 'active' },
    ];

    mockedState.events = [
      // emp1: вход 09:00, выход 12:00, вход 12:30, внутренняя 13:00 (исключается)
      { employee_id: 1, event_date: '2026-04-17', event_time: '09:00:00', direction: 'entry', access_point: 'КПП' },
      { employee_id: 1, event_date: '2026-04-17', event_time: '12:00:00', direction: 'exit', access_point: 'КПП' },
      { employee_id: 1, event_date: '2026-04-17', event_time: '12:30:00', direction: 'entry', access_point: 'КПП' },
      { employee_id: 1, event_date: '2026-04-17', event_time: '13:00:00', direction: 'entry', access_point: 'Внутренняя' },
      // emp2: только выход 09:00
      { employee_id: 2, event_date: '2026-04-17', event_time: '09:00:00', direction: 'exit', access_point: 'КПП' },
      // emp3: только вход 09:15 (открытый — fallback по МСК-now)
      { employee_id: 3, event_date: '2026-04-17', event_time: '09:15:00', direction: 'entry', access_point: 'КПП' },
    ];

    mockedState.summaries = [
      // emp1 — today summary с total_hours (fallback не нужен)
      { employee_id: 1, date: '2026-04-17', first_entry: '08:59:00', last_exit: null, total_hours: 7.5, is_present: true },
      // emp2 — today summary, total_hours = 0 → fallback (вернёт null т.к. нет пары)
      { employee_id: 2, date: '2026-04-17', first_entry: '08:55:00', last_exit: '09:00:00', total_hours: 0, is_present: true },
      // emp1 месяц (вкл. today-строку 2026-04-17 08:59 is_present): 5 строк, onTime 4 → 80%
      { employee_id: 1, date: '2026-04-01', first_entry: '08:50:00', last_exit: '18:00:00', total_hours: 8, is_present: true },
      { employee_id: 1, date: '2026-04-02', first_entry: '09:00:00', last_exit: '18:00:00', total_hours: 8, is_present: true },
      { employee_id: 1, date: '2026-04-03', first_entry: '09:30:00', last_exit: '18:00:00', total_hours: 8, is_present: true },
      { employee_id: 1, date: '2026-04-06', first_entry: '09:00:00', last_exit: '18:00:00', total_hours: 8, is_present: true },
      // emp3 месяц: 2 дня → onTime 1/2 = 50%
      { employee_id: 3, date: '2026-04-01', first_entry: '09:00:00', last_exit: '18:00:00', total_hours: 8, is_present: true },
      { employee_id: 3, date: '2026-04-02', first_entry: '09:05:00', last_exit: '18:00:00', total_hours: 8, is_present: true },
    ];

    const res = await getPresence({ departmentId: 'dept-1' });

    // Архивный исключён; сортировка по статусу: online(0) перед offline(1) (стабильная).
    expect(res).toEqual([
      {
        employee_id: 1,
        full_name: 'Иванов',
        department_name: 'Отдел 1',
        position_name: 'Менеджер',
        status: 'online',
        since: '12:30:00',
        first_entry: '09:00:00',
        total_hours: 7.5,
        exit_count: 1,
        time_outside_minutes: 30,
        last_access_point: 'КПП',
        punctuality_percent: 80,
      },
      {
        employee_id: 3,
        full_name: 'Сидоров',
        department_name: 'Отдел 1',
        position_name: null,
        status: 'online',
        since: '09:15:00',
        first_entry: '09:15:00',
        total_hours: 0.25,
        exit_count: 0,
        time_outside_minutes: 0,
        last_access_point: 'КПП',
        punctuality_percent: 50,
      },
      {
        employee_id: 2,
        full_name: 'Петров',
        department_name: 'Отдел 1',
        position_name: 'Менеджер',
        status: 'offline',
        since: '09:00:00',
        first_entry: '08:55:00',
        total_hours: null,
        exit_count: 1,
        time_outside_minutes: 30,
        last_access_point: 'КПП',
        punctuality_percent: 100,
      },
    ]);
  });

  it('пара-матчинг: несколько выходов подряд + закрытые пары для fallback total_hours', async () => {
    mockedState.employees = [
      { id: 7, full_name: 'Бегунов', org_department_id: 'dept-1', position_id: null, is_archived: false, employment_status: 'active' },
    ];
    // ASC: вход 08:00, выход 10:00, выход 11:00, вход 12:00, выход 13:00, вход 14:00 (открыт)
    mockedState.events = [
      { employee_id: 7, event_date: '2026-04-17', event_time: '08:00:00', direction: 'entry', access_point: 'КПП' },
      { employee_id: 7, event_date: '2026-04-17', event_time: '10:00:00', direction: 'exit', access_point: 'КПП' },
      { employee_id: 7, event_date: '2026-04-17', event_time: '11:00:00', direction: 'exit', access_point: 'КПП' },
      { employee_id: 7, event_date: '2026-04-17', event_time: '12:00:00', direction: 'entry', access_point: 'КПП' },
      { employee_id: 7, event_date: '2026-04-17', event_time: '13:00:00', direction: 'exit', access_point: 'КПП' },
      { employee_id: 7, event_date: '2026-04-17', event_time: '14:00:00', direction: 'entry', access_point: 'КПП' },
    ];
    // нет today-summary → total_hours через fallback пара-матчинг

    const res = await getPresence({ departmentId: 'dept-1' });
    expect(res).toEqual([
      {
        employee_id: 7,
        full_name: 'Бегунов',
        department_name: 'Отдел 1',
        position_name: null,
        status: 'online',
        since: '14:00:00',
        first_entry: '08:00:00',
        total_hours: 3,
        exit_count: 3,
        time_outside_minutes: 120,
        last_access_point: 'КПП',
        punctuality_percent: null,
      },
    ]);
  });

  it('сотрудник без событий → статус unknown', async () => {
    mockedState.employees = [
      { id: 10, full_name: 'Безсобытий', org_department_id: 'dept-1', position_id: null, is_archived: false, employment_status: 'active' },
    ];
    const res = await getPresence({ departmentId: 'dept-1' });
    expect(res).toEqual([
      {
        employee_id: 10,
        full_name: 'Безсобытий',
        department_name: 'Отдел 1',
        position_name: null,
        status: 'unknown',
        since: null,
        first_entry: null,
        total_hours: null,
        exit_count: 0,
        time_outside_minutes: 0,
        last_access_point: null,
        punctuality_percent: null,
      },
    ]);
  });
});
