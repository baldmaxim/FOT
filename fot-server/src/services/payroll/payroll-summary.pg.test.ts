import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Свод» на «Расчётах» на настоящем PostgreSQL: «Оплачено» за месяцы, объект из объектной разбивки табеля
// (последняя редакция подачи, «Текущая деятельность» → «Офис», «СКУД» → основной объект), запасной путь
// через режим табелирования, категория из условий или по отделу месяца, охват и подрядчики.
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
        employee_schedule_assignments, work_schedules, positions, user_profiles, employees, org_departments CASCADE;
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
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
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
        ('${CONTRACTOR_CO}', 'ООО Подрядчик', '${CONTRACTORS}');
      INSERT INTO positions (id, name) VALUES ('00000000-0000-0000-0000-0000000000e1', 'Прораб');
      INSERT INTO employees (id, full_name, org_department_id, position_id, employment_status, is_archived) VALUES
        (1, 'Акимов Прораб', '${LINE}', '00000000-0000-0000-0000-0000000000e1', 'active', false),
        (2, 'Борисова Бухгалтер', '${ACCOUNTING}', NULL, 'active', false),
        (3, 'Васильев Уволенный', '${FIRED}', NULL, 'dismissed', true),
        (4, 'Григорьев Без табеля', '${ACCOUNTING}', NULL, 'active', false),
        (5, 'Дмитриев Подрядчик', '${CONTRACTOR_CO}', NULL, 'active', false),
        (6, 'Егоров Рабочий', '${ACCOUNTING}', NULL, 'active', false);
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

    // Егоров по отделу — офис, но в условиях июля — «Рабочие» (последняя версия, пересекающая месяц).
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
    const rows = summary.rows.map(row => [row.employee_id, row.object_name, row.category, row.department, row.amounts]);
    // Порядок: объект («ЖК Мытищи» < «ЖК Химки» < «Офис»), затем ФИО.
    expect(rows).toEqual([
      [3, 'ЖК Мытищи', 'itr', 'ЛИНИЯ', { contract: '50000.00', recalc_prev: '-2500.25' }],
      [4, 'ЖК Мытищи', 'office', 'Бухгалтерия', { contract: '40000.00' }],
      [1, 'ЖК Химки', 'itr', 'ЛИНИЯ', { contract: '100000.00', meals: '1200.00', travel: '3000.50' }],
      [6, 'ЖК Химки', 'worker', 'Бухгалтерия', { bonus: '0.00', contract: '45000.00' }],
      [2, 'Офис', 'office', 'Бухгалтерия', { contract: '80000.00' }],
    ]);
  });

  it('запасной путь — только для пар без разбивки, по месяцу', async () => {
    modes.calls.length = 0;
    const summary = await loadPayrollSummary({ scope: SCOPE, monthStarts: ['2026-08-01'] });
    expect(modes.calls).toEqual([{ ids: [1], month: '2026-08' }]);
    expect(summary.rows.map(row => [row.employee_id, row.object_key, row.object_name])).toEqual([[1, 'office', 'Офис']]);
  });

  it('весь период: суммы по сотруднику, объекту и категории за каждый месяц', async () => {
    const summary = await loadPayrollSummary({ scope: SCOPE, monthStarts: null });
    expect(summary.months).toEqual(['2026-07', '2026-08']);
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
    expect(await listPayrollSummaryMonths(SCOPE)).toEqual(['2026-07', '2026-08']);
    expect(await listPayrollSummaryMonths({ ...SCOPE, departmentIds: [] })).toEqual([]);
    expect(await listPayrollSummaryMonths({ ...SCOPE, departmentIds: [CONTRACTOR_CO] })).toEqual([]);
  });
});
