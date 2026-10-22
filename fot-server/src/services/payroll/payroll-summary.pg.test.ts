import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Свод» на «Расчётах» на настоящем PostgreSQL: «Оплачено» за месяцы, объект из объектной разбивки табеля
// (последняя редакция подачи, «Текущая деятельность» → «Офис», «СКУД» → основной объект), запасной путь
// через режим табелирования, категория по табелю месяца (не из условий), охват и подрядчики.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются). Гонять отдельно от
// других *.pg.test.ts: они дропают те же таблицы.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const pool = () => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool;
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await pool().query(sql, params as unknown[])).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) =>
      (await pool().query(sql, params as unknown[])).rows[0] ?? null,
  };
});

// Режим табелирования месяца — своя большая схема (фиксация 288, окно 291); здесь он подставляется.
const modes = vi.hoisted(() => ({ byEmployee: new Map<number, unknown>(), calls: [] as Array<{ ids: number[]; month: unknown }> }));
vi.mock('../timesheet-export-mode.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../timesheet-export-mode.service.js')>()),
  resolveExportModes: async (ids: number[], _exec: unknown, options?: { month?: string }) => {
    modes.calls.push({ ids, month: options?.month });
    return new Map(ids.filter(id => modes.byEmployee.has(id)).map(id => [id, modes.byEmployee.get(id)]));
  },
}));

import { listPayrollSummaryMonths, loadPayrollSummary } from './payroll-summary.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
const run = (sql: string, params?: unknown[]) => pg.pool!.query(sql, params);

const LINE = '00000000-0000-0000-0000-0000000000d1'; // ЛИНИЯ — ИТР
const ACCOUNTING = '00000000-0000-0000-0000-0000000000d2'; // Бухгалтерия — офис
const FIRED = '00000000-0000-0000-0000-0000000000d3'; // Уволенные
const CONTRACTORS = '00000000-0000-0000-0000-0000000000c0';
const CONTRACTOR_CO = '00000000-0000-0000-0000-0000000000c1';
const KHIMKI = '00000000-0000-0000-0000-00000000000a';
const MYTISHCHI = '00000000-0000-0000-0000-00000000000b';
const OFFICE_POLKOVAYA = '00000000-0000-0000-0000-0000000000f1';
const SCOPE = { contractorRootId: CONTRACTORS, departmentIds: null };
// Бригады СУ-10 — как в структуре: «Объект» → СУ-10 → «Бригады» → бригада.
const TECH_ROOT = '00000000-0000-0000-0000-0000000000b0';
const SU10_ROOT = '2cd8a403-6454-408b-9c2b-8a2db65c7511';
const BRIGADES_FOLDER = '00000000-0000-0000-0000-0000000000b1';
const BRIGADE = '00000000-0000-0000-0000-0000000000b2';
const AUTO = '00000000-0000-0000-0000-0000000000d4'; // Отдел автотехники — офис по отделу
const ROLE_WORKER = '00000000-0000-0000-0000-0000000000a1';
const ROLE_OFFICE = '00000000-0000-0000-0000-0000000000a2';

/** Подача: последняя редакция побеждает; payload — сотрудники с объектами. */
const version = async (
  id: number,
  approvalId: number,
  revision: number,
  departmentId: string | null,
  startDate: string,
  employees: Array<{ employee_id: number; objects: Array<{ key: string; id: string | null; name: string; address: string; hours: number }> }>,
) => {
  await run(
    `INSERT INTO timesheet_versions (id, approval_id, revision, department_id, start_date, end_date)
     VALUES ($1, $2, $3, $4, $5::date, ($5::date + 14))`,
    [id, approvalId, revision, departmentId, startDate],
  );
  await run('INSERT INTO timesheet_version_objects (version_id, payload) VALUES ($1, $2::jsonb)', [id, JSON.stringify({
    employees: employees.map(employee => ({
      employee_id: employee.employee_id,
      mode: 'skud',
      total_hours: employee.objects.reduce((sum, object) => sum + object.hours, 0),
      objects: employee.objects.map(object => ({
        object_id: object.id, object_key: object.key, object_name: object.name, object_address: object.address,
        total_hours: object.hours, days: {},
      })),
    })),
  })]);
};

const paid = (employeeId: number, month: string, item: string, amount: number) =>
  run('INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES ($1, $2, $3, $4)', [employeeId, month, item, amount]);

describe.skipIf(!PG_URL)('«Свод» на PostgreSQL', () => {
  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS timesheet_version_objects, timesheet_versions, skud_objects, payroll_paid_amounts,
        payroll_compensation_terms, payroll_compensation_stops, payroll_one_time_supplements, payroll_planned_supplements,
        payroll_settings, payroll_item_types, payroll_rates, payroll_employee_deductions, payroll_deduction_kinds,
        employee_schedule_assignments, work_schedules, positions, user_profiles, system_roles,
        employee_dismissal_events, timesheet_object_auto_state, employees, org_departments CASCADE;
      DROP FUNCTION IF EXISTS public.get_descendant_department_ids(uuid[]);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, parent_id uuid, kind text);
      CREATE TABLE positions (id uuid PRIMARY KEY, name text);
      CREATE TABLE employees (
        id integer PRIMARY KEY,
        full_name text,
        org_department_id uuid REFERENCES org_departments(id),
        position_id uuid REFERENCES positions(id),
        employment_status text NOT NULL DEFAULT 'active',
        is_archived boolean NOT NULL DEFAULT false
      );
      CREATE TABLE system_roles (id uuid PRIMARY KEY, code text NOT NULL);
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text, employee_id integer, system_role_id uuid);
      CREATE TABLE employee_dismissal_events (
        id serial PRIMARY KEY, employee_id integer NOT NULL, from_department_id uuid,
        cancelled boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE timesheet_object_auto_state (
        singleton boolean PRIMARY KEY DEFAULT true, enabled boolean NOT NULL, baseline_month date NOT NULL,
        frozen_month date NOT NULL, objects_rebuilt_month date NOT NULL, applied_date date
      );
      -- Базовая фиксация — август: июль и август до авторасчёта, сентябрь — в его эпохе.
      INSERT INTO timesheet_object_auto_state VALUES (true, true, '2026-08-01', '2026-09-01', '2026-09-01', '2026-09-30');
      CREATE TABLE skud_objects (id uuid PRIMARY KEY, name text NOT NULL, alt_name text);
      CREATE TABLE timesheet_versions (
        id bigint PRIMARY KEY, approval_id bigint NOT NULL, revision int NOT NULL,
        department_id uuid, start_date date NOT NULL, end_date date NOT NULL
      );
      CREATE TABLE timesheet_version_objects (version_id bigint PRIMARY KEY REFERENCES timesheet_versions(id), payload jsonb NOT NULL);
      CREATE FUNCTION public.get_descendant_department_ids(uuid[]) RETURNS TABLE(id uuid)
        LANGUAGE sql AS $$
          SELECT d.id FROM org_departments d WHERE d.id = ANY($1) OR d.parent_id = ANY($1)
        $$;
      INSERT INTO org_departments (id, name, parent_id) VALUES
        ('${LINE}', 'ЛИНИЯ', NULL),
        ('${ACCOUNTING}', 'Бухгалтерия', NULL),
        ('${FIRED}', 'Уволенные', NULL),
        ('${CONTRACTORS}', 'Подрядные организации', NULL),
        ('${CONTRACTOR_CO}', 'ООО Подрядчик', '${CONTRACTORS}'),
        ('${AUTO}', 'Отдел автотехники', NULL);
      INSERT INTO org_departments (id, name, parent_id, kind) VALUES
        ('${TECH_ROOT}', 'Объект', NULL, 'object'),
        ('${SU10_ROOT}', '(СУ-10) ООО СУ-10', '${TECH_ROOT}', 'department'),
        ('${BRIGADES_FOLDER}', 'Бригады', '${SU10_ROOT}', 'department'),
        ('${BRIGADE}', 'бр.Тестовая', '${BRIGADES_FOLDER}', 'brigade');
      INSERT INTO positions (id, name) VALUES ('00000000-0000-0000-0000-0000000000e1', 'Прораб');
      INSERT INTO employees (id, full_name, org_department_id, position_id, employment_status, is_archived) VALUES
        (1, 'Акимов Прораб', '${LINE}', '00000000-0000-0000-0000-0000000000e1', 'active', false),
        (2, 'Борисова Бухгалтер', '${ACCOUNTING}', NULL, 'active', false),
        (3, 'Васильев Уволенный', '${FIRED}', NULL, 'dismissed', true),
        (4, 'Григорьев Без табеля', '${ACCOUNTING}', NULL, 'active', false),
        (5, 'Дмитриев Подрядчик', '${CONTRACTOR_CO}', NULL, 'active', false),
        (6, 'Егоров Рабочий', '${ACCOUNTING}', NULL, 'active', false),
        (7, 'Жуков Бригадник', '${BRIGADE}', NULL, 'active', false),
        (8, 'Зайцев Уволенный бригадник', '${FIRED}', NULL, 'fired', false),
        (9, 'Ильин Рабочий в офисе', '${AUTO}', NULL, 'active', false),
        (10, 'Козлов Закреплённый рабочий', '${AUTO}', NULL, 'active', false),
        (11, 'Лебедев Рабочий автотехники', '${AUTO}', NULL, 'active', false),
        (12, 'Морозов Сентябрь', '${AUTO}', NULL, 'active', false);
      INSERT INTO system_roles (id, code) VALUES ('${ROLE_WORKER}', 'worker'), ('${ROLE_OFFICE}', 'office');
      INSERT INTO user_profiles (id, full_name, employee_id, system_role_id) VALUES
        ('00000000-0000-0000-0000-000000000109', 'Ильин', 9, '${ROLE_WORKER}'),
        ('00000000-0000-0000-0000-000000000110', 'Козлов', 10, '${ROLE_WORKER}'),
        ('00000000-0000-0000-0000-000000000111', 'Лебедев', 11, '${ROLE_WORKER}'),
        ('00000000-0000-0000-0000-000000000112', 'Морозов', 12, '${ROLE_OFFICE}');
      -- Зайцев уволен из бригады: отмена старого увольнения не считается.
      INSERT INTO employee_dismissal_events (employee_id, from_department_id, cancelled, created_at) VALUES
        (8, '${ACCOUNTING}', true, '2026-07-20'),
        (8, '${BRIGADE}', false, '2026-07-25');
      INSERT INTO skud_objects (id, name, alt_name) VALUES
        ('${KHIMKI}', 'ЖК Химки', 'Химки, ул. Ленина, 1'),
        ('${MYTISHCHI}', 'ЖК Мытищи', 'Мытищи'),
        ('${OFFICE_POLKOVAYA}', 'Офис Полковая', 'Текущая деятельность');
    `);
    for (const name of [
      '271_payroll_terms.sql', '282_payroll_terms_bonus_housing.sql', '286_payroll_terms_compensations.sql',
      '295_payroll_paid_amounts.sql', '297_payroll_paid_groups.sql', '298_payroll_paid_drop_payouts.sql',
      '299_payroll_deduction_kinds.sql', '301_payroll_paid_order_kinds.sql',
    ]) {
      await run(migration(name));
    }

    // Июль. Подача ЛИНИИ: ревизия 1 устарела (весь Акимов на Мытищах), в ревизии 2 — Химки 100 ч + Мытищи 60 ч.
    await version(1, 10, 1, LINE, '2026-07-01', [
      { employee_id: 1, objects: [{ key: MYTISHCHI, id: MYTISHCHI, name: 'ЖК Мытищи (старое имя)', address: 'Мытищи', hours: 160 }] },
    ]);
    await version(2, 10, 2, LINE, '2026-07-01', [
      { employee_id: 1, objects: [
        { key: KHIMKI, id: KHIMKI, name: 'ЖК Химки', address: 'Химки', hours: 100 },
        { key: MYTISHCHI, id: MYTISHCHI, name: 'ЖК Мытищи', address: 'Мытищи', hours: 60 },
      ] },
      // Уволенный: в июле работал в ЛИНИИ, сейчас — в «Уволенных».
      { employee_id: 3, objects: [{ key: MYTISHCHI, id: MYTISHCHI, name: 'ЖК Мытищи', address: 'Мытищи', hours: 80 }] },
    ]);
    // Бухгалтерия: «Текущая деятельность» и офисный объект — одна группа «Офис».
    await version(3, 11, 1, ACCOUNTING, '2026-07-16', [
      { employee_id: 2, objects: [
        { key: '__current_activity__', id: null, name: 'Текущая деятельность', address: 'Текущая деятельность', hours: 40 },
        { key: OFFICE_POLKOVAYA, id: OFFICE_POLKOVAYA, name: 'Офис Полковая', address: 'Текущая деятельность', hours: 40 },
        { key: KHIMKI, id: KHIMKI, name: 'ЖК Химки', address: 'Химки', hours: 60 },
      ] },
      { employee_id: 6, objects: [{ key: KHIMKI, id: KHIMKI, name: 'ЖК Химки', address: 'Химки', hours: 100 }] },
    ]);

    await paid(1, '2026-07-01', 'contract', 100000);
    await paid(1, '2026-07-01', 'travel', 3000.5);
    await paid(1, '2026-07-01', 'meals', 1200);
    await paid(2, '2026-07-01', 'contract', 80000);
    await paid(3, '2026-07-01', 'contract', 50000);
    await paid(3, '2026-07-01', 'recalc_prev', -2500.25);
    await paid(4, '2026-07-01', 'contract', 40000);
    await paid(5, '2026-07-01', 'contract', 30000);
    await paid(6, '2026-07-01', 'contract', 45000);
    await paid(6, '2026-07-01', 'bonus', 0);
    // Август: только Акимов, табеля за август нет — запасной путь.
    await paid(1, '2026-08-01', 'contract', 100000);

    // Категория по табелю. Июль (до авторасчёта) — правило рабочих по отделу месяца.
    await version(4, 12, 1, BRIGADE, '2026-07-01', [
      { employee_id: 7, objects: [{ key: KHIMKI, id: KHIMKI, name: 'ЖК Химки', address: 'Химки', hours: 150 }] },
    ]);
    // Персональная подача уволенного бригадника — отдела подачи нет, отдел — из увольнения.
    await version(5, 13, 1, null, '2026-07-16', [
      { employee_id: 8, objects: [{ key: MYTISHCHI, id: MYTISHCHI, name: 'ЖК Мытищи', address: 'Мытищи', hours: 100 }] },
    ]);
    await version(6, 14, 1, AUTO, '2026-07-01', [
      { employee_id: 9, objects: [
        { key: OFFICE_POLKOVAYA, id: OFFICE_POLKOVAYA, name: 'Офис Полковая', address: 'Текущая деятельность', hours: 160 },
      ] },
      { employee_id: 10, objects: [{ key: KHIMKI, id: KHIMKI, name: 'ЖК Химки', address: 'Химки', hours: 100 }] },
      { employee_id: 11, objects: [{ key: MYTISHCHI, id: MYTISHCHI, name: 'ЖК Мытищи', address: 'Мытищи', hours: 120 }] },
    ]);
    // Сентябрь — эпоха авторасчёта: рабочий — по режиму месяца skud/auto, роль учётки не спрашивается.
    await version(7, 15, 1, AUTO, '2026-09-01', [
      { employee_id: 12, objects: [{ key: KHIMKI, id: KHIMKI, name: 'ЖК Химки', address: 'Химки', hours: 100 }] },
    ]);
    for (const id of [7, 8, 9, 10, 11]) await paid(id, '2026-07-01', 'contract', 10000 * id);
    await paid(12, '2026-09-01', 'contract', 120000);
    modes.byEmployee.set(10, { mode: 'object', pinnedObjectId: KHIMKI, source: 'employee_explicit', windowPin: true });
    modes.byEmployee.set(12, { mode: 'skud', pinnedObjectId: null, source: 'employee_explicit', setBy: 'auto' });

    // Егоров по отделу — офис, в условиях июля — «Рабочие»: снимок условий категорию не решает.
    await run(`
      INSERT INTO payroll_compensation_terms (employee_id, staff_category, calc_type, hourly_rate, effective_from, effective_to)
      VALUES (6, 'office', 'hourly', 400, '2026-06-01', '2026-07-14'),
             (6, 'worker', 'hourly', 450, '2026-07-15', NULL)
    `);
    modes.byEmployee.set(4, { mode: 'object', pinnedObjectId: MYTISHCHI, source: 'employee_explicit' });
    modes.byEmployee.set(1, { mode: 'current_activity', pinnedObjectId: null, source: 'employee_explicit' });
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('июль: объект, «Офис», основной объект, последняя редакция; уволенный и подрядчик', async () => {
    const summary = await loadPayrollSummary({ scope: SCOPE, monthStarts: ['2026-07-01'] });
    expect(summary.months).toEqual(['2026-07']);
    const rows = summary.rows
      .filter(row => row.employee_id <= 6)
      .map(row => [row.employee_id, row.object_name, row.category, row.department, row.amounts]);
    // Порядок: объект («ЖК Мытищи» < «ЖК Химки» < «Офис»), затем ФИО.
    expect(rows).toEqual([
      [3, 'ЖК Мытищи', 'itr', 'ЛИНИЯ', { contract: '50000.00', recalc_prev: '-2500.25' }],
      [4, 'ЖК Мытищи', 'office', 'Бухгалтерия', { contract: '40000.00' }],
      [1, 'ЖК Химки', 'itr', 'ЛИНИЯ', { contract: '100000.00', meals: '1200.00', travel: '3000.50' }],
      [6, 'ЖК Химки', 'office', 'Бухгалтерия', { bonus: '0.00', contract: '45000.00' }],
      [2, 'Офис', 'office', 'Бухгалтерия', { contract: '80000.00' }],
    ]);
  });

  it('категория по табелю месяца: рабочие, «Офис» первым, закреплённый в окне — не рабочий', async () => {
    const july = await loadPayrollSummary({ scope: SCOPE, monthStarts: ['2026-07-01'] });
    const rows = july.rows
      .filter(row => row.employee_id >= 7)
      .map(row => [row.employee_id, row.object_name, row.category, row.department]);
    expect(rows).toEqual([
      [8, 'ЖК Мытищи', 'worker', 'бр.Тестовая'],
      [11, 'ЖК Мытищи', 'worker', 'Отдел автотехники'],
      [7, 'ЖК Химки', 'worker', 'бр.Тестовая'],
      [10, 'ЖК Химки', 'office', 'Отдел автотехники'],
      [9, 'Офис', 'office', 'Отдел автотехники'],
    ]);

    const september = await loadPayrollSummary({ scope: SCOPE, monthStarts: ['2026-09-01'] });
    expect(september.rows.map(row => [row.employee_id, row.object_name, row.category])).toEqual([[12, 'ЖК Химки', 'worker']]);
  });

  it('режим месяца — одним запросом на месяц; без разбивки объект из режима', async () => {
    modes.calls.length = 0;
    const summary = await loadPayrollSummary({ scope: SCOPE, monthStarts: ['2026-08-01'] });
    expect(modes.calls).toEqual([{ ids: [1], month: '2026-08' }]);
    expect(summary.rows.map(row => [row.employee_id, row.object_key, row.object_name])).toEqual([[1, 'office', 'Офис']]);
  });

  it('весь период: суммы по сотруднику, объекту и категории за каждый месяц', async () => {
    const summary = await loadPayrollSummary({ scope: SCOPE, monthStarts: null });
    expect(summary.months).toEqual(['2026-07', '2026-08', '2026-09']);
    const akimov = summary.rows.filter(row => row.employee_id === 1).map(row => [row.object_name, row.amounts.contract]);
    expect(akimov).toEqual([['ЖК Химки', '100000.00'], ['Офис', '100000.00']]);
  });

  it('охват: текущий отдел или отдел подачи месяца; месяцы — в том же охвате', async () => {
    const line = { contractorRootId: CONTRACTORS, departmentIds: [LINE] };
    const summary = await loadPayrollSummary({ scope: line, monthStarts: ['2026-07-01'] });
    // Уволенный сейчас в «Уволенных», но в июле — в подаче ЛИНИИ.
    expect(summary.rows.map(row => row.employee_id).sort()).toEqual([1, 3]);

    const accounting = { contractorRootId: CONTRACTORS, departmentIds: [ACCOUNTING] };
    expect(await listPayrollSummaryMonths(accounting)).toEqual(['2026-07']);
    expect(await listPayrollSummaryMonths(SCOPE)).toEqual(['2026-07', '2026-08', '2026-09']);
    expect(await listPayrollSummaryMonths({ ...SCOPE, departmentIds: [] })).toEqual([]);
    expect(await listPayrollSummaryMonths({ ...SCOPE, departmentIds: [CONTRACTOR_CO] })).toEqual([]);
  });
});
