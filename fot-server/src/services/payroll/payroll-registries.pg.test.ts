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

vi.mock('../audit.service.js', () => ({ auditService: { logFromRequest: async () => undefined } }));

import { currentRateMonth, listRates, shiftRateMonth, updateRate } from './payroll-rates.service.js';
import { listHousingAllowances } from './payroll-housing.service.js';
import { addStay, getHousingRateAmount } from '../dormitory-stays.service.js';
import {
  addOneTimeSupplement,
  getPlannedPeriodEmployeeId,
  listSupplements,
  rewritePlannedPeriod,
  savePlannedSupplement,
} from './payroll-supplements.service.js';
import { getPlannedSupplementChanges } from './payroll-terms.service.js';
import {
  addCompensationStop,
  listCompensationStops,
  updateCompensationStop,
} from './payroll-compensation-stops.service.js';
import {
  addOvertimeStop,
  deleteOvertimeStop,
  listOvertimeStops,
  updateOvertimeStop,
} from './payroll-overtime-stops.service.js';
import { listDeductionKindTree } from './payroll-deduction-subkinds.service.js';
import { deleteDeduction, listDeductions } from '../staff-deductions.service.js';
import { canWritePayrollRegistryEmployee, isPayrollStaffEmployee } from './payroll-registry-scope.service.js';
import { payrollTermsController } from '../../controllers/payroll-terms.controller.js';
import { payrollStaffDeductionsController } from '../../controllers/payroll-staff-deductions.controller.js';

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

/** Квартира (доплата за проживание, миграция 320) — через сервис проживаний. */
const addApartment = (employeeId: number, checkIn: string, checkOut: string | null, amount: number, address: string | null = null) =>
  addStay(employeeId, { kind: 'apartment', check_in: checkIn, check_out: checkOut, address, amount });

describe.skipIf(!PG_URL)('таблицы «Справочника» на PostgreSQL', () => {
  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS dormitory_addresses, employee_dormitory_stays, role_page_access, access_pages,
        payroll_dormitory_allowances, payroll_compensation_stops, payroll_overtime_stops,
        payroll_one_time_supplements, payroll_paid_amounts,
        payroll_planned_supplements, payroll_settings, payroll_item_types, payroll_rate_values, payroll_rates,
        payroll_compensation_terms,
        staff_deductions, payroll_employee_deductions, payroll_deduction_subkinds, payroll_deduction_kinds,
        employee_schedule_assignments, work_schedules, positions,
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
      -- «Доплата за общежитие» (317) — пустая: «Доплата за проживание» сверяется с ней (одна доплата из двух).
      CREATE TABLE payroll_dormitory_allowances (
        id serial PRIMARY KEY, employee_id integer NOT NULL, date_from date NOT NULL, date_to date
      );
      -- Права для миграции 314 (проживание): столбцы и ключи — как на проде.
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
    await run(`INSERT INTO payroll_rates (name, amount) VALUES ('Сварщик', 520), ('Проживание общежития', 630)`);
    await run(migration('313_payroll_rate_code.sql'));
    for (const name of [
      '314_employee_dormitory_stays.sql', '318_staff_deductions.sql', '319_dormitory_addresses.sql',
      '320_dormitory_stays_apartment.sql', '321_payroll_deduction_subkinds.sql', '322_payroll_planned_supplement_open_end.sql',
      '337_payroll_planned_supplement_rewrite.sql',
    ]) {
      await run(migration(name));
    }
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('315: ставка стала «Доплатой за проживание» (code housing), значение то же; повтор безопасен', async () => {
    const [before] = (await run(`SELECT id FROM payroll_rates WHERE code = 'dormitory'`)).rows;
    await run(migration('315_payroll_dictionary_registries.sql'));
    await run(migration('315_payroll_dictionary_registries.sql'));
    // 324 — значения по месяцам и «Проезд»; ставки с кодом — первыми.
    await run(migration('324_payroll_rate_values.sql'));
    await run(migration('324_payroll_rate_values.sql'));
    expect(await listRates()).toEqual([
      { id: before.id, name: 'Доплата за проживание', amount: '630.00', code: 'housing',
        values: [{ effective_from: '2000-01', amount: '630.00' }] },
      { id: expect.any(Number), name: 'Проезд', amount: null, code: 'travel', values: [] },
      { id: expect.any(Number), name: 'Сварщик', amount: '520.00', code: null,
        values: [{ effective_from: '2000-01', amount: '520.00' }] },
    ]);
  });

  it('«Условия оплаты»: поиск ФИО — ё = е, раскладка, одна ошибка только без точных; фильтр «ФИО» — без ошибок', async () => {
    const found = async (query: Record<string, string>) => {
      const res = makeRes();
      await payrollTermsController.list(req({ query }), res);
      return res.body.data.map((r: { employee_id: number }) => r.employee_id);
    };
    expect(await found({ q: 'акимов' })).toEqual([1]);
    expect(await found({ q: 'fRBVJD' })).toEqual([1]); // «акимов» в английской раскладке
    expect(await found({ q: 'акмов' })).toEqual([1]); // пропущена буква
    expect(await found({ q: 'борисов' })).toEqual([2]);
    expect(await found({ q: 'боирсов' })).toEqual([2]); // переставлены соседние
    // Точный есть — похожие с ошибкой не подмешиваются: «Егоров» не тянет «Егорав…» и наоборот.
    expect(await found({ q: 'егоров' })).toEqual([6]);
    // Фильтр столбца «ФИО» — точно, без опечаток.
    expect(await found({ cf: JSON.stringify({ text: { name: 'Акимов' } }) })).toEqual([1]);
    expect(await found({ cf: JSON.stringify({ text: { name: 'акмов' } }) })).toEqual([]);
  });

  it('«Расчёты» из карточки: employee_id — ровно один сотрудник, тёзки не попадают; без ФИО — тоже по id', async () => {
    await run(`INSERT INTO employees (id, full_name, org_department_id) VALUES
      (7, 'Тёзкин Иван Иванович', '${D1}'), (8, 'Тёзкин Иван Иванович', '${D1}'), (9, NULL, '${D1}')`);
    try {
      const list = async (query: Record<string, string>) => {
        const res = makeRes();
        await payrollTermsController.list(req({ query }), res);
        return res;
      };
      const ids = async (query: Record<string, string>) => (await list(query)).body.data
        .map((r: { employee_id: number }) => r.employee_id);
      expect(await ids({ q: 'Тёзкин Иван Иванович' })).toEqual([7, 8]);
      expect(await ids({ q: 'Тёзкин Иван Иванович', employee_id: '8' })).toEqual([8]);
      expect(await ids({ employee_id: '9' })).toEqual([9]);
      expect((await list({ employee_id: '9' })).body.meta.total).toBe(1);
      expect((await list({ employee_id: 'abc' })).statusCode).toBe(400);
    } finally {
      await run('DELETE FROM employees WHERE id IN (7, 8, 9)');
    }
  });

  it('324: «Проезд» в списке условий — ставка за месяц даты и «Без проезда» в месяце; квартира — ставка текущего месяца', async () => {
    const month = currentRateMonth();
    const [housing, travel] = await listRates();
    await updateRate(travel.id, travel.name, 2730, month);
    await run(`INSERT INTO payroll_compensation_stops (employee_id, date_from, date_to) VALUES (2, '2026-09-15', '2026-09-20')`);
    const travelOn = async (date: string) => {
      const res = makeRes();
      await payrollTermsController.list(req({ query: { date } }), res);
      const byId = new Map<number, { travel_rate: string | null; travel_stopped: boolean }>(
        res.body.data.map((r: { employee_id: number; travel_rate: string | null; travel_stopped: boolean }) => [r.employee_id, r]),
      );
      return [1, 2].map(id => [byId.get(id)?.travel_rate, byId.get(id)?.travel_stopped]);
    };
    // Первое значение — «с начала»: и в прошлом месяце 2730; «Без проезда» задевает только сентябрь.
    expect(await travelOn('2026-09-01')).toEqual([['2730.00', false], ['2730.00', true]]);
    expect(await travelOn('2026-10-01')).toEqual([['2730.00', false], ['2730.00', false]]);

    // Сумма квартиры по умолчанию — ставка «Доплата за проживание» на текущий месяц: будущая смена её не трогает.
    const next = shiftRateMonth(month, 1);
    await updateRate(housing.id, housing.name, 700, next);
    expect(await getHousingRateAmount()).toBe('630.00');
    await updateRate(housing.id, housing.name, 630, next);

    await run(`DELETE FROM payroll_compensation_stops WHERE employee_id = 2`);
  });

  it('«штат зарплаты»: подрядчик, уволенный и архивный — не пишутся', async () => {
    expect(await isPayrollStaffEmployee(1, SCOPE)).toBe(true);
    for (const id of [3, 4, 5]) {
      expect(await isPayrollStaffEmployee(id, SCOPE), String(id)).toBe(false);
      expect(await canWritePayrollRegistryEmployee(req(), id), String(id)).toBe(false);
    }
    expect(await isPayrollStaffEmployee(1, { ...SCOPE, departmentIds: [] })).toBe(false);
  });

  describe('«Доплата за проживание» — квартиры «Проживания» (миграция 320)', () => {
    beforeAll(async () => {
      // Оклад нужен только Акимову — Егорову (без условий) квартиру вносят так же.
      await run(`
        INSERT INTO payroll_compensation_terms
          (employee_id, staff_category, calc_type, monthly_salary, effective_from, effective_to, created_by)
        VALUES (1, 'itr', 'salary', 150000, '2026-09-01', NULL, '${AUTHOR}');
      `);
      expect(await addApartment(1, '2026-09-01', '2026-10-01', 630)).toMatchObject({ kind: 'apartment' });
      expect(await addApartment(6, '2026-10-19', '2026-12-01', 700, 'ул. Рабочая, 5')).toMatchObject({ kind: 'apartment' });
      expect(await addApartment(3, '2026-10-01', null, 630)).toMatchObject({ kind: 'apartment' });
      expect(await addStay(2, { kind: 'dormitory', check_in: '2026-10-01', check_out: null, address: 'Общ1', amount: null }))
        .toMatchObject({ kind: 'dormitory' });
    });

    it('на дату: квартира, в которой живёт в этот день; без оклада — тоже; общежитие и подрядчик — нет', async () => {
      expect(await listHousingAllowances({ ...SCOPE, period: { onDate: '2026-11-05' } })).toEqual([{
        id: expect.any(Number), employee_id: 6, full_name: 'Егоров Без оклада', department: 'ЛИНИЯ', position: null,
        amount: '700.00', check_in: '2026-10-19', check_out: '2026-12-01', address: 'ул. Рабочая, 5',
      }]);
      // День выезда — уже не живёт.
      expect(await listHousingAllowances({ ...SCOPE, period: { onDate: '2026-12-01' } })).toEqual([]);
    });

    it('месяцы: задевающие хоть один месяц; выезд 1-го числа — в этом месяце уже нет; весь период — все', async () => {
      const names = async (monthStarts: string[] | null) =>
        (await listHousingAllowances({ ...SCOPE, period: { monthStarts } })).map(row => [row.employee_id, row.amount]);
      expect(await names(['2026-09-01'])).toEqual([[1, '630.00']]);
      expect(await names(['2026-10-01'])).toEqual([[6, '700.00']]);
      expect(await names(['2026-09-01', '2026-11-01'])).toEqual([[1, '630.00'], [6, '700.00']]);
      expect(await names(['2026-12-01'])).toEqual([]);
      expect(await names(null)).toEqual([[1, '630.00'], [6, '700.00']]);
      expect(await listHousingAllowances({ ...SCOPE, departmentIds: [], period: { monthStarts: null } })).toEqual([]);
    });

    it('список условий: «Компенсация проживания» — сумма квартиры на дату выборки, не условия оплаты', async () => {
      const housingOn = async (date: string) => {
        const res = makeRes();
        await payrollTermsController.list(req({ query: { date } }), res);
        const byId = new Map<number, unknown>(res.body.data.map(
          (r: { employee_id: number; housing_compensation: unknown }) => [r.employee_id, r.housing_compensation],
        ));
        return [1, 6].map(id => (byId.get(id) === null ? null : Number(byId.get(id))));
      };
      expect(await housingOn('2026-09-15')).toEqual([630, null]);
      expect(await housingOn('2026-11-01')).toEqual([null, 700]);
      expect((await versions(1)).map(v => v.housing)).toEqual([null]);
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

    it('плановая: «убрали» укороченной версией, потом новый период — прежний остаётся историей; правка — нет', async () => {
      const planned6 = () => listSupplements(SCOPE)
        .then(rows => rows.filter(row => row.kind === 'planned' && row.employee_id === 6));
      const julDec = { amount: 3000, dateFrom: '2026-07-01', dateTo: '2026-12-31' };
      await savePlannedSupplement({ employeeId: 6, value: julDec, createdBy: AUTHOR, onlyIfNone: true });
      // Правка суммы на том же периоде — исправление: видна только новая версия.
      await savePlannedSupplement({ employeeId: 6, value: { ...julDec, amount: 3500 }, createdBy: AUTHOR });
      expect(await planned6()).toEqual([expect.objectContaining({ amount: '3500.00', is_current: true })]);

      // «Убрали» с 01.10 — версия по 30.09.
      await savePlannedSupplement({ employeeId: 6, value: { amount: 3500, dateFrom: '2026-07-01', dateTo: '2026-09-30' }, createdBy: AUTHOR });
      // Новый период: пересекается с текущей — exists, не пересекается — новая версия.
      expect(await savePlannedSupplement({
        employeeId: 6, value: { amount: 4000, dateFrom: '2026-09-15', dateTo: '2026-12-31' }, createdBy: AUTHOR, onlyIfNone: true,
      })).toEqual({ status: 'exists' });
      expect(await savePlannedSupplement({
        employeeId: 6, value: { amount: 4000, dateFrom: '2026-12-01', dateTo: '2027-02-28' }, createdBy: AUTHOR, onlyIfNone: true,
      })).toMatchObject({ status: 'saved', previous: { amount: 3500, dateTo: '2026-09-30' } });
      expect(await planned6()).toEqual([
        expect.objectContaining({ amount: '3500.00', date_from: '2026-07-01', date_to: '2026-09-30', is_current: false }),
        expect.objectContaining({ amount: '4000.00', date_from: '2026-12-01', date_to: '2027-02-28', is_current: true }),
      ]);
      expect((await planned6()).every(row => typeof row.id === 'number')).toBe(true);

      // Новую сняли как ошибочную — прошлый период остаётся.
      await savePlannedSupplement({ employeeId: 6, value: null, createdBy: AUTHOR });
      expect(await planned6()).toEqual([expect.objectContaining({ date_to: '2026-09-30', is_current: false })]);
    });

    it('плановая бессрочная: пересекается с любым будущим периодом; «убрали» — новый период после неё', async () => {
      const planned1 = () => listSupplements(SCOPE)
        .then(rows => rows.filter(row => row.kind === 'planned' && row.employee_id === 1));
      const open = { amount: 20000, dateFrom: '2023-02-01', dateTo: null };
      expect(await savePlannedSupplement({ employeeId: 1, value: open, createdBy: AUTHOR, onlyIfNone: true }))
        .toEqual({ status: 'saved', previous: null });
      expect(await planned1()).toEqual([
        expect.objectContaining({ amount: '20000.00', date_from: '2023-02-01', date_to: null, is_current: true }),
      ]);
      expect(await savePlannedSupplement({
        employeeId: 1, value: { amount: 1000, dateFrom: '2030-01-01', dateTo: '2030-01-31' }, createdBy: AUTHOR, onlyIfNone: true,
      })).toEqual({ status: 'exists' });

      // «Убрали» с 01.10 — версия по 30.09; новый бессрочный с декабря — прежний период остаётся историей.
      await savePlannedSupplement({ employeeId: 1, value: { ...open, dateTo: '2026-09-30' }, createdBy: AUTHOR });
      expect(await savePlannedSupplement({
        employeeId: 1, value: { amount: 25000, dateFrom: '2026-12-01', dateTo: null }, createdBy: AUTHOR, onlyIfNone: true,
      })).toMatchObject({ status: 'saved', previous: { dateTo: '2026-09-30' } });
      expect(await planned1()).toEqual([
        expect.objectContaining({ amount: '20000.00', date_to: '2026-09-30', is_current: false }),
        expect.objectContaining({ amount: '25000.00', date_from: '2026-12-01', date_to: null, is_current: true }),
      ]);
    });

    it('337: любой период плановой (Корж) — правка, перенос, снятие переписывают расписание; история по периоду', async () => {
      await run(`INSERT INTO employees (id, full_name, org_department_id) VALUES (20, 'Корж И.С.', '${D1}')`);
      try {
        const planned = () => listSupplements(SCOPE)
          .then(rows => rows.filter(row => row.kind === 'planned' && row.employee_id === 20));
        const periods = async () => (await planned()).map(row => [row.amount, row.date_from, row.date_to]);
        const idOf = async (dateFrom: string) => (await planned()).find(row => row.date_from === dateFrom)!.id;
        // Как на проде (скрипт 28.10): бессрочные 20 000 → по 30.09, 30 000 окт–янв, 20 000 с февраля.
        for (const value of [
          { amount: 20000, dateFrom: '2023-03-01', dateTo: null },
          { amount: 20000, dateFrom: '2023-03-01', dateTo: '2026-09-30' },
          { amount: 30000, dateFrom: '2026-10-01', dateTo: '2027-01-31' },
          { amount: 20000, dateFrom: '2027-02-01', dateTo: null },
        ]) await savePlannedSupplement({ employeeId: 20, value, createdBy: AUTHOR });
        expect(await periods()).toEqual([
          ['20000.00', '2023-03-01', '2026-09-30'], ['30000.00', '2026-10-01', '2027-01-31'], ['20000.00', '2027-02-01', null],
        ]);

        // Добавление сверяется со всеми периодами, а не с последним: ноябрь перекрыл бы 30 000 целиком.
        expect(await savePlannedSupplement({
          employeeId: 20, value: { amount: 1000, dateFrom: '2026-11-01', dateTo: '2026-11-30' }, createdBy: AUTHOR, onlyIfNone: true,
        })).toEqual({ status: 'exists' });

        // Сумма среднего периода; крайние не меняются.
        const middle = await idOf('2026-10-01');
        expect(await getPlannedPeriodEmployeeId(middle)).toBe(20);
        const octJan = { amount: 35000, dateFrom: '2026-10-01', dateTo: '2027-01-31' };
        expect(await rewritePlannedPeriod({ employeeId: 20, periodId: middle, value: octJan, createdBy: AUTHOR }))
          .toEqual({ status: 'saved', previous: { amount: 30000, dateFrom: '2026-10-01', dateTo: '2027-01-31' } });
        expect(await periods()).toEqual([
          ['20000.00', '2023-03-01', '2026-09-30'], ['35000.00', '2026-10-01', '2027-01-31'], ['20000.00', '2027-02-01', null],
        ]);
        // Прежний id — уже архив; пересечение с февралём; без изменений.
        expect(await rewritePlannedPeriod({ employeeId: 20, periodId: middle, value: octJan, createdBy: AUTHOR }))
          .toEqual({ status: 'stale' });
        const edited = await idOf('2026-10-01');
        expect(await rewritePlannedPeriod({
          employeeId: 20, periodId: edited, value: { ...octJan, dateTo: '2027-02-15' }, createdBy: AUTHOR,
        })).toEqual({ status: 'exists' });
        expect(await rewritePlannedPeriod({ employeeId: 20, periodId: edited, value: octJan, createdBy: AUTHOR }))
          .toEqual({ status: 'unchanged' });

        // Перенос дат мимо прежних версий: октябрь и январь не «оживают» прежними 30 000.
        await rewritePlannedPeriod({
          employeeId: 20, periodId: edited, value: { amount: 35000, dateFrom: '2026-11-01', dateTo: '2026-12-31' }, createdBy: AUTHOR,
        });
        expect(await periods()).toEqual([
          ['20000.00', '2023-03-01', '2026-09-30'], ['35000.00', '2026-11-01', '2026-12-31'], ['20000.00', '2027-02-01', null],
        ]);

        // Окно сотрудника после переписывания правит последний по дате период — февральский.
        expect(await savePlannedSupplement({
          employeeId: 20, value: { amount: 25000, dateFrom: '2027-02-01', dateTo: null }, createdBy: AUTHOR,
        })).toMatchObject({ status: 'saved', previous: { amount: 20000, dateFrom: '2027-02-01' } });

        // Снять средний: крайние остаются.
        expect(await rewritePlannedPeriod({
          employeeId: 20, periodId: await idOf('2026-11-01'), value: null, createdBy: AUTHOR,
        })).toMatchObject({ status: 'saved' });
        expect(await periods()).toEqual([['20000.00', '2023-03-01', '2026-09-30'], ['25000.00', '2027-02-01', null]]);

        // История: «было → стало» по периоду, копии не видны, «снята» — со снятым периодом.
        const history = (await getPlannedSupplementChanges(20)).map(change => [change.action, change.amount, change.prev_amount]);
        expect(history).toEqual([
          ['removed', null, '35000.00'],
          ['changed', '25000.00', '20000.00'],
          ['changed', '35000.00', '35000.00'],
          ['changed', '35000.00', '30000.00'],
          ['changed', '20000.00', '30000.00'],
          ['changed', '30000.00', '20000.00'],
          ['changed', '20000.00', '20000.00'],
          ['assigned', '20000.00', null],
        ]);
      } finally {
        await run('DELETE FROM payroll_planned_supplements WHERE employee_id = 20');
        await run('DELETE FROM employees WHERE id = 20');
      }
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

  describe('«Без переработки» (миграция 335)', () => {
    it('повтор миграции безопасен; периоды не пересекаются, стык — можно; подрядчика в списке нет', async () => {
      await run(migration('335_payroll_overtime_stops.sql'));
      await run(migration('335_payroll_overtime_stops.sql'));

      const first = await addOvertimeStop(2, { date_from: '2026-09-15', date_to: null });
      if (first === 'overlap') throw new Error('первый период не добавился');
      expect(await addOvertimeStop(2, { date_from: '2026-10-01', date_to: '2026-10-31' })).toBe('overlap');
      expect(await updateOvertimeStop(first.id, { date_from: '2026-09-15', date_to: '2026-09-30' }))
        .toMatchObject({ before: { date_to: null }, after: { date_to: '2026-09-30' } });
      // Включительно: 30.09 занят, с 01.10 — новый период.
      expect(await addOvertimeStop(2, { date_from: '2026-09-30', date_to: null })).toBe('overlap');
      const second = await addOvertimeStop(2, { date_from: '2026-10-01', date_to: null });
      expect(second).toMatchObject({ date_from: '2026-10-01', full_name: 'Борисов А.А.' });
      await expect(run(`INSERT INTO payroll_overtime_stops (employee_id, date_from, date_to)
        VALUES (2, '2026-12-10', '2026-12-01')`)).rejects.toThrow(/payroll_overtime_stop_dates/);
      expect(await addOvertimeStop(3, { date_from: '2026-09-01', date_to: null })).toMatchObject({ employee_id: 3 });

      expect((await listOvertimeStops(SCOPE)).map(row => [row.employee_id, row.date_from, row.date_to])).toEqual([
        [2, '2026-09-15', '2026-09-30'],
        [2, '2026-10-01', null],
      ]);
      if (second !== 'overlap') expect(await deleteOvertimeStop(second.id)).toMatchObject({ id: second.id });
      expect((await listOvertimeStops(SCOPE)).length).toBe(1);
    });
  });

  describe('«Удержания» — те же записи, что во вкладке кадров (миграция 321)', () => {
    const call = async (
      handler: 'add' | 'update' | 'remove' | 'list',
      over: Record<string, unknown>,
    ) => {
      const res = makeRes();
      await payrollStaffDeductionsController[handler](req(over), res);
      return res;
    };
    const kinds = async () => Object.fromEntries((await listDeductionKindTree()).map(kind => [kind.name, kind.id]));

    it('добавили в «Зарплате» — видно кадрам; удалили у кадров — нет и в «Зарплате»', async () => {
      const { Спецодежда: workwear } = await kinds();
      const added = await call('add', { body: { employee_id: 2, kind_id: workwear, month: '2026-10', amount: 800 } });
      expect(added.statusCode).toBe(200);
      expect(added.body.data).toMatchObject({ employee_id: 2, kind_name: 'Спецодежда', subkind_id: null, amount: '800.00' });
      expect((await listDeductions({ employeeIds: [2] })).map(row => row.id)).toEqual([added.body.data.id]);

      const listed = await call('list', { query: { months: '2026-10' } });
      expect(listed.body.data).toEqual([{ ...added.body.data, can_edit: true }]);

      await deleteDeduction(added.body.data.id);
      expect((await call('list', { query: { months: 'all' } })).body.data).toEqual([]);
    });

    it('правка в «Зарплате» видна кадрам; подрядчику, уволенному, архивному — не добавить; чужое — 403', async () => {
      const { Штрафы: fines, Питание: meals } = await kinds();
      const added = await call('add', { body: { employee_id: 1, kind_id: fines, month: '2026-10', amount: 1000 } });
      const updated = await call('update', {
        params: { id: String(added.body.data.id) },
        body: { kind_id: meals, month: '2026-11', amount: 500 },
      });
      expect(updated.statusCode).toBe(200);
      expect(await listDeductions({ employeeIds: [1] })).toEqual([
        expect.objectContaining({ kind_name: 'Питание', month: '2026-11', amount: '500.00' }),
      ]);

      for (const [employeeId, status] of [[3, 400], [4, 400], [5, 400], [999, 404]]) {
        const res = await call('add', { body: { employee_id: employeeId, kind_id: meals, month: '2026-10', amount: 1 } });
        expect(res.statusCode, String(employeeId)).toBe(status);
      }

      // Строку уволенного «Зарплата» не правит: её правят кадры.
      await run(`INSERT INTO staff_deductions (employee_id, kind_id, month, amount) VALUES (4, $1, '2026-09-01', 300)`, [meals]);
      const dismissedRow = (await listDeductions({ employeeIds: [4] }))[0];
      const denied = await call('remove', { params: { id: String(dismissedRow.id) } });
      expect(denied.statusCode).toBe(403);
      expect(await listDeductions({ employeeIds: [4] })).toHaveLength(1);
    });
  });
});
