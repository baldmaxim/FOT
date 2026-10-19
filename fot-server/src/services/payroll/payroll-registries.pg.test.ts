import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../types/index.js';

// Таблицы окна «Справочник» (миграция 315) на настоящем PostgreSQL: переименование ставки, «Доплата за
// проживание» (разрез версии условий, «с D и дальше», без оклада), плановая и разовые доплаты, «Без проезда»,
// «Удержания», «штат зарплаты» (подрядчики, уволенные, архив).
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

vi.mock('../audit.service.js', () => ({ auditService: { logFromRequest: async () => undefined } }));

import { withTransaction } from '../../config/postgres.js';
import { listRates } from './payroll-rates.service.js';
import { listHousingAllowances, setHousingFrom } from './payroll-housing.service.js';
import {
  addOneTimeSupplement,
  listSupplements,
  savePlannedSupplement,
} from './payroll-supplements.service.js';
import {
  addCompensationStop,
  listCompensationStops,
  updateCompensationStop,
} from './payroll-compensation-stops.service.js';
import { listDeductionRegistry, setEmployeeDeductionKinds } from './payroll-deduction-kinds.service.js';
import { canWritePayrollRegistryEmployee, isPayrollStaffEmployee } from './payroll-registry-scope.service.js';
import { payrollTermsController } from '../../controllers/payroll-terms.controller.js';
import { payrollRegistryController } from '../../controllers/payroll-registry.controller.js';

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

/** Версии условий сотрудника по порядку — сравнение по нужным столбцам. */
const versions = async (employeeId: number) => (await run(
  `SELECT to_char(effective_from, 'YYYY-MM-DD') AS from, to_char(effective_to, 'YYYY-MM-DD') AS to,
          monthly_salary::text AS salary, bonus_amount::text AS bonus, housing_compensation::text AS housing,
          travel_compensation::text AS travel, time_accounting_mode AS mode, accounting_period_months AS months,
          note
     FROM payroll_compensation_terms WHERE employee_id = $1 ORDER BY effective_from`,
  [employeeId],
)).rows;

const setHousing = (employeeId: number, amount: number | null, from: string) =>
  withTransaction(client => setHousingFrom(client, { employeeId, amount, from, createdBy: AUTHOR }));

describe.skipIf(!PG_URL)('таблицы «Справочника» на PostgreSQL', () => {
  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS payroll_compensation_stops, payroll_one_time_supplements, payroll_paid_amounts,
        payroll_planned_supplements, payroll_settings, payroll_item_types, payroll_rates, payroll_compensation_terms,
        payroll_employee_deductions, payroll_deduction_kinds, employee_schedule_assignments, work_schedules, positions,
        user_profiles, employees, org_departments CASCADE;
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
      -- Поддерево: узел и его прямые потомки — для теста хватает одного уровня.
      CREATE FUNCTION public.get_descendant_department_ids(uuid[]) RETURNS TABLE(id uuid)
        LANGUAGE sql AS $$
          SELECT d.id FROM org_departments d WHERE d.id = ANY($1) OR d.parent_id = ANY($1)
        $$;
      INSERT INTO org_departments (id, name, parent_id) VALUES
        ('${D1}', 'ЛИНИЯ', NULL),
        ('${CONTRACTORS}', 'Подрядные организации', NULL),
        ('00000000-0000-0000-0000-0000000000c1', 'ООО Подрядчик', '${CONTRACTORS}');
      INSERT INTO employees (id, full_name, org_department_id, employment_status, is_archived) VALUES
        (1, 'Акимов С.Ю.', '${D1}', 'active', false),
        (2, 'Борисов А.А.', '${D1}', 'active', false),
        (3, 'Васильев Подрядчик', '00000000-0000-0000-0000-0000000000c1', 'active', false),
        (4, 'Григорьев Уволенный', '${D1}', 'dismissed', false),
        (5, 'Дмитриев Архивный', '${D1}', 'active', true),
        (6, 'Егоров Без оклада', '${D1}', 'active', false);
      INSERT INTO user_profiles (id, full_name) VALUES ('${AUTHOR}', 'Петрова А.А.');
    `);
    for (const name of [
      '271_payroll_terms.sql', '282_payroll_terms_bonus_housing.sql', '286_payroll_terms_compensations.sql',
      '293_payroll_planned_supplements.sql', '295_payroll_paid_amounts.sql', '299_payroll_deduction_kinds.sql',
      '300_payroll_employee_deductions.sql', '301_payroll_paid_order_kinds.sql', '306_payroll_rates.sql',
    ]) {
      await run(migration(name));
    }
    await run(`INSERT INTO payroll_rates (name, amount) VALUES ('Сварщик', 520), ('Проживание общежития', 630)`);
    await run(migration('313_payroll_rate_code.sql'));
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('315: ставка стала «Доплатой за проживание» (code housing), значение то же; повтор безопасен', async () => {
    const [before] = (await run(`SELECT id FROM payroll_rates WHERE code = 'dormitory'`)).rows;
    await run(migration('315_payroll_dictionary_registries.sql'));
    await run(migration('315_payroll_dictionary_registries.sql'));
    expect(await listRates()).toEqual([
      { id: expect.any(Number), name: 'Сварщик', amount: '520.00', code: null },
      { id: before.id, name: 'Доплата за проживание', amount: '630.00', code: 'housing' },
    ]);
  });

  it('«штат зарплаты»: подрядчик, уволенный и архивный — не пишутся', async () => {
    expect(await isPayrollStaffEmployee(1, SCOPE)).toBe(true);
    for (const id of [3, 4, 5]) {
      expect(await isPayrollStaffEmployee(id, SCOPE), String(id)).toBe(false);
      expect(await canWritePayrollRegistryEmployee(req(), id), String(id)).toBe(false);
    }
    expect(await isPayrollStaffEmployee(1, { ...SCOPE, departmentIds: [] })).toBe(false);
  });

  describe('«Доплата за проживание»', () => {
    beforeAll(async () => {
      // Версия с учётом времени «суммированный» и примечанием — разрез обязан их сохранить; и уже
      // запланированная смена оклада с 01.12.
      await run(`
        INSERT INTO payroll_compensation_terms
          (employee_id, staff_category, calc_type, monthly_salary, time_accounting_mode, accounting_period_months,
           effective_from, effective_to, note, bonus_amount, travel_compensation, created_by)
        VALUES
          (1, 'itr', 'salary', 150000, 'summarized', 3, '2026-09-01', '2026-11-30', 'Приказ 12', 20000, 3000, '${AUTHOR}'),
          (1, 'itr', 'salary', 170000, 'summarized', 3, '2026-12-01', NULL, 'Приказ 40', 20000, 3000, '${AUTHOR}');
      `);
    });

    it('без условий на дату — no_terms, ничего не пишется', async () => {
      expect(await setHousing(6, 630, '2026-10-19')).toEqual({ status: 'no_terms' });
      expect(await setHousing(1, 630, '2026-08-01')).toEqual({ status: 'no_terms' });
      expect(await versions(6)).toEqual([]);
    });

    it('разрез версии: все столбцы и прежний effective_to; поздняя версия получает ту же сумму', async () => {
      const result = await setHousing(1, 630, '2026-10-19');
      expect(result).toMatchObject({ status: 'saved', previousAmount: null, laterUpdated: 1 });
      expect(await versions(1)).toEqual([
        { from: '2026-09-01', to: '2026-10-18', salary: '150000.00', bonus: '20000.00', housing: null, travel: '3000.00', mode: 'summarized', months: 3, note: 'Приказ 12' },
        { from: '2026-10-19', to: '2026-11-30', salary: '150000.00', bonus: '20000.00', housing: '630.00', travel: '3000.00', mode: 'summarized', months: 3, note: 'Приказ 12' },
        { from: '2026-12-01', to: null, salary: '170000.00', bonus: '20000.00', housing: '630.00', travel: '3000.00', mode: 'summarized', months: 3, note: 'Приказ 40' },
      ]);
    });

    it('повтор той же суммы — unchanged; правка в день начала версии — без нового разреза', async () => {
      expect(await setHousing(1, 630, '2026-10-19')).toEqual({ status: 'unchanged' });
      expect(await setHousing(1, 700, '2026-10-19')).toMatchObject({ status: 'saved', previousAmount: '630.00' });
      expect((await versions(1)).map(v => [v.from, v.to, v.housing])).toEqual([
        ['2026-09-01', '2026-10-18', null],
        ['2026-10-19', '2026-11-30', '700.00'],
        ['2026-12-01', null, '700.00'],
      ]);
    });

    it('таблица: на сегодня, «Действует с» — начало цепочки с той же суммой', async () => {
      const rows = await listHousingAllowances({ ...SCOPE, period: { onDate: '2026-12-05' } });
      expect(rows).toEqual([{
        employee_id: 1, full_name: 'Акимов С.Ю.', department: 'ЛИНИЯ', position: null,
        amount: '700.00', effective_from: '2026-10-19',
      }]);
      expect(await listHousingAllowances({ ...SCOPE, period: { onDate: '2026-10-01' } })).toEqual([]);
    });

    it('снять — null с даты; в списке условий — та же сумма, что в таблице', async () => {
      expect(await setHousing(1, null, '2026-12-01')).toMatchObject({ status: 'saved' });
      expect((await versions(1)).map(v => v.housing)).toEqual([null, '700.00', null]);

      const res = makeRes();
      await payrollTermsController.list(req({ query: { date: '2026-11-01' } }), res);
      const row = res.body.data.find((r: { employee_id: number }) => r.employee_id === 1);
      // json_agg списка отдаёт суммы числом.
      expect(Number(row.housing_compensation)).toBe(700);
    });

    it('месяцы: последняя версия с доплатой, пересекающая месяцы; весь период — null', async () => {
      // Версии: сентябрь — без доплаты, 19.10–30.11 — 700, с 01.12 — снята.
      const amounts = async (monthStarts: string[] | null) =>
        (await listHousingAllowances({ ...SCOPE, period: { monthStarts } })).map(row => [row.amount, row.effective_from]);
      expect(await amounts(['2026-10-01'])).toEqual([['700.00', '2026-10-19']]);
      expect(await amounts(['2026-09-01', '2026-11-01'])).toEqual([['700.00', '2026-10-19']]);
      expect(await amounts(['2026-09-01'])).toEqual([]);
      expect(await amounts(['2026-12-01'])).toEqual([]);
      expect(await amounts(null)).toEqual([['700.00', '2026-10-19']]);
    });
  });

  describe('«Доплата»', () => {
    it('плановая: снятая не «оживает», добавление при текущей — exists; как в списке условий', async () => {
      const value = { amount: 5000, dateFrom: '2026-10-01', dateTo: '2026-12-31' };
      expect(await savePlannedSupplement({ employeeId: 2, value, createdBy: AUTHOR, onlyIfNone: true }))
        .toEqual({ status: 'saved', previous: null });
      expect(await savePlannedSupplement({ employeeId: 2, value, createdBy: AUTHOR, onlyIfNone: true }))
        .toEqual({ status: 'exists' });
      expect(await savePlannedSupplement({ employeeId: 2, value, createdBy: AUTHOR })).toEqual({ status: 'unchanged' });

      const planned = () => listSupplements(SCOPE).then(rows => rows.filter(row => row.kind === 'planned'));
      expect(await planned()).toEqual([expect.objectContaining({
        employee_id: 2, amount: '5000.00', date_from: '2026-10-01', date_to: '2026-12-31',
      })]);

      const res = makeRes();
      await payrollTermsController.list(req(), res);
      const row = res.body.data.find((r: { employee_id: number }) => r.employee_id === 2);
      expect(Number(row.planned_supplement_amount)).toBe(5000);

      // Снята — последняя версия журнала с amount NULL; прежняя ненулевая не показывается.
      expect(await savePlannedSupplement({ employeeId: 2, value: null, createdBy: AUTHOR }))
        .toMatchObject({ status: 'saved', previous: { amount: 5000 } });
      expect(await planned()).toEqual([]);
      expect(await savePlannedSupplement({ employeeId: 2, value, createdBy: AUTHOR, onlyIfNone: true }))
        .toMatchObject({ status: 'saved', previous: null });
    });

    it('разовые: несколько за месяц; подрядчик в таблицу не попадает', async () => {
      await addOneTimeSupplement(2, { month: '2026-10', amount: 10000, reason: 'Премия за объект' });
      await addOneTimeSupplement(2, { month: '2026-10', amount: 2500.5, reason: 'Переработка' });
      await addOneTimeSupplement(3, { month: '2026-10', amount: 1000, reason: 'Подрядчик' });
      const oneTime = (await listSupplements(SCOPE)).filter(row => row.kind === 'one_time');
      expect(oneTime.map(row => [row.employee_id, row.month, row.amount, row.reason])).toEqual(expect.arrayContaining([
        [2, '2026-10', '10000.00', 'Премия за объект'],
        [2, '2026-10', '2500.50', 'Переработка'],
      ]));
      expect(oneTime).toHaveLength(2);
    });
  });

  describe('«Без проезда»', () => {
    it('периоды не пересекаются; стык — можно; «по» закрывает бессрочный', async () => {
      const first = await addCompensationStop(1, { date_from: '2026-08-01', date_to: null });
      if (first === 'overlap') throw new Error('первый период не добавился');
      expect(await addCompensationStop(1, { date_from: '2026-09-01', date_to: '2026-09-30' })).toBe('overlap');

      expect(await updateCompensationStop(first.id, { date_from: '2026-08-01', date_to: '2026-08-31' }))
        .toMatchObject({ before: { date_to: null }, after: { date_to: '2026-08-31' } });
      // Включительно: 31.08 занят, с 01.09 — новый период.
      expect(await addCompensationStop(1, { date_from: '2026-08-31', date_to: null })).toBe('overlap');
      expect(await addCompensationStop(1, { date_from: '2026-09-01', date_to: null })).toMatchObject({ date_from: '2026-09-01' });

      expect((await listCompensationStops(SCOPE)).map(row => [row.employee_id, row.date_from, row.date_to])).toEqual([
        [1, '2026-08-01', '2026-08-31'],
        [1, '2026-09-01', null],
      ]);
    });
  });

  describe('«Удержания»', () => {
    it('по виду или по сумме в условиях на дату', async () => {
      await withTransaction(client => setEmployeeDeductionKinds(client, 2, [2, 1]));
      await run(`
        INSERT INTO payroll_compensation_terms (employee_id, staff_category, calc_type, hourly_rate, effective_from, deduction_amount)
        VALUES (6, 'worker', 'hourly', 450, '2026-10-01', 1500)
      `);
      const rows = await listDeductionRegistry({ ...SCOPE, period: { onDate: '2026-10-19' } });
      expect(rows.map(row => [row.employee_id, row.kinds, row.kind_ids, row.amount])).toEqual([
        [2, ['Корректировка удержаний', 'ТМЦ'], [1, 2], null],
        [6, [], [], '1500.00'],
      ]);
    });

    it('месяцы: сумма — из версии месяца; виды без дат — в любом месяце', async () => {
      const rows = async (monthStarts: string[] | null) =>
        (await listDeductionRegistry({ ...SCOPE, period: { monthStarts } })).map(row => [row.employee_id, row.amount]);
      expect(await rows(['2026-09-01'])).toEqual([[2, null]]);
      expect(await rows(['2026-10-01'])).toEqual([[2, null], [6, '1500.00']]);
      expect(await rows(null)).toEqual([[2, null], [6, '1500.00']]);
    });

    describe('сохранение из таблицы', () => {
      const save = async (employeeId: number, body: Record<string, unknown>) => {
        const res = makeRes();
        await payrollRegistryController.saveDeductions(req({ params: { empId: String(employeeId) }, body }), res);
        return res;
      };
      const kindsOf = async (employeeId: number) => (await run(
        'SELECT kind_id FROM payroll_employee_deductions WHERE employee_id = $1 ORDER BY kind_id', [employeeId],
      )).rows.map(row => row.kind_id);
      const deductionVersions = async (employeeId: number) => (await run(
        `SELECT to_char(effective_from, 'YYYY-MM-DD') AS from, to_char(effective_to, 'YYYY-MM-DD') AS to,
                deduction_amount::text AS amount, hourly_rate::text AS rate
           FROM payroll_compensation_terms WHERE employee_id = $1 ORDER BY effective_from`,
        [employeeId],
      )).rows;

      it('сумма без условий на дату — 409, виды тоже не сохранились', async () => {
        const res = await save(2, { kind_ids: [3], amount: 900, effective_from: '2026-10-19' });
        expect(res.statusCode).toBe(409);
        expect(res.body.code).toBe('NO_TERMS');
        expect(await kindsOf(2)).toEqual([1, 2]);
      });

      it('сумма null без условий — сохраняются только виды', async () => {
        const res = await save(2, { kind_ids: [3], amount: null, effective_from: '2026-10-19' });
        expect(res.statusCode).toBe(200);
        expect(res.body.data).toEqual({ changed: true });
        expect(await kindsOf(2)).toEqual([3]);
      });

      it('сумма с даты — разрез версии, ставка сохраняется', async () => {
        const res = await save(6, { kind_ids: [1], amount: 2000, effective_from: '2026-11-01' });
        expect(res.statusCode).toBe(200);
        expect(await deductionVersions(6)).toEqual([
          { from: '2026-10-01', to: '2026-10-31', amount: '1500.00', rate: '450.0000' },
          { from: '2026-11-01', to: null, amount: '2000.00', rate: '450.0000' },
        ]);
        expect(await kindsOf(6)).toEqual([1]);
      });

      it('два параллельных сохранения — итог целиком одного из них', async () => {
        const [first, second] = await Promise.all([
          save(6, { kind_ids: [1], amount: 3000, effective_from: '2026-12-01' }),
          save(6, { kind_ids: [2], amount: 4000, effective_from: '2026-12-01' }),
        ]);
        expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
        const amount = (await deductionVersions(6)).at(-1)?.amount;
        const kinds = await kindsOf(6);
        expect([[[1], '3000.00'], [[2], '4000.00']]).toContainEqual([kinds, amount]);
      });

      it('снять — пустые виды и сумма null с даты', async () => {
        const res = await save(6, { kind_ids: [], amount: null, effective_from: '2027-01-01' });
        expect(res.statusCode).toBe(200);
        expect(await kindsOf(6)).toEqual([]);
        expect((await deductionVersions(6)).at(-1)).toMatchObject({ from: '2027-01-01', amount: null });
      });
    });
  });
});
