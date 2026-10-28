import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../types/index.js';

// Плановая доплата на настоящем PostgreSQL: журнал версий (миграция 293), действие и прежние
// значения в истории, два параллельных сохранения, общий журнал с окладом, SQL списка (и «Расчётов»:
// статьи 1С и ведомости в банк), приведение доплат к списку 1С.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).
// В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  // Как в config/postgres.ts: DATE — строкой YYYY-MM-DD, INT8 — числом.
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const pool = () => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool;
  };
  return {
    pool,
    query: async (sql: string, params?: readonly unknown[]) => (await pool().query(sql, params as unknown[])).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) =>
      (await pool().query(sql, params as unknown[])).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) =>
      (await pool().query(sql, params as unknown[])).rowCount ?? 0,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const client = await pool().connect();
      try {
        await client.query('BEGIN');
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
});

// Категория по табелю — режимы табелирования (288/291) и структура, своя схема; здесь не проверяется.
vi.mock('./payroll-staff-category.js', () => ({
  resolveCurrentStaffCategories: async (ids: number[]) => new Map(ids.map(id => [id, 'office'])),
}));

// Охват и корень подрядчиков — управляемые: тест столбцов ФОТ проверяет «штат зарплаты».
const scopeMock = vi.hoisted(() => ({
  departments: 'all' as 'all' | string[],
  contractorRootId: null as string | null,
  payoutCalls: [] as Array<{ ids: number[]; month: string; preliminary?: boolean }>,
}));

vi.mock('./payroll-scope.service.js', () => ({
  resolvePayrollReadableDepartmentIds: async () => scopeMock.departments,
  canReadPayrollEmployee: async () => true,
  canEditPayrollEmployee: async () => true,
  resolvePayrollEditPredicate: async () => () => true,
}));

vi.mock('../../config/contractor.js', () => ({ getContractorRootId: async () => scopeMock.contractorRootId }));

vi.mock('../audit.service.js', () => ({ auditService: { logFromRequest: async () => undefined } }));

// Расчёт ФОТ по закрытому табелю (столбцы «Расчётов») — своя схема табеля; здесь только SQL списка.
vi.mock('./payroll-calc.service.js', () => ({
  getPayoutForEmployees: async (ids: readonly number[], month: string) => {
    scopeMock.payoutCalls.push({ ids: [...ids], month });
    return new Map();
  },
  getPreliminaryPayoutForEmployees: async (ids: readonly number[], month: string) => {
    scopeMock.payoutCalls.push({ ids: [...ids], month, preliminary: true });
    return new Map();
  },
}));

import { withTransaction } from '../../config/postgres.js';
import {
  getPlannedSupplementChanges,
  getTermsChanges,
  lockPayrollEmployee,
  setPlannedSupplement,
  type IPlannedSupplementValue,
} from './payroll-terms.service.js';
import { payrollTermsController } from '../../controllers/payroll-terms.controller.js';
import { listPayouts1cMonths } from './payroll-1c-payouts.service.js';
import { PlannedSupplementSyncError, syncPlannedSupplements } from './payroll-planned-supplements-sync.service.js';
import { PLANNED_SUPPLEMENT_PERIODS_SQL } from './payroll-supplements.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');

const AUTHOR = '00000000-0000-0000-0000-00000000000b';
const NOV_DEC: IPlannedSupplementValue = { amount: 10000, dateFrom: '2026-11-01', dateTo: '2026-12-31' };

/** Сохранение доплаты так же, как в контроллере: транзакция под блокировкой сотрудника. */
const save = (employeeId: number, value: IPlannedSupplementValue | null): Promise<boolean> =>
  withTransaction(async client => {
    await lockPayrollEmployee(client, employeeId);
    return setPlannedSupplement(client, { employeeId, value, createdBy: AUTHOR });
  });

const versions = async (employeeId: number) => (await pg.pool!.query(
  `SELECT amount::text AS amount, date_from, date_to
     FROM payroll_planned_supplements WHERE employee_id = $1 ORDER BY id`,
  [employeeId],
)).rows;

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    headers: {} as Record<string, string>,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader(name: string, value: string) { this.headers[name] = value; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any; headers: Record<string, string> };
};

describe.skipIf(!PG_URL)('плановая доплата на PostgreSQL', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS payroll_1c_payout_imports, payroll_1c_payout_lines, payroll_1c_payout_documents,
        employee_hr_profiles,
        employee_dormitory_stays, payroll_compensation_stops, payroll_rate_values, payroll_rates,
        payroll_paid_amounts, payroll_planned_supplements, payroll_settings, payroll_item_types,
        payroll_compensation_terms, payroll_employee_deductions, payroll_deduction_kinds, employee_schedule_assignments, work_schedules, positions,
        user_profiles, employees, org_departments CASCADE;
      DROP FUNCTION IF EXISTS public.get_descendant_department_ids(uuid[]);
      -- parent_id и kind читает категория по отделу (payroll-staff-category.ts).
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, parent_id uuid, kind text);
      CREATE TABLE positions (id uuid PRIMARY KEY, name text);
      CREATE TABLE employees (
        id integer PRIMARY KEY,
        full_name text,
        tab_number text,
        org_department_id uuid REFERENCES org_departments(id),
        position_id uuid REFERENCES positions(id),
        employment_status text NOT NULL DEFAULT 'active',
        is_archived boolean NOT NULL DEFAULT false
      );
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      CREATE TABLE work_schedules (id serial PRIMARY KEY, name text, is_default boolean NOT NULL DEFAULT false);
      CREATE TABLE employee_schedule_assignments (
        id serial PRIMARY KEY,
        employee_id integer NOT NULL REFERENCES employees(id),
        schedule_id integer REFERENCES work_schedules(id),
        effective_from date NOT NULL,
        effective_to date
      );
      -- Список зовёт функцию только при фильтре подразделения или корне подрядчиков — здесь их нет.
      CREATE FUNCTION public.get_descendant_department_ids(uuid[]) RETURNS TABLE(id uuid)
        LANGUAGE sql AS $$ SELECT unnest($1) $$;
      INSERT INTO employees (id, full_name) VALUES
        (1, 'Акимов С.Ю.'), (2, 'Борисов А.А.'), (3, 'Васильев В.В.'), (4, 'Григорьев Г.Г.');
      INSERT INTO user_profiles (id, full_name) VALUES ('${AUTHOR}', 'Петрова А.А.');
    `);
    await pg.pool!.query(migration('271_payroll_terms.sql'));
    await pg.pool!.query(migration('282_payroll_terms_bonus_housing.sql'));
    await pg.pool!.query(migration('286_payroll_terms_compensations.sql'));
    await pg.pool!.query(migration('293_payroll_planned_supplements.sql'));
    // Повторный запуск безопасен.
    await pg.pool!.query(migration('322_payroll_planned_supplement_open_end.sql'));
    await pg.pool!.query(migration('322_payroll_planned_supplement_open_end.sql'));
    // Список берёт «Начисления» из «Оплачено».
    await pg.pool!.query(migration('295_payroll_paid_amounts.sql'));
    await pg.pool!.query(migration('297_payroll_paid_groups.sql'));
    await pg.pool!.query(migration('298_payroll_paid_drop_payouts.sql'));
    await pg.pool!.query(migration('299_payroll_deduction_kinds.sql'));
    await pg.pool!.query(migration('300_payroll_employee_deductions.sql'));
    await pg.pool!.query(migration('301_payroll_paid_order_kinds.sql'));
    // Проживание (320) — пустое: «Компенсацию проживания» список условий берёт из квартир.
    await pg.pool!.query(`CREATE TABLE employee_dormitory_stays (
      employee_id integer NOT NULL, kind text NOT NULL, check_in date NOT NULL, check_out date, amount numeric(12,2))`);
    // Проезд (324): ставка за месяц и «Без проезда» — список читает их у строк порции.
    await pg.pool!.query(`CREATE TABLE payroll_compensation_stops (
      employee_id integer NOT NULL, date_from date NOT NULL, date_to date)`);
    await pg.pool!.query(migration('306_payroll_rates.sql'));
    await pg.pool!.query(migration('313_payroll_rate_code.sql'));
    await pg.pool!.query(migration('324_payroll_rate_values.sql'));
    // Округление оклада (331) — колонка условий; остальное 331 (основа расчёта) списку не нужно.
    await pg.pool!.query(`ALTER TABLE payroll_compensation_terms
      ADD COLUMN IF NOT EXISTS proration_rounding TEXT NOT NULL DEFAULT 'ruble'`);
    // Ведомости в банк (328) — «Выплаты на карту» на «Расчётах»; профиль нужен только для индекса миграции.
    await pg.pool!.query('CREATE TABLE employee_hr_profiles (employee_id integer, passdesk_id_all uuid)');
    await pg.pool!.query(migration('328_payroll_1c_payouts.sql'));
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('журнал версий: повтор без правки и снятие без доплаты ничего не пишут', async () => {
    expect(await save(1, null)).toBe(false);
    expect(await versions(1)).toEqual([]);

    expect(await save(1, NOV_DEC)).toBe(true);
    // Повторное сохранение карточки без правки — та же сумма (числом) и те же даты.
    expect(await save(1, { ...NOV_DEC })).toBe(false);
    expect(await save(1, { ...NOV_DEC, amount: 12000 })).toBe(true);
    expect(await save(1, { ...NOV_DEC, amount: 12000, dateTo: '2027-01-31' })).toBe(true);
    expect(await save(1, null)).toBe(true);
    expect(await save(1, null)).toBe(false);
    expect(await save(1, NOV_DEC)).toBe(true);

    expect(await versions(1)).toEqual([
      { amount: '10000.00', date_from: '2026-11-01', date_to: '2026-12-31' },
      { amount: '12000.00', date_from: '2026-11-01', date_to: '2026-12-31' },
      { amount: '12000.00', date_from: '2026-11-01', date_to: '2027-01-31' },
      { amount: null, date_from: null, date_to: null },
      { amount: '10000.00', date_from: '2026-11-01', date_to: '2026-12-31' },
    ]);
  });

  it('история: действие и прежние значения, новые сверху, автор по ФИО', async () => {
    const changes = await getPlannedSupplementChanges(1);

    expect(changes.map(c => ({
      action: c.action, amount: c.amount, from: c.date_from, to: c.date_to,
      prev: c.prev_amount, prevFrom: c.prev_date_from, prevTo: c.prev_date_to, by: c.changed_by_name,
    }))).toEqual([
      { action: 'assigned', amount: '10000.00', from: '2026-11-01', to: '2026-12-31', prev: null, prevFrom: null, prevTo: null, by: 'Петрова А.А.' },
      { action: 'removed', amount: null, from: null, to: null, prev: '12000.00', prevFrom: '2026-11-01', prevTo: '2027-01-31', by: 'Петрова А.А.' },
      { action: 'changed', amount: '12000.00', from: '2026-11-01', to: '2027-01-31', prev: '12000.00', prevFrom: '2026-11-01', prevTo: '2026-12-31', by: 'Петрова А.А.' },
      { action: 'changed', amount: '12000.00', from: '2026-11-01', to: '2026-12-31', prev: '10000.00', prevFrom: '2026-11-01', prevTo: '2026-12-31', by: 'Петрова А.А.' },
      { action: 'assigned', amount: '10000.00', from: '2026-11-01', to: '2026-12-31', prev: null, prevFrom: null, prevTo: null, by: 'Петрова А.А.' },
    ]);
  });

  it('два параллельных сохранения одной доплаты дают одну версию', async () => {
    const results = await Promise.all([save(2, NOV_DEC), save(2, NOV_DEC), save(2, NOV_DEC)]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await versions(2)).toHaveLength(1);
  });

  it('недопустимое состояние отвергает сама БД', async () => {
    await expect(pg.pool!.query(
      `INSERT INTO payroll_planned_supplements (employee_id, amount, date_from, date_to)
       VALUES (3, 1000, '2026-12-01', '2026-11-01')`,
    )).rejects.toThrow(/payroll_supplement_state/);
    // Без «с» нельзя; без «по» — бессрочно (322), проверка — в последнем тесте.
    await expect(pg.pool!.query(
      `INSERT INTO payroll_planned_supplements (employee_id, amount, date_from, date_to)
       VALUES (3, 1000, NULL, '2026-12-01')`,
    )).rejects.toThrow(/payroll_supplement_state/);
    await expect(pg.pool!.query(
      `INSERT INTO payroll_planned_supplements (employee_id, amount, date_from, date_to)
       VALUES (3, NULL, '2026-12-01', NULL)`,
    )).rejects.toThrow(/payroll_supplement_state/);
  });

  it('общий журнал: оклад и доплата по времени изменения, новые сверху', async () => {
    await pg.pool!.query(
      `INSERT INTO payroll_compensation_terms
         (employee_id, staff_category, calc_type, monthly_salary, effective_from, effective_to, created_by, created_at)
       VALUES (3, 'itr', 'salary', 100000, '2026-01-01', '2026-09-30', '${AUTHOR}', '2026-01-10T09:00:00Z'),
              (3, 'itr', 'salary', 120000, '2026-10-01', NULL, '${AUTHOR}', '2026-09-20T09:00:00Z')`,
    );
    await save(3, NOV_DEC);
    await pg.pool!.query(
      `UPDATE payroll_planned_supplements SET created_at = '2026-05-01T09:00:00Z' WHERE employee_id = 3`,
    );

    const changes = await getTermsChanges(3);

    expect(changes.map(c => (c.kind === 'salary' ? `salary ${c.amount}` : `supplement ${c.amount}`))).toEqual([
      'salary 120000.00',
      'supplement 10000.00',
      'salary 100000.00',
    ]);
  });

  it('список: последняя сохранённая доплата у своих строк — будущая, прошедшая и снятая', async () => {
    // 1 — снята и назначена заново (Nov–Dec), 2 — Nov–Dec, 3 — Nov–Dec; 4 — кончилась в прошлом году.
    await save(4, { amount: 5000, dateFrom: '2025-01-01', dateTo: '2025-03-31' });
    const res = makeRes();

    await payrollTermsController.list({
      user: { id: AUTHOR }, params: {}, body: {}, query: { date: '2026-10-01' },
    } as unknown as AuthenticatedRequest, res);

    expect(res.statusCode).toBe(200);
    const byId = Object.fromEntries((res.body.data as Array<Record<string, unknown>>).map(row => [
      row.employee_id,
      [row.planned_supplement_amount, row.planned_supplement_from, row.planned_supplement_to],
    ]));
    expect(byId).toEqual({
      1: ['10000.00', '2026-11-01', '2026-12-31'],
      2: ['10000.00', '2026-11-01', '2026-12-31'],
      3: ['10000.00', '2026-11-01', '2026-12-31'],
      4: ['5000.00', '2025-01-01', '2025-03-31'],
    });
  });

  it('список: доплата снята — поля пустые', async () => {
    await save(2, null);
    const res = makeRes();

    await payrollTermsController.list({
      user: { id: AUTHOR }, params: {}, body: {}, query: { date: '2026-10-01' },
    } as unknown as AuthenticatedRequest, res);

    const row = (res.body.data as Array<Record<string, unknown>>).find(r => r.employee_id === 2);
    expect(row).toMatchObject({
      planned_supplement_amount: null, planned_supplement_from: null, planned_supplement_to: null,
    });
  });

  it('список: «Выплачено» — начислено минус удержано из «Оплачено» за 6 закрытых месяцев перед датой', async () => {
    await pg.pool!.query(`
      INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES
        (1, '2026-08-01', 'contract',      68095),
        (1, '2026-08-01', 'vacation',      59245),
        (1, '2026-08-01', 'travel',         1430),
        (1, '2026-08-01', 'meals',          5248),     -- удержание — вычитается
        (1, '2026-07-01', 'recalc_prev',   -1500),     -- сторно — минусом
        (1, '2026-03-01', 'contract',     100000),     -- до окна апр – сен
        (1, '2026-10-01', 'contract',     100000),     -- текущий месяц — не закрыт
        (3, '2026-09-01', 'workwear',      50000);     -- только удержание — минусом
    `);
    const res = makeRes();

    await payrollTermsController.list({
      user: { id: AUTHOR }, params: {}, body: {}, query: { date: '2026-10-01' },
    } as unknown as AuthenticatedRequest, res);

    const byId = Object.fromEntries((res.body.data as Array<Record<string, unknown>>).map(row => [row.employee_id, row.payouts]));
    // Суммы — NUMERIC строкой (::text): копейки не проходят через число JSON.
    expect(byId[1]).toEqual([{ month: '2026-07', amount: '-1500.00' }, { month: '2026-08', amount: '123522.00' }]);
    expect(byId[2]).toBeNull();
    expect(byId[3]).toEqual([{ month: '2026-09', amount: '-50000.00' }]);
  });

  it('«Расчёты»: «К выплате» и «Удержания» за выбранные месяцы — удержания не вычитаются', async () => {
    // Суммы предыдущего теста + явный ноль удержания у 4.
    await pg.pool!.query(`
      INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES
        (1, '2026-07-01', 'fines',         2000),
        (4, '2026-08-01', 'fines',            0);
    `);
    const list = async (paidMonths: string) => {
      const res = makeRes();
      await payrollTermsController.list({
        user: { id: AUTHOR }, params: {}, body: {}, query: { date: '2026-10-01', paid_months: paidMonths },
      } as unknown as AuthenticatedRequest, res);
      expect(res.statusCode).toBe(200);
      return Object.fromEntries((res.body.data as Array<Record<string, unknown>>).map(row => [row.employee_id, row]));
    };

    // Июль и август: сторно минусом входит в начисления, мартовский и октябрьский договор — нет.
    const julAug = await list('2026-07,2026-08');
    expect(julAug[1]).toMatchObject({
      paid_total: '127270.00',
      paid_deductions_total: '7248.00',
      paid_deductions: [
        { month: '2026-07', item: 'fines', amount: '2000.00' },
        { month: '2026-08', item: 'meals', amount: '5248.00' },
      ],
    });
    expect(julAug[1]).not.toHaveProperty('payouts');
    expect(julAug[2]).toMatchObject({ paid_total: null, paid_deductions_total: null, paid_deductions: null });
    // Только удержание — «К выплате» пусто; удержание вне выбранных месяцев не попадает.
    expect(julAug[3]).toMatchObject({ paid_total: null, paid_deductions_total: null, paid_deductions: null });
    // Явный ноль — 0, а не «нет данных».
    expect(julAug[4]).toMatchObject({ paid_total: null, paid_deductions_total: '0.00' });

    // Исключённый месяц не попадает.
    const aug = await list('2026-08');
    expect(aug[1]).toMatchObject({ paid_total: '128770.00', paid_deductions_total: '5248.00' });

    // Весь период — все месяцы, включая текущий.
    const all = await list('all');
    expect(all[1]).toMatchObject({ paid_total: '327270.00', paid_deductions_total: '7248.00' });
    expect(all[3]).toMatchObject({ paid_total: null, paid_deductions_total: '50000.00' });
  });

  it('бессрочная (без «по»): повтор без правки не пишет, в списке «по» пусто', async () => {
    const open: IPlannedSupplementValue = { amount: 20000, dateFrom: '2023-02-01', dateTo: null };
    expect(await save(4, open)).toBe(true);
    expect(await save(4, { ...open })).toBe(false);
    expect((await versions(4)).at(-1)).toEqual({ amount: '20000.00', date_from: '2023-02-01', date_to: null });

    const res = makeRes();
    await payrollTermsController.list({
      user: { id: AUTHOR }, params: {}, body: {}, query: { date: '2026-10-01' },
    } as unknown as AuthenticatedRequest, res);
    const row = (res.body.data as Array<Record<string, unknown>>).find(r => r.employee_id === 4);
    expect(row).toMatchObject({
      planned_supplement_amount: '20000.00', planned_supplement_from: '2023-02-01', planned_supplement_to: null,
    });
  });
  it('«Расчёты»: отпускные, больничные, перерасчёт из 1С и выплаты на карту по способам выплаты — без удвоения', async () => {
    await pg.pool!.query(`
      INSERT INTO employees (id, full_name, employment_status) VALUES (5, 'Дмитриев Д.Д.', 'dismissed');
      INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES
        (2, '2026-09-01', 'contract',    100000),
        (2, '2026-09-01', 'vacation',    40000.50),
        (2, '2026-09-01', 'sick_leave',  3000),
        (2, '2026-09-01', 'recalc_prev', -1200),
        (2, '2026-10-01', 'vacation',    999);
      INSERT INTO payroll_1c_payout_documents
        (id, doc_guid, doc_number, doc_date, period_month, payment_method, organization_inn, total_amount, content_hash, revision)
      VALUES
        (1, gen_random_uuid(), '0001', '2026-09-20', '2026-09-01', 'Аванс',      '7736255508', 50000,   repeat('a', 64), 1),
        (2, gen_random_uuid(), '0002', '2026-10-05', '2026-09-01', 'Зарплата',   '7736255508', 70000,   repeat('b', 64), 1),
        (3, gen_random_uuid(), '0003', '2026-10-06', '2026-09-01', 'Зарплата',   '7736255508', 5000.25, repeat('c', 64), 1),
        (4, gen_random_uuid(), '0004', '2026-10-07', '2026-09-01', 'Увольнения', '7736255508', 1000,    repeat('d', 64), 1),
        (5, gen_random_uuid(), '0005', '2026-09-05', '2026-08-01', 'Зарплата',   '7736255508', 9999,    repeat('e', 64), 1),
        (6, gen_random_uuid(), '0006', '2026-11-05', '2026-10-01', 'Зарплата',   '7736255508', 777,     repeat('f', 64), 1);
      INSERT INTO payroll_1c_payout_lines (document_id, line_no, line_key, full_name_1c, amount, employee_id, resolution) VALUES
        (1, 1, 'k1', 'Борисов А.А.',   30000,   2,    'auto_id_all'),
        (1, 2, 'k2', 'Неизвестный Н.', 20000,   NULL, 'unmatched'),
        (2, 1, 'k1', 'Борисов А.А.',   70000,   2,    'auto_id_all'),
        (3, 1, 'k1', 'Борисов А.А.',   5000.25, 2,    'confirmed'),
        (4, 1, 'k1', 'Борисов А.А.',   1000,    2,    'auto_id_all'),
        (5, 1, 'k1', 'Борисов А.А.',   9999,    2,    'auto_id_all'),
        (6, 1, 'k1', 'Дмитриев Д.Д.',  777,     5,    'auto_id_all');
    `);
    const res = makeRes();
    await payrollTermsController.list({
      user: { id: AUTHOR }, params: {}, body: {}, query: { date: '2026-10-01', paid_months: '2026-09' },
    } as unknown as AuthenticatedRequest, res);
    expect(res.statusCode).toBe(200);
    const rows = Object.fromEntries((res.body.data as Array<Record<string, unknown>>).map(row => [row.employee_id, row]));

    // Четыре ведомости и четыре статьи за месяц — суммы статей не умножаются на число ведомостей.
    expect(rows[2]).toMatchObject({
      paid_total: '141800.50',
      paid_vacation: '40000.50',
      paid_sick_leave: '3000.00',
      paid_recalc_prev: '-1200.00',
      // Каждый способ выплаты отдельно, две «Зарплаты» — одной суммой; строка без сотрудника и ведомость августа
      // не попадают.
      card_payouts_by_method: [
        { method: 'Аванс', amount: '30000.00' },
        { method: 'Зарплата', amount: '75000.25' },
        { method: 'Увольнения', amount: '1000.00' },
      ],
    });
    expect(rows[2]).not.toHaveProperty('card_payouts_raw');
    expect(rows[2]).not.toHaveProperty('card_payouts');
    expect(rows[1]).toMatchObject({ paid_vacation: null, card_payouts_by_method: null });

    // Месяцы ведомостей — только у штата в охвате: уволенный (октябрь) не даёт месяц.
    expect(await listPayouts1cMonths({ contractorRootId: null, departmentIds: null })).toEqual(['2026-08', '2026-09']);
    expect(await listPayouts1cMonths({ contractorRootId: null, departmentIds: [] })).toEqual([]);
    expect(await listPayouts1cMonths({
      contractorRootId: null, departmentIds: ['00000000-0000-0000-0000-0000000000d1'],
    })).toEqual([]);
  });

  describe('приведение плановых доплат к списку 1С', () => {
    const p = (amount: number, dateFrom: string, dateTo: string | null = null) => ({ amount, dateFrom, dateTo });
    const periods = async (employeeId: number) => (await pg.pool!.query(
      `SELECT x.amount::text AS amount, to_char(x.date_from, 'YYYY-MM-DD') AS date_from,
              to_char(x.date_to, 'YYYY-MM-DD') AS date_to
         FROM (${PLANNED_SUPPLEMENT_PERIODS_SQL}) x WHERE x.employee_id = $1 ORDER BY x.date_from`,
      [employeeId],
    )).rows;
    const versionCount = async () => Number((await pg.pool!.query(
      'SELECT count(*) AS n FROM payroll_planned_supplements WHERE employee_id BETWEEN 20 AND 29',
    )).rows[0].n);
    // Корж — две строки таблицы вместе; Белякова — прежняя заменяется; Власов — снять; Бурлаку — новая;
    // Смитская — уже как в таблице.
    const targets = [
      {
        employeeId: 20, fullName: 'Корж Илья Семенович',
        periods: [p(20000, '2023-03-01', '2026-09-30'), p(30000, '2026-10-01', '2027-01-31'), p(20000, '2027-02-01')],
      },
      { employeeId: 21, fullName: 'Белякова Надежда Владимировна', periods: [p(10000, '2026-10-01', '2027-01-31')] },
      { employeeId: 22, fullName: 'Власов Алексей Николаевич', periods: [] },
      { employeeId: 23, fullName: 'Бурлаку Кристина Александровна', periods: [p(10000, '2026-10-01', '2027-01-31')] },
      { employeeId: 24, fullName: 'Смитская Юлия Александровна', periods: [p(20000, '2023-01-01')] },
    ];

    beforeAll(async () => {
      await pg.pool!.query(`
        INSERT INTO employees (id, full_name) VALUES
          (20, 'Корж Илья Семенович'), (21, 'Белякова Надежда Владимировна'), (22, 'Власов Алексей Николаевич'),
          (23, 'Бурлаку Кристина Александровна'), (24, 'Смитская Юлия Александровна'), (25, 'Ёлкин Пётр');
        INSERT INTO payroll_planned_supplements (employee_id, amount, date_from, date_to, created_by) VALUES
          (20, 20000, '2023-03-01', NULL, NULL),
          (21, 25000, '2023-09-01', NULL, NULL),
          (22, 20000, '2023-02-01', NULL, NULL),
          (24, 20000, '2023-01-01', NULL, NULL),
          (25, 15000, '2020-01-01', '2020-12-31', NULL),
          (25, 20000, '2021-01-01', NULL, NULL);
      `);
    });

    it('сухой прогон показывает «станет» и ничего не оставляет', async () => {
      const before = await versionCount();
      const items = await syncPlannedSupplements(targets, { apply: false });
      expect(items.map(item => [item.employeeId, item.status])).toEqual([
        [20, 'changed'], [21, 'changed'], [22, 'changed'], [23, 'changed'], [24, 'same'],
      ]);
      expect(items[0].after).toEqual(targets[0].periods);
      expect(await versionCount()).toBe(before);
      expect(await periods(21)).toEqual([{ amount: '25000.00', date_from: '2023-09-01', date_to: null }]);
    });

    it('запись: периоды как в списке, автор пуст, повтор ничего не пишет', async () => {
      await syncPlannedSupplements(targets, { apply: true });
      expect(await periods(20)).toEqual([
        { amount: '20000.00', date_from: '2023-03-01', date_to: '2026-09-30' },
        { amount: '30000.00', date_from: '2026-10-01', date_to: '2027-01-31' },
        { amount: '20000.00', date_from: '2027-02-01', date_to: null },
      ]);
      expect(await periods(21)).toEqual([{ amount: '10000.00', date_from: '2026-10-01', date_to: '2027-01-31' }]);
      expect(await periods(22)).toEqual([]);
      expect(await periods(23)).toEqual([{ amount: '10000.00', date_from: '2026-10-01', date_to: '2027-01-31' }]);
      expect(await periods(24)).toEqual([{ amount: '20000.00', date_from: '2023-01-01', date_to: null }]);
      expect(Number((await pg.pool!.query(
        'SELECT count(*) AS n FROM payroll_planned_supplements WHERE employee_id BETWEEN 20 AND 29 AND created_by IS NOT NULL',
      )).rows[0].n)).toBe(0);

      const count = await versionCount();
      const again = await syncPlannedSupplements(targets, { apply: true });
      expect(again.every(item => item.status === 'same')).toBe(true);
      expect(await versionCount()).toBe(count);
    });

    it('ФИО не совпадает с id — ошибка, ничего не записано', async () => {
      const count = await versionCount();
      await expect(syncPlannedSupplements(
        [{ employeeId: 23, fullName: 'Рацкевич Светлана Юрьевна', periods: [p(20000, '2026-10-01', '2027-01-31')] }],
        { apply: true },
      )).rejects.toThrow(PlannedSupplementSyncError);
      expect(await versionCount()).toBe(count);
    });

    it('после записи периоды не равны списку — откат всего списка', async () => {
      const count = await versionCount();
      // У 25 старый период 2020 года не перекрывается новым — журнал его не снимет, цель недостижима.
      await expect(syncPlannedSupplements([
        { employeeId: 23, fullName: 'Бурлаку Кристина Александровна', periods: [p(12000, '2026-10-01', '2027-01-31')] },
        { employeeId: 25, fullName: 'Елкин Петр', periods: [p(10000, '2026-10-01', '2027-01-31')] },
      ], { apply: true })).rejects.toThrow(/не равны списку/);
      expect(await versionCount()).toBe(count);
      expect(await periods(23)).toEqual([{ amount: '10000.00', date_from: '2026-10-01', date_to: '2027-01-31' }]);
    });
  });

  describe('«Расчёты»: строки сразу, столбцы ФОТ отдельным запросом', () => {
    const D_CONTRACTOR = '00000000-0000-0000-0000-0000000000c1';
    const D_OTHER = '00000000-0000-0000-0000-0000000000d1';
    const D_MINE = '00000000-0000-0000-0000-0000000000e1';
    const calcColumns = async (query: Record<string, string>) => {
      const res = makeRes();
      await payrollTermsController.calcColumns({
        user: { id: AUTHOR }, params: {}, body: {}, query,
      } as unknown as AuthenticatedRequest, res);
      return res;
    };

    beforeAll(async () => {
      await pg.pool!.query(`
        INSERT INTO org_departments (id, name) VALUES
          ('${D_CONTRACTOR}', 'Подрядчики'), ('${D_OTHER}', 'Чужой'), ('${D_MINE}', 'Свой');
        INSERT INTO employees (id, full_name, org_department_id, is_archived) VALUES
          (30, 'Архивный А.А.', NULL, true),
          (31, 'Подрядчик П.П.', '${D_CONTRACTOR}', false),
          (32, 'Чужой Ч.Ч.', '${D_OTHER}', false),
          (33, 'Свой С.С.', '${D_MINE}', false);
      `);
    });

    beforeEach(() => {
      scopeMock.departments = 'all';
      scopeMock.contractorRootId = null;
      scopeMock.payoutCalls = [];
    });

    it('список с defer_calc=1 не считает ФОТ, без параметра — считает, как раньше', async () => {
      const list = async (extra: Record<string, string>) => {
        const res = makeRes();
        await payrollTermsController.list({
          user: { id: AUTHOR }, params: {}, body: {}, query: { date: '2026-10-01', paid_months: '2026-09', ...extra },
        } as unknown as AuthenticatedRequest, res);
        expect(res.statusCode).toBe(200);
        return res.body.data as Array<Record<string, unknown>>;
      };

      const deferred = await list({ defer_calc: '1' });
      expect(scopeMock.payoutCalls).toEqual([]);
      expect(deferred.every(row => !('calc' in row))).toBe(true);

      const inline = await list({});
      expect(scopeMock.payoutCalls).toHaveLength(1);
      expect(inline.every(row => 'calc' in row)).toBe(true);
    });

    it('считаются только «штат зарплаты» в охвате: без уволенного, архивного, подрядчика и чужого отдела', async () => {
      scopeMock.contractorRootId = D_CONTRACTOR;
      // 5 — уволен (тест ведомостей выше), 999 — нет такого; повтор 33 — один раз.
      const all = await calcColumns({ employee_ids: '33,30,31,32,5,1,33,999', paid_months: '2026-09' });
      expect(all.statusCode).toBe(200);
      expect(scopeMock.payoutCalls).toEqual([{ ids: [33, 32, 1], month: '2026-09' }]);
      expect((all.body.data.rows as Array<{ employee_id: number }>).map(row => row.employee_id)).toEqual([33, 32, 1]);
      expect(all.body.data.available).toBe(true);
      expect(all.headers['Server-Timing']).toMatch(/calc_total;dur=/);

      scopeMock.payoutCalls = [];
      scopeMock.departments = [D_MINE];
      const mine = await calcColumns({ employee_ids: '33,32,1', paid_months: '2026-09' });
      expect(scopeMock.payoutCalls).toEqual([{ ids: [33], month: '2026-09' }]);
      expect((mine.body.data.rows as Array<{ employee_id: number }>).map(row => row.employee_id)).toEqual([33]);
    });

    it('preliminary=1 — предварительный расчёт; без параметра — по закрытому табелю (старый фронт)', async () => {
      await calcColumns({ employee_ids: '33', paid_months: '2026-09', preliminary: '1' });
      expect(scopeMock.payoutCalls).toEqual([{ ids: [33], month: '2026-09', preliminary: true }]);

      scopeMock.payoutCalls = [];
      await calcColumns({ employee_ids: '33', paid_months: '2026-09' });
      expect(scopeMock.payoutCalls).toEqual([{ ids: [33], month: '2026-09' }]);
    });

    it('лимиты: 501 id (с повторами) и без месяцев — 400; «весь период» и больше 12 месяцев — ФОТ недоступен', async () => {
      expect((await calcColumns({ employee_ids: Array(501).fill('1').join(','), paid_months: '2026-09' })).statusCode).toBe(400);
      expect((await calcColumns({ employee_ids: '1' })).statusCode).toBe(400);
      expect((await calcColumns({ employee_ids: '1', paid_months: '2026-13' })).statusCode).toBe(400);
      expect((await calcColumns({ employee_ids: 'abc', paid_months: '2026-09' })).statusCode).toBe(400);

      const all = await calcColumns({ employee_ids: '1', paid_months: 'all' });
      expect(all.body.data).toEqual({ available: false, rows: [] });
      const thirteen = Array.from({ length: 13 }, (_, index) => `2025-${String((index % 12) + 1).padStart(2, '0')}`)
        .map((month, index) => (index === 12 ? '2026-01' : month)).join(',');
      expect((await calcColumns({ employee_ids: '1', paid_months: thirteen })).body.data).toEqual({ available: false, rows: [] });
      expect(scopeMock.payoutCalls).toEqual([]);
    });
  });
});
