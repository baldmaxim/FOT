import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// API для ЗУП3 «сотрудники месяца» на настоящем PostgreSQL: выбор закрытых редакций (согласованная / на доработке /
// дубль двух подач), разбивка без снимка, живые дни, бригада, норма без графика, сквозные суммы и одна транзакция
// снимка. Живой табель, графики, режимы, членство и категории замоканы. Запускается только при FOT_TEST_PG_URL —
// ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
const live = vi.hoisted(() => ({ onFetch: null as null | (() => Promise<void>) }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => pg.pool!.query(sql, params as unknown[]);
  return {
    getPool: () => pg.pool,
    pool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withReadOnlySnapshot: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const client = await pg.pool!.connect();
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
});

const OBJ_A = 'aaaaaaaa-0000-4000-8000-00000000000a';
const OBJ_B = 'bbbbbbbb-0000-4000-8000-00000000000b';
const D1 = 'd1000000-0000-4000-8000-000000000001';
const D2 = 'd2000000-0000-4000-8000-000000000002';
const ARCH = 'a0000000-0000-4000-8000-0000000000ac';
const CONTR = 'c0000000-0000-4000-8000-0000000000c0';
const CONTR_CO = 'c1000000-0000-4000-8000-0000000000c1';

vi.mock('./timesheet-export.service.js', () => ({
  fetchTimesheetDataForEmployees: vi.fn(async (_month: string, ids: number[]) => {
    await live.onFetch?.();
    const dataMap = new Map<number, Map<string, { status: string; hours: number }>>();
    const set = (id: number, date: string, status: string, hours: number) => {
      if (!ids.includes(id)) return;
      dataMap.set(id, new Map([...(dataMap.get(id) ?? []), [date, { status, hours }]]));
    };
    set(3, '2026-10-07', 'work', 9);
    set(4, '2026-10-08', 'work', 10); // закрытый день — живым не заменяется
    set(5, '2026-10-09', 'work', 8);
    set(7, '2026-10-06', 'work', 8); // уволен 10.10 — окончательно
    set(8, '2026-10-06', 'work', 8); // подрядчик месяца — не попадает
    set(1, '2026-10-01', 'work', 99); // закрытый день — живым не заменяется
    const entry = (id: number, date: string, objectId: string, hoursWorked: number) => ({
      adjustment_id: null, employee_id: id, work_date: date, object_key: objectId, object_id: objectId,
      object_name: objectId === OBJ_A ? 'ЖК Ситибэй' : 'ЖК Примавера К14', hours_worked: hoursWorked,
      display_hours_worked: hoursWorked, base_hours_worked: hoursWorked, is_correction: false,
    });
    return {
      employees: ids.map(id => ({ id, full_name: `Сотрудник ${id}` })),
      dataMap,
      objectEntries: [entry(4, '2026-10-08', OBJ_A, 3), entry(4, '2026-10-08', OBJ_B, 1), entry(5, '2026-10-09', OBJ_A, 8), entry(3, '2026-10-07', OBJ_B, 9)],
      cutoffByEmployeeId: new Map(),
    };
  }),
}));

vi.mock('./timesheet-export-mode.service.js', async importOriginal => {
  const actual = await importOriginal<typeof import('./timesheet-export-mode.service.js')>();
  return {
    ...actual,
    // 2 — закреплённый объект «ЖК Ситибэй», 6 — «Офис» по отделу (legacy), остальные — по СКУД.
    resolveExportModes: vi.fn(async (ids: number[]) => new Map(ids.map(id => [id,
      id === 2 ? { mode: 'object', pinnedObjectId: OBJ_A, source: 'employee_explicit' }
        : id === 6 ? { mode: 'current_activity', pinnedObjectId: null, source: 'legacy_department' }
          : actual.DEFAULT_EXPORT_MODE]))),
  };
});

const SCHEDULE = {
  schedule_id: 's-5-2', name: '5/2 8 ч', schedule_type: 'office', work_start: '09:00:00', work_end: '18:00:00', work_hours: 8,
  work_days: [1, 2, 3, 4, 5], office_days: null, late_threshold_minutes: 0, day_overrides: null, lunch_minutes: 60,
  respects_holidays: false, pattern_type: '5+2', expected_saturdays_per_month: 1, expected_sundays_per_month: 0,
  full_day_threshold_minutes: null, weekend_full_day_threshold_minutes: null, cycle_length: null, cycle_days: null,
  anchor_date: null, assignment_anchor_date: null, source: 'default',
};

vi.mock('./schedule.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./schedule.service.js')>()),
  loadCalendarMonth: vi.fn(async () => null),
  resolveSchedulesForPeriod: vi.fn(async (employees: Array<{ id: number }>) => new Map(employees.map(({ id }) => {
    const byDate = new Map<string, unknown>();
    for (let day = 1; day <= 31; day++) {
      const date = `2026-10-${String(day).padStart(2, '0')}`;
      // У сотрудника 6 графика нет до 15.10.
      if (id === 6 && day < 15) continue;
      byDate.set(date, SCHEDULE);
    }
    return [id, byDate];
  }))),
}));

vi.mock('./payroll/payroll-staff-category.js', () => ({
  resolveMonthStaffCategories: vi.fn(async (items: Array<{ employeeId: number; officeObject: boolean }>) => (
    items.map(item => (item.officeObject ? 'office' : item.employeeId === 2 ? 'itr' : 'worker'))
  )),
}));

vi.mock('./timesheet-department-assignments.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./timesheet-department-assignments.service.js')>()),
  listEmployeeMembershipsForDepartmentPeriod: vi.fn(async (departmentId: string) => (
    departmentId === D1 ? [{ employee_id: 5, joined_date: null, transferred_out_date: null }] : []
  )),
}));

vi.mock('./employee-archive-department.service.js', () => ({
  getKnownArchiveDepartment: vi.fn(async () => ({ id: ARCH })),
}));

vi.mock('./employee-timesheet-object.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('./employee-timesheet-object.service.js')>()),
  loadTimesheetObjectHours: vi.fn(async () => new Map()),
}));

import { monthBoundsOf } from './staff-month-1c.load.js';
import { buildStaffMonthSnapshot } from './staff-month-1c.snapshot.js';
import { withReadOnlySnapshot } from '../config/postgres.js';

const sql = async (text: string, params: unknown[] = []): Promise<void> => {
  await pg.pool!.query(text, params);
};

const objectsOf = (employeeId: number, rows: Array<[string, Record<string, number>]>) => ({
  employee_id: employeeId,
  objects: rows.map(([id, days]) => ({
    object_id: id, object_key: id, object_name: id === OBJ_A ? 'ЖК Ситибэй' : 'ЖК Примавера К14', object_address: '', days,
  })),
});

const version = async (input: {
  id: number; approval: number; status: string; department: string | null; createdAt: string;
  employees: Array<{ id: number; days: Record<string, { status: string; hours: number }> }>;
  objects?: Array<ReturnType<typeof objectsOf>>;
}): Promise<void> => {
  await sql('INSERT INTO timesheet_approvals (id, status) VALUES ($1, $2)', [input.approval, input.status]);
  await sql(`INSERT INTO timesheet_versions (id, approval_id, department_id, start_date, end_date, revision, created_at, payload)
             VALUES ($1, $2, $3, '2026-10-01', '2026-10-15', 1, $4, $5)`, [
    input.id, input.approval, input.department, input.createdAt,
    JSON.stringify({ employees: input.employees.map(employee => ({ identity: { employee_id: employee.id, full_name: `Сотрудник ${employee.id}` }, days: employee.days })) }),
  ]);
  if (input.objects) {
    await sql(`INSERT INTO timesheet_version_objects (version_id, payload, config_errors, objects_content_hash)
               VALUES ($1, $2::jsonb, '[]'::jsonb, md5($3::text))`, [input.id, JSON.stringify({ employees: input.objects }), String(input.id)]);
  }
};

describe.skipIf(!PG_URL)('staff-month-1c — снимок месяца на PostgreSQL', () => {
  beforeAll(async () => {
    await sql(`DROP TABLE IF EXISTS org_departments, skud_objects, employees, timesheet_approvals, timesheet_versions,
                 timesheet_version_objects, employee_assignments, employee_dismissal_events CASCADE`);
    await sql('CREATE TABLE org_departments (id uuid PRIMARY KEY, parent_id uuid, name text NOT NULL, kind text)');
    await sql('CREATE TABLE skud_objects (id uuid PRIMARY KEY, name text NOT NULL, alt_name text, is_active boolean DEFAULT true)');
    await sql(`CREATE TABLE employees (id int PRIMARY KEY, full_name text, org_department_id uuid, employment_status text DEFAULT 'active',
                 hire_date date, dismissal_date date, is_archived boolean DEFAULT false)`);
    await sql('CREATE TABLE timesheet_approvals (id int PRIMARY KEY, status text, version_dirty_at timestamptz, unlocked_at timestamptz)');
    await sql(`CREATE TABLE timesheet_versions (id int PRIMARY KEY, approval_id int, department_id uuid, start_date date, end_date date,
                 revision int, created_at timestamptz, payload jsonb)`);
    await sql('CREATE TABLE timesheet_version_objects (version_id int PRIMARY KEY, payload jsonb, config_errors jsonb, objects_content_hash text)');
    await sql('CREATE TABLE employee_assignments (employee_id int, org_department_id uuid, effective_from date, effective_to date)');
    await sql(`CREATE TABLE employee_dismissal_events (employee_id int, from_department_id uuid, cancelled boolean DEFAULT false,
                 created_at timestamptz DEFAULT now(), dismissal_date date)`);

    await sql(`INSERT INTO org_departments VALUES ($1, NULL, 'бр.Амонов М.Н.', 'brigade'), ($2, NULL, 'Отдел ПТО', NULL),
                 ($3, NULL, 'Уволенные', NULL), ($4, NULL, 'Подрядные организации', NULL), ($5, $4, 'ООО Подряд', NULL)`,
    [D1, D2, ARCH, CONTR, CONTR_CO]);
    await sql(`INSERT INTO skud_objects VALUES ($1, 'ЖК Ситибэй', 'ул. Ситибэй, 1', true), ($2, 'ЖК Примавера К14', NULL, true)`, [OBJ_A, OBJ_B]);
    await sql(`INSERT INTO employees (id, full_name, org_department_id) VALUES
                 (1, 'Сотрудник 1', $1), (2, 'Сотрудник 2', $2), (3, 'Сотрудник 3', $2), (4, 'Сотрудник 4', $2),
                 (5, 'Сотрудник 5', $1), (6, 'Сотрудник 6', $2)`, [D1, D2]);
    // 7 — уволен 10.10 из отдела; 8 — подрядчик, уволен 10.10 (сейчас в «Уволенных»).
    await sql(`INSERT INTO employees (id, full_name, org_department_id, employment_status, dismissal_date) VALUES
                 (7, 'Сотрудник 7', $1, 'fired', '2026-10-10'), (8, 'Подрядчик 8', $1, 'fired', '2026-10-10')`, [ARCH]);
    await sql(`INSERT INTO employee_dismissal_events (employee_id, from_department_id, dismissal_date) VALUES
                 (7, $1, '2026-10-10'), (8, $2, '2026-10-10')`, [D2, CONTR_CO]);

    // 1 и 6 — бригада, согласовано; у 1 — отпуск с часами нормы на объекте (в снимке, но не в факте).
    await version({
      id: 100, approval: 10, status: 'approved', department: D1, createdAt: '2026-10-16T08:00:00Z',
      employees: [
        { id: 1, days: { '2026-10-01': { status: 'work', hours: 10 }, '2026-10-02': { status: 'vacation', hours: 8 } } },
        { id: 6, days: { '2026-10-01': { status: 'work', hours: 8 } } },
      ],
      objects: [objectsOf(1, [[OBJ_A, { '2026-10-01': 10, '2026-10-02': 8 }]]), objectsOf(6, [[OBJ_B, { '2026-10-01': 8 }]])],
    });
    await version({
      id: 101, approval: 11, status: 'approved', department: D1, createdAt: '2026-11-02T08:00:00Z',
      employees: [{ id: 1, days: { '2026-10-16': { status: 'work', hours: 8 } } }],
      objects: [objectsOf(1, [[OBJ_B, { '2026-10-16': 8 }]])],
    });
    // 2 — один день в двух подачах: берётся более поздняя редакция (6 ч, а не 8).
    await version({
      id: 200, approval: 20, status: 'approved', department: D2, createdAt: '2026-10-16T09:00:00Z',
      employees: [{ id: 2, days: { '2026-10-05': { status: 'work', hours: 8 } } }],
      objects: [objectsOf(2, [[OBJ_A, { '2026-10-05': 8 }]])],
    });
    await version({
      id: 210, approval: 21, status: 'approved', department: null, createdAt: '2026-10-17T09:00:00Z',
      employees: [{ id: 2, days: { '2026-10-05': { status: 'work', hours: 6 } } }],
      objects: [objectsOf(2, [[OBJ_B, { '2026-10-05': 6 }]])],
    });
    // 3 — подача возвращена на доработку: день живой и предварительный.
    await version({
      id: 300, approval: 30, status: 'returned', department: D2, createdAt: '2026-10-16T10:00:00Z',
      employees: [{ id: 3, days: { '2026-10-07': { status: 'work', hours: 8 } } }],
      objects: [objectsOf(3, [[OBJ_A, { '2026-10-07': 8 }]])],
    });
    // 4 — согласованная редакция без объектного снимка: часы официальные, веса — живые проходы.
    await version({
      id: 400, approval: 40, status: 'approved', department: D2, createdAt: '2026-10-16T11:00:00Z',
      employees: [{ id: 4, days: { '2026-10-08': { status: 'work', hours: 10 } } }],
    });
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('снимок: закрытые и живые дни, дубли, бригада, норма, суммы и одна транзакция', async () => {
    // Запись между загрузчиками (во время живого табеля) в снимок не попадает: «Уволенные» с 01.10 у сотрудника 5.
    live.onFetch = async () => {
      await sql(`INSERT INTO employee_assignments VALUES (5, $1, '2026-10-01', NULL)`, [ARCH]);
    };
    const now = new Date('2026-11-19T10:00:00Z');
    const snapshot = await withReadOnlySnapshot(client => buildStaffMonthSnapshot(client, monthBoundsOf('2026-10', now), now));
    const row = (id: number) => snapshot.rows.find(item => item.employee_id === id)!;

    // 8 — подрядчик месяца (отдел увольнения — «Подрядные организации»): в API его нет.
    expect(snapshot.rows.map(item => item.employee_id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(snapshot.meta.duplicate_days).toBe(1);

    // 1: факт — только работа (10 + 8), отпуск — буква с часами нормы, основной объект — как «Свод» (A с отпуском).
    expect(row(1).hours).toBe(18);
    expect(row(1).objects.map(item => [item.object.name, item.hours])).toEqual([['ЖК Примавера К14', 8], ['ЖК Ситибэй', 10]]);
    expect(row(1).object).toMatchObject({ key: OBJ_A, id: OBJ_A, name: 'ЖК Ситибэй', address: 'ул. Ситибэй, 1' });
    expect(row(1).object_source).toBe('hours');
    const vacation = row(1).days.find(day => day.date === '2026-10-02')!;
    expect(vacation).toMatchObject({ status_code: 'vacation', hours: 0, timesheet_hours: 8, objects: [], source: 'closed' });
    expect(row(1).days.find(day => day.date === '2026-10-01')!.hours).toBe(10);

    // 2: дубль — поздняя редакция.
    expect(row(2).hours).toBe(6);
    expect(row(2).object.key).toBe(OBJ_B);

    // 3: на доработке — живой день, предварительно.
    expect(row(3).days.find(day => day.date === '2026-10-07')).toMatchObject({ hours: 9, source: 'live' });
    expect(row(3).preliminary).toBe(true);
    expect(snapshot.preliminary).toBe(true);

    // 4: без снимка — официальные 10 ч по весам 3:1, разбивка не заморожена.
    expect(row(4).hours).toBe(10);
    expect(row(4).objects.map(item => item.hours)).toEqual([2.5, 7.5]);
    expect(row(4).object_frozen).toBe(false);
    expect(snapshot.meta.objects_not_frozen).toBeGreaterThanOrEqual(1);

    // 5: живой день прошлого месяца без закрытой подачи — предварительный; бригада по окну членства; запись во время
    // сборки не видна. 7: уволен в месяце — его живые дни окончательные.
    expect(row(5).preliminary).toBe(true);
    expect(row(7).preliminary).toBe(false);
    expect(row(7).days.find(day => day.date === '2026-10-06')).toMatchObject({ hours: 8, source: 'live' });
    expect(row(5).brigade).toMatchObject({ department_id: D1, name: 'бр.Амонов М.Н.' });
    expect(row(5).days.every(day => day.employed)).toBe(true);

    // 6: графика нет до 15.10 — норма и плановые часы null, не ноль.
    expect(row(6).norm).toMatchObject({ hours: null, days: null, complete: false });
    expect(row(6).days[0]).toMatchObject({ day_kind: null, working_day: null, plan_hours: null });
    expect(row(6).days[20].plan_hours).not.toBeNull();
    // День без табеля.
    expect(row(6).days[2]).toMatchObject({ status_code: null, source: null, hours: 0, objects: [] });

    // Норма с графиком: Σ плановых дней + квота = норма.
    const norm = row(1).norm;
    expect(norm.complete).toBe(true);
    expect(norm.weekend_quota).toEqual({ saturdays: 1, sundays: 0, hours: 8 });
    const plan = row(1).days.reduce((sum, day) => sum + Math.round((day.plan_hours ?? 0) * 100), 0) + 800;
    expect(Math.round(norm.hours! * 100)).toBe(plan);
    expect(row(1).days.find(day => day.date === '2026-10-03')).toMatchObject({ day_kind: 'off', working_day: false, plan_hours: 0 });

    // Бригада: закрытые дни 1 (A 10, B 8) и живой день 5 (A 8) → «ЖК Ситибэй».
    const brigade = snapshot.brigades.find(item => item.department_id === D1)!;
    expect(brigade.object?.name).toBe('ЖК Ситибэй');
    expect(brigade.members).toEqual([{ employee_id: 1, hours: 18 }, { employee_id: 5, hours: 8 }, { employee_id: 6, hours: 8 }]);

    // Сквозные суммы: дни → сотрудник → объекты месяца; бригада.
    const cents = (value: number) => Math.round(value * 100);
    const byObject = new Map<string, number>();
    for (const item of snapshot.rows) {
      const days = item.days.reduce((sum, day) => sum + cents(day.hours), 0);
      expect(days).toBe(cents(item.hours));
      for (const day of item.days) expect(day.objects.reduce((sum, part) => sum + cents(part.hours), 0)).toBe(cents(day.hours));
      for (const part of item.objects) byObject.set(part.object.key, (byObject.get(part.object.key) ?? 0) + cents(part.hours));
    }
    for (const object of snapshot.objects) expect(cents(object.hours)).toBe(byObject.get(object.object.key) ?? 0);
    expect(brigade.objects.reduce((sum, part) => sum + cents(part.hours), 0))
      .toBe(brigade.members.reduce((sum, member) => sum + cents(member.hours), 0));
  });

  it('половины: состав, объект и отдел половины, бригада, норма, суммы половин = месяц, объект табелирования', async () => {
    live.onFetch = null;
    const now = new Date('2026-11-19T10:00:00Z');
    const snapshot = await withReadOnlySnapshot(client => buildStaffMonthSnapshot(client, monthBoundsOf('2026-10', now), now));
    const [first, second] = [snapshot.halves[1], snapshot.halves[2]];
    expect(first.bounds).toMatchObject({ from: '2026-10-01', to: '2026-10-15', started: true, ended: true });
    expect(second.bounds).toMatchObject({ from: '2026-10-16', to: '2026-10-31', started: true, ended: true });
    const rowOf = (view: typeof first, id: number) => view.rows.find(item => item.employee_id === id);

    // Состав: в половине — у кого есть день табеля в её границах.
    expect(first.rows.map(item => item.employee_id)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(second.rows.map(item => item.employee_id)).toEqual([1]);

    // 1: 1–15 — «ЖК Ситибэй» (10 ч работы + отпуск по графику), 16–31 — «ЖК Примавера К14» 8 ч; отдел — подача половины.
    expect(rowOf(first, 1)).toMatchObject({ hours: 10, object: { key: OBJ_A }, object_source: 'hours', department: { id: D1 } });
    expect(rowOf(second, 1)).toMatchObject({ hours: 8, object: { key: OBJ_B }, object_source: 'hours', department: { id: D1 } });
    expect(rowOf(second, 1)!.days.map(day => day.date)).toEqual(
      Array.from({ length: 16 }, (_, index) => `2026-10-${String(16 + index).padStart(2, '0')}`));
    // Дни половины — те же объекты, что в строке месяца (без копий).
    const monthRow = snapshot.rows.find(item => item.employee_id === 1)!;
    expect(rowOf(second, 1)!.days[0]).toBe(monthRow.days[15]);

    // Готовность: 3 и 5 — живые дни прошлого месяца без закрытой подачи; 7 — уволен в месяце, окончательно.
    expect(rowOf(first, 3)!.preliminary).toBe(true);
    expect(rowOf(first, 5)!.preliminary).toBe(true);
    expect(rowOf(first, 7)!.preliminary).toBe(false);
    expect(rowOf(second, 1)!.preliminary).toBe(false);
    expect(first.preliminary).toBe(true);
    expect(second.preliminary).toBe(false);

    // Бригада: 1–15 — 1 (A 10), 5 (A 8), 6 (B 8) → «ЖК Ситибэй»; 16–31 — только 1 (B 8) → «ЖК Примавера К14».
    expect(first.brigades.find(item => item.department_id === D1)?.object?.key).toBe(OBJ_A);
    expect(second.brigades.find(item => item.department_id === D1)?.object?.key).toBe(OBJ_B);
    expect(rowOf(second, 1)!.brigade).toMatchObject({ department_id: D1, object: { key: OBJ_B } });

    // Норма половины: Σ плановых часов дней половины; у 6 графика нет до 15.10 — null.
    expect(rowOf(first, 6)!.norm).toEqual({ hours: null, days: null, complete: false });
    const cents = (value: number) => Math.round(value * 100);
    for (const view of [first, second]) {
      for (const item of view.rows) {
        if (!item.norm.complete) continue;
        expect(cents(item.norm.hours!)).toBe(item.days.reduce((sum, day) => sum + cents(day.plan_hours ?? 0), 0));
      }
    }

    // Суммы: две половины = месяц у каждого сотрудника (часы и объекты); объекты половины = строкам половины.
    for (const item of snapshot.rows) {
      const parts = [rowOf(first, item.employee_id), rowOf(second, item.employee_id)].filter(Boolean);
      expect(parts.reduce((sum, part) => sum + cents(part!.hours), 0)).toBe(cents(item.hours));
      const byKey = new Map<string, number>();
      for (const part of parts) for (const object of part!.objects) byKey.set(object.object.key, (byKey.get(object.object.key) ?? 0) + cents(object.hours));
      expect(Object.fromEntries(byKey)).toEqual(Object.fromEntries(item.objects.map(object => [object.object.key, cents(object.hours)])));
    }
    for (const view of [first, second]) {
      const byObject = new Map<string, number>();
      for (const item of view.rows) for (const part of item.objects) byObject.set(part.object.key, (byObject.get(part.object.key) ?? 0) + cents(part.hours));
      for (const object of view.objects) expect(cents(object.hours)).toBe(byObject.get(object.object.key) ?? 0);
      expect(view.index.get(1)?.mainKey).toBe(rowOf(view, 1)!.object.key);
    }

    // Объект табелирования: закреплённый объект, «Офис» по отделу, по СКУД; у половины — тот же, что у месяца.
    const month = (id: number) => snapshot.rows.find(item => item.employee_id === id)!;
    expect(month(2).timesheet_object).toEqual({
      mode: 'object', object: { key: OBJ_A, id: OBJ_A, name: 'ЖК Ситибэй', address: 'ул. Ситибэй, 1' },
    });
    expect(month(6).timesheet_object).toEqual({ mode: 'office', object: { key: 'office', id: null, name: 'Офис', address: null } });
    expect(month(1).timesheet_object).toEqual({ mode: 'skud', object: null });
    expect(rowOf(first, 2)!.timesheet_object).toEqual(month(2).timesheet_object);
  });
});
