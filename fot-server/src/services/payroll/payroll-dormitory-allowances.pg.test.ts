import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../types/index.js';

// «Доплата за общежитие» (миграция 317) на настоящем PostgreSQL: ставка, периоды и повтор запроса, дни
// проживания в общежитии (и проживание, появившееся позже), «одна доплата из двух» во всех трёх путях
// (эта таблица, «Доплата за проживание», окно сотрудника), параллельная запись, сумма из ставки.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются). Гонять отдельно от
// других *.pg.test.ts: они дропают те же таблицы.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 6 }) : null;
  const pool = () => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool;
  };
  return {
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

vi.mock('./payroll-scope.service.js', () => ({
  resolvePayrollReadableDepartmentIds: async () => 'all',
  canReadPayrollEmployee: async () => true,
  canEditPayrollEmployee: async () => true,
  resolvePayrollEditPredicate: async () => () => true,
}));

const CONTRACTORS = '00000000-0000-0000-0000-0000000000c0';
vi.mock('../../config/contractor.js', () => ({
  CONTRACTOR_ROOT_NAME: 'подрядные организации',
  getContractorRootId: async () => CONTRACTORS,
}));

// Аудит в транзакции — тем же клиентом в тестовую таблицу: видно, откатывается ли он вместе с записью.
vi.mock('../audit.service.js', () => ({
  auditService: {
    logFromRequest: async () => undefined,
    logFromRequestWithClient: async (
      client: import('pg').PoolClient, _req: unknown, _userId: unknown, action: string, options?: { entityId?: string },
    ) => {
      await client.query('INSERT INTO test_audit (action, entity_id) VALUES ($1, $2)', [action, options?.entityId ?? null]);
    },
  },
}));

import { currentRateMonth, listRates, shiftRateMonth, updateRate } from './payroll-rates.service.js';
import { addStay, updateStay } from '../dormitory-stays.service.js';
import { DormitoryAllowanceConflictError, listDormitoryAllowances } from './payroll-dormitory-allowances.service.js';
import { payrollDormitoryAllowancesController as controller } from '../../controllers/payroll-dormitory-allowances.controller.js';
import { payrollTermsController } from '../../controllers/payroll-terms.controller.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
const run = (sql: string, params?: unknown[]) => pg.pool!.query(sql, params);

const AUTHOR = '00000000-0000-0000-0000-00000000000c';
const D1 = '00000000-0000-0000-0000-0000000000d1';
const SCOPE = { contractorRootId: CONTRACTORS, departmentIds: null };

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const req = (over: Record<string, unknown> = {}) => ({
  user: { id: AUTHOR }, params: {}, query: {}, body: {}, ...over,
} as unknown as AuthenticatedRequest);

const add = async (employeeId: number, dateFrom: string, dateTo: string | null = null) => {
  const res = makeRes();
  await controller.add(req({ body: { employee_id: employeeId, date_from: dateFrom, date_to: dateTo } }), res);
  return res;
};
const patch = async (id: number, dateFrom: string, dateTo: string | null) => {
  const res = makeRes();
  await controller.update(req({ params: { id: String(id) }, body: { date_from: dateFrom, date_to: dateTo } }), res);
  return res;
};

/** Квартира (доплата за проживание, миграция 320) — через сервис проживаний, как пишут кадры и «Зарплата». */
const addApartment = (employeeId: number, checkIn: string, checkOut: string | null = null) =>
  addStay(employeeId, { kind: 'apartment', check_in: checkIn, check_out: checkOut, address: null, amount: 630 });

const stays = async (employeeId: number) => (await run(
  `SELECT kind, to_char(check_in, 'YYYY-MM-DD') AS in, to_char(check_out, 'YYYY-MM-DD') AS out
     FROM employee_dormitory_stays WHERE employee_id = $1 ORDER BY check_in`,
  [employeeId],
)).rows.map(row => [row.kind, row.in, row.out]);

const periods = async (employeeId: number) => (await run(
  `SELECT to_char(date_from, 'YYYY-MM-DD') AS from, to_char(date_to, 'YYYY-MM-DD') AS to
     FROM payroll_dormitory_allowances WHERE employee_id = $1 ORDER BY date_from`,
  [employeeId],
)).rows.map(row => [row.from, row.to]);

const housingVersions = async (employeeId: number) => (await run(
  `SELECT to_char(effective_from, 'YYYY-MM-DD') AS from, to_char(effective_to, 'YYYY-MM-DD') AS to,
          housing_compensation::text AS housing
     FROM payroll_compensation_terms WHERE employee_id = $1 ORDER BY effective_from`,
  [employeeId],
)).rows.map(row => [row.from, row.to, row.housing]);

const auditCount = async (action: string) =>
  Number((await run('SELECT count(*) FROM test_audit WHERE action = $1', [action])).rows[0].count);

describe.skipIf(!PG_URL)('«Доплата за общежитие» на PostgreSQL', () => {
  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS payroll_dormitory_allowances, employee_dormitory_stays, payroll_compensation_stops,
        payroll_one_time_supplements, payroll_paid_amounts, payroll_planned_supplements, payroll_settings,
        payroll_item_types, payroll_rate_values, payroll_rates, payroll_compensation_terms, payroll_employee_deductions,
        payroll_deduction_kinds, employee_schedule_assignments, work_schedules, role_page_access, access_pages,
        test_audit, positions, user_profiles, employees, org_departments CASCADE;
      DROP FUNCTION IF EXISTS public.get_descendant_department_ids(uuid[]);
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
      -- Права для миграции 314: столбцы и ключи — как на проде.
      CREATE TABLE access_pages (
        key text PRIMARY KEY, label text NOT NULL, group_code text NOT NULL, group_label text NOT NULL,
        surface text NOT NULL, supports_edit boolean NOT NULL DEFAULT true,
        requires_data_scope boolean NOT NULL DEFAULT false, requires_employee_variant boolean NOT NULL DEFAULT false,
        sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true, is_system boolean NOT NULL DEFAULT true,
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        area text NOT NULL DEFAULT 'admin'
      );
      CREATE TABLE role_page_access (
        id serial PRIMARY KEY, role_code text, page_path text NOT NULL, can_view boolean, can_edit boolean,
        UNIQUE (role_code, page_path)
      );
      CREATE TABLE test_audit (id serial PRIMARY KEY, action text NOT NULL, entity_id text);
      CREATE FUNCTION public.get_descendant_department_ids(uuid[]) RETURNS TABLE(id uuid)
        LANGUAGE sql AS $$
          SELECT d.id FROM org_departments d WHERE d.id = ANY($1) OR d.parent_id = ANY($1)
        $$;
      INSERT INTO org_departments (id, name, parent_id) VALUES
        ('${D1}', 'ЛИНИЯ', NULL),
        ('${CONTRACTORS}', 'Подрядные организации', NULL),
        ('00000000-0000-0000-0000-0000000000c1', 'ООО Подрядчик', '${CONTRACTORS}');
      INSERT INTO employees (id, full_name, org_department_id) VALUES
        (1, 'Акимов С.Ю.', '${D1}'),
        (2, 'Борисов Общежитие', '${D1}'),
        (3, 'Васильев Проживание', '${D1}'),
        (4, 'Григорьев Условия до октября', '${D1}'),
        (5, 'Дмитриев Параллельно', '${D1}'),
        (6, 'Егоров Подрядчик', '00000000-0000-0000-0000-0000000000c1');
      INSERT INTO user_profiles (id, full_name) VALUES ('${AUTHOR}', 'Петрова А.А.');
    `);
    for (const name of [
      '271_payroll_terms.sql', '282_payroll_terms_bonus_housing.sql', '286_payroll_terms_compensations.sql',
      '293_payroll_planned_supplements.sql', '295_payroll_paid_amounts.sql', '299_payroll_deduction_kinds.sql',
      '300_payroll_employee_deductions.sql', '301_payroll_paid_order_kinds.sql', '306_payroll_rates.sql',
    ]) {
      await run(migration(name));
    }
    // Округление оклада (331) — колонка условий; остальное 331 (основа расчёта) здесь не нужно.
    await run(`ALTER TABLE payroll_compensation_terms
      ADD COLUMN IF NOT EXISTS proration_rounding TEXT NOT NULL DEFAULT 'ruble'`);
    // Ставку «Доплата за общежитие» завели руками до 317 — миграция должна взять её, а не создать вторую.
    await run(`INSERT INTO payroll_rates (name, amount) VALUES ('Проживание общежития', 630), (' Доплата за общежитие', 450)`);
    for (const name of [
      '313_payroll_rate_code.sql', '314_employee_dormitory_stays.sql', '315_payroll_dictionary_registries.sql',
      '319_dormitory_addresses.sql', '320_dormitory_stays_apartment.sql',
    ]) {
      await run(migration(name));
    }
    await run(`
      INSERT INTO employee_dormitory_stays (employee_id, check_in, check_out, address) VALUES
        (2, '2026-10-25', '2026-11-25', 'Общ1');
      INSERT INTO payroll_compensation_terms
        (employee_id, staff_category, calc_type, monthly_salary, effective_from, effective_to, created_by)
      VALUES
        (3, 'worker', 'salary', 90000, '2026-09-01', NULL, '${AUTHOR}'),
        (4, 'worker', 'salary', 90000, '2026-09-01', '2026-10-31', '${AUTHOR}'),
        (5, 'worker', 'salary', 90000, '2026-09-01', NULL, '${AUTHOR}');
    `);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('317 дважды: ставка с кодом — прежняя строка (значение 450 не тронуто), «Доплата за проживание» та же', async () => {
    await run(migration('317_payroll_dormitory_allowances.sql'));
    await run(migration('317_payroll_dormitory_allowances.sql'));
    // 324 — значения по месяцам: прежние значения действуют «с начала», «Проезд» — без значения.
    await run(migration('324_payroll_rate_values.sql'));
    await run(migration('324_payroll_rate_values.sql'));
    expect((await listRates()).map(rate => [rate.name, rate.amount, rate.code, rate.values])).toEqual([
      ['Доплата за проживание', '630.00', 'housing', [{ effective_from: '2000-01', amount: '630.00' }]],
      [' Доплата за общежитие', '450.00', 'dormitory_allowance', [{ effective_from: '2000-01', amount: '450.00' }]],
      ['Проезд', null, 'travel', []],
    ]);
  });

  it('добавление и повтор того же запроса — одна строка, одна запись аудита', async () => {
    const first = await add(1, '2026-11-01');
    expect(first.statusCode).toBe(200);
    expect(first.body.data).toMatchObject({ employee_id: 1, date_from: '2026-11-01', date_to: null, amount: '450.00' });
    const again = await add(1, '2026-11-01');
    expect(again.statusCode).toBe(200);
    expect(again.body.data.id).toBe(first.body.data.id);
    expect(await periods(1)).toEqual([['2026-11-01', null]]);
    expect(await auditCount('PAYROLL_DORMITORY_ALLOWANCE_ADDED')).toBe(1);

    // Другой, пересекающийся период — 409, без записи и аудита.
    const overlap = await add(1, '2026-12-01', '2026-12-31');
    expect(overlap.statusCode).toBe(409);
    expect(overlap.body.code).toBe('ALLOWANCE_OVERLAP');
    expect(await auditCount('PAYROLL_DORMITORY_ALLOWANCE_ADDED')).toBe(1);
  });

  it('в дни проживания — 409 с датами; со дня выезда — можно; подрядчика нет в списке', async () => {
    const living = await add(2, '2026-11-01');
    expect(living.statusCode).toBe(409);
    expect(living.body).toMatchObject({ code: 'LIVES_IN_DORMITORY' });
    expect(living.body.error).toContain('въезд 25.10.2026, выезд 25.11.2026');
    expect((await add(2, '2026-10-01', '2026-10-25')).statusCode).toBe(409);

    expect((await add(2, '2026-10-01', '2026-10-24')).statusCode).toBe(200);
    expect((await add(2, '2026-11-25')).statusCode).toBe(200);
    expect(await periods(2)).toEqual([['2026-10-01', '2026-10-24'], ['2026-11-25', null]]);

    expect((await add(6, '2026-11-01')).statusCode).toBe(403);
  });

  it('проживание появилось позже: строка видна с ним; сократить можно, расширить в него — 409', async () => {
    // Кадры заселили Акимова уже после назначения доплаты (их вкладка доплату не проверяет).
    await run(`INSERT INTO employee_dormitory_stays (employee_id, check_in, check_out, address) VALUES (1, '2026-12-01', '2027-01-10', 'Общ2')`);
    const row = (await listDormitoryAllowances(SCOPE)).find(item => item.employee_id === 1)!;
    expect(row.dormitory_stays).toEqual([{ check_in: '2026-12-01', check_out: '2027-01-10' }]);

    const shrink = await patch(row.id, '2026-11-01', '2026-12-15');
    expect(shrink.statusCode).toBe(200);
    expect(await auditCount('PAYROLL_DORMITORY_ALLOWANCE_UPDATED')).toBe(1);
    // Те же даты — без записи аудита.
    expect((await patch(row.id, '2026-11-01', '2026-12-15')).statusCode).toBe(200);
    expect(await auditCount('PAYROLL_DORMITORY_ALLOWANCE_UPDATED')).toBe(1);
    // Раньше начать — дни без проживания: можно.
    expect((await patch(row.id, '2026-10-20', '2026-12-15')).statusCode).toBe(200);

    for (const dateTo of ['2027-01-05', null]) {
      const extend = await patch(row.id, '2026-10-20', dateTo);
      expect(extend.statusCode, String(dateTo)).toBe(409);
      expect(extend.body.code).toBe('LIVES_IN_DORMITORY');
    }
    expect(await periods(1)).toEqual([['2026-10-20', '2026-12-15']]);
    expect(await auditCount('PAYROLL_DORMITORY_ALLOWANCE_UPDATED')).toBe(2);
  });

  describe('одна доплата из двух: квартира или доплата за общежитие (миграция 320)', () => {
    it('есть квартира — доплату за общежитие в эти дни нельзя; до неё и со дня выезда — можно', async () => {
      expect(await addApartment(3, '2026-10-01', '2026-12-01')).toMatchObject({ kind: 'apartment', amount: '630.00' });
      const conflict = await add(3, '2026-11-01');
      expect(conflict.statusCode).toBe(409);
      expect(conflict.body).toMatchObject({ code: 'HAS_HOUSING' });
      expect(conflict.body.error).toContain('С 01.11.2026');

      expect((await add(3, '2026-09-01', '2026-09-30')).statusCode).toBe(200);
      // День выезда из квартиры (01.12) — уже не в ней.
      expect((await add(3, '2026-12-01')).statusCode).toBe(200);
      expect(await periods(3)).toEqual([['2026-09-01', '2026-09-30'], ['2026-12-01', null]]);
    });

    it('квартира в днях доплаты за общежитие — отказ и откат; сократить можно, расширить в доплату — нет', async () => {
      await expect(addApartment(3, '2026-12-10')).rejects.toMatchObject({ code: 'HAS_DORMITORY_ALLOWANCE' });
      await expect(addApartment(3, '2026-08-01', '2026-09-15')).rejects.toBeInstanceOf(DormitoryAllowanceConflictError);
      expect(await stays(3)).toEqual([['apartment', '2026-10-01', '2026-12-01']]);

      const [{ id }] = (await run(`SELECT id FROM employee_dormitory_stays WHERE employee_id = 3`)).rows;
      const fields = { address: null, amount: 630 };
      await expect(updateStay(id, { check_in: '2026-10-01', check_out: null, ...fields }))
        .rejects.toMatchObject({ code: 'HAS_DORMITORY_ALLOWANCE' });
      await expect(updateStay(id, { check_in: '2026-09-20', check_out: '2026-12-01', ...fields }))
        .rejects.toMatchObject({ code: 'HAS_DORMITORY_ALLOWANCE' });
      expect(await updateStay(id, { check_in: '2026-10-01', check_out: '2026-11-15', ...fields, amount: 700 }))
        .toMatchObject({ after: { check_out: '2026-11-15', amount: '700.00' } });
    });

    it('в один день — одно место: общежитие поверх квартиры — пересечение', async () => {
      expect(await addStay(3, { kind: 'dormitory', check_in: '2026-11-01', check_out: '2026-11-10', address: 'Общ3', amount: null }))
        .toBe('overlap');
      // Со дня выезда из квартиры — можно.
      expect(await addStay(3, { kind: 'dormitory', check_in: '2026-11-15', check_out: '2026-11-20', address: 'Общ3', amount: null }))
        .toMatchObject({ kind: 'dormitory' });
    });

    it('окно сотрудника: проживание в теле не пишется и доплату за общежитие не проверяет', async () => {
      const res = makeRes();
      await payrollTermsController.assign(req({
        params: { empId: '3' },
        body: {
          staff_category: 'worker', calc_type: 'salary', monthly_salary: 95000,
          housing_compensation: 630, effective_from: '2027-01-01',
        },
      }), res);
      expect(res.statusCode).toBe(200);
      expect((await housingVersions(3)).at(-1)).toEqual(['2027-01-01', null, null]);
    });

    it('параллельно квартира и доплата за общежитие одному сотруднику — проходит ровно одна', async () => {
      const [apartment, allowance] = await Promise.allSettled([
        addApartment(5, '2026-10-01'),
        add(5, '2026-10-01'),
      ]);
      const apartmentSaved = apartment.status === 'fulfilled';
      const allowanceSaved = allowance.status === 'fulfilled' && allowance.value.statusCode === 200;
      expect(apartmentSaved !== allowanceSaved).toBe(true);
      expect((await stays(5)).length).toBe(apartmentSaved ? 1 : 0);
      expect((await periods(5)).length).toBe(allowanceSaved ? 1 : 0);
    });
  });

  it('сумма — ставка на последний месяц периода, не позже текущего: прошлые периоды смена не трогает', async () => {
    const rate = (await listRates()).find(item => item.code === 'dormitory_allowance')!;
    const month = currentRateMonth();
    // Доплата, закончившаяся давно, — при ставке того времени.
    expect((await add(1, '2020-01-01', '2020-06-30')).statusCode).toBe(200);
    // Закончилась до текущего месяца — прошлая (здесь же сентябрьская строка Васильева).
    const amounts = async () => {
      const rows = await listDormitoryAllowances(SCOPE);
      const isPast = (row: { date_to: string | null }) => row.date_to !== null && row.date_to < `${month}-01`;
      return {
        past: new Set(rows.filter(isPast).map(row => row.amount)),
        current: new Set(rows.filter(row => !isPast(row)).map(row => row.amount)),
        count: rows.length,
      };
    };

    await updateRate(rate.id, rate.name, 500, month);
    expect(await amounts()).toEqual({ past: new Set(['450.00']), current: new Set(['500.00']), count: expect.any(Number) });
    expect((await amounts()).count).toBeGreaterThan(3);
    // Будущая смена — на сегодня всё ещё 500.
    await updateRate(rate.id, rate.name, 600, shiftRateMonth(month, 1));
    expect(await amounts()).toMatchObject({ past: new Set(['450.00']), current: new Set(['500.00']) });
    // Ставку отключили с текущего месяца — у текущих строк суммы нет, прошлые — те же.
    await updateRate(rate.id, rate.name, null, month);
    expect(await amounts()).toMatchObject({ past: new Set(['450.00']), current: new Set([null]) });
  });

  it('удаление: аудит в транзакции; повтор — 404', async () => {
    const [row] = await listDormitoryAllowances(SCOPE).then(rows => rows.filter(item => item.employee_id === 2));
    const res = makeRes();
    await controller.remove(req({ params: { id: String(row.id) } }), res);
    expect(res.statusCode).toBe(200);
    const again = makeRes();
    await controller.remove(req({ params: { id: String(row.id) } }), again);
    expect(again.statusCode).toBe(404);
    expect(await auditCount('PAYROLL_DORMITORY_ALLOWANCE_DELETED')).toBe(1);
  });
});
