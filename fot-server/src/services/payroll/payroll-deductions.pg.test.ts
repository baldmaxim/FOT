import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../../types/index.js';

// Справочник видов удержаний (миграция 299) и справочник ставок (миграция 306) на настоящем PostgreSQL: засев
// и повторный запуск, уникальность названия, переименование и удаление вида, ставки. Сумма удержания из окна
// сотрудника с миграции 321 в условия не пишется (удержания — staff_deductions, staff-deductions.pg.test.ts).
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
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

vi.mock('../../config/contractor.js', () => ({ getContractorRootId: async () => null }));

vi.mock('../audit.service.js', () => ({ auditService: { logFromRequest: async () => undefined } }));

import { addDeductionKind, deleteDeductionKind, renameDeductionKind } from './payroll-deduction-kinds.service.js';
import { listDeductionKindTree } from './payroll-deduction-subkinds.service.js';
import { addRate, deleteRate, listRates, updateRate } from './payroll-rates.service.js';
import { payrollTermsController } from '../../controllers/payroll-terms.controller.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');

const AUTHOR = '00000000-0000-0000-0000-00000000000c';

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const assign = async (employeeId: number, extra: Record<string, unknown>) => {
  const res = makeRes();
  await payrollTermsController.assign({
    user: { id: AUTHOR },
    params: { empId: String(employeeId) },
    query: {},
    body: { staff_category: 'worker', calc_type: 'hourly', hourly_rate: 450, effective_from: '2026-10-01', ...extra },
  } as unknown as AuthenticatedRequest, res);
  return res;
};

describe.skipIf(!PG_URL)('виды удержаний на PostgreSQL', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS payroll_paid_amounts, payroll_planned_supplements, payroll_settings, payroll_item_types,
        payroll_rates, payroll_compensation_terms, staff_deductions, payroll_employee_deductions, payroll_deduction_subkinds,
        payroll_deduction_kinds, employee_schedule_assignments, work_schedules, positions,
        user_profiles, employees, org_departments CASCADE;
      DROP FUNCTION IF EXISTS public.get_descendant_department_ids(uuid[]);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text);
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
      CREATE FUNCTION public.get_descendant_department_ids(uuid[]) RETURNS TABLE(id uuid)
        LANGUAGE sql AS $$ SELECT unnest($1) $$;
      INSERT INTO employees (id, full_name) VALUES (1, 'Акимов С.Ю.'), (2, 'Борисов А.А.'), (3, 'Васильев В.В.');
      INSERT INTO user_profiles (id, full_name) VALUES ('${AUTHOR}', 'Петрова А.А.');
    `);
    await pg.pool!.query(migration('271_payroll_terms.sql'));
    await pg.pool!.query(migration('282_payroll_terms_bonus_housing.sql'));
    await pg.pool!.query(migration('286_payroll_terms_compensations.sql'));
    await pg.pool!.query(migration('293_payroll_planned_supplements.sql'));
    await pg.pool!.query(migration('295_payroll_paid_amounts.sql'));
    await pg.pool!.query(migration('299_payroll_deduction_kinds.sql'));
    await pg.pool!.query(migration('300_payroll_employee_deductions.sql'));
    await pg.pool!.query(migration('301_payroll_paid_order_kinds.sql'));
    await pg.pool!.query(migration('306_payroll_rates.sql'));
    await pg.pool!.query(migration('313_payroll_rate_code.sql'));
    // Повторный запуск безопасен: виды не задваиваются.
    await pg.pool!.query(migration('299_payroll_deduction_kinds.sql'));
    await pg.pool!.query(migration('300_payroll_employee_deductions.sql'));
    await pg.pool!.query(migration('301_payroll_paid_order_kinds.sql'));
    await pg.pool!.query(migration('306_payroll_rates.sql'));
    await pg.pool!.query(migration('313_payroll_rate_code.sql'));
    // Ставка «Проживание общежития» из 313 проверяется в dormitory-stays.pg.test.ts; здесь — обычные ставки.
    await pg.pool!.query(`DELETE FROM payroll_rates WHERE code = 'dormitory'`);
    // Из 318 — только то, что читают виды: сумма вида по умолчанию и удержания (сотрудник и вид);
    // подвиды и подвид удержания — из 321.
    await pg.pool!.query(`ALTER TABLE payroll_deduction_kinds ADD COLUMN default_amount numeric(12,2)`);
    await pg.pool!.query(`CREATE TABLE staff_deductions (
      employee_id integer NOT NULL, kind_id integer NOT NULL REFERENCES payroll_deduction_kinds(id) ON DELETE RESTRICT)`);
    await pg.pool!.query(migration('321_payroll_deduction_subkinds.sql'));
  });

  const listKinds = async () => (await listDeductionKindTree()).map(({ id, name }) => ({ id, name }));

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('засев — 6 видов (299) и удержания «Оплачено» (301) по порядку, повтор миграций их не задваивает', async () => {
    expect((await listKinds()).map(kind => kind.name)).toEqual([
      'Корректировка удержаний', 'ТМЦ', 'Штраф за мусор', 'Спецодежда', 'Питание', 'Штрафы',
      'Нарушение техники безопасности', 'Удержание по исп. листу',
    ]);
  });

  it('новый вид — в конец; то же название без учёта регистра и пробелов — дубль', async () => {
    const added = await addDeductionKind('Штраф за опоздание');
    expect(added?.name).toBe('Штраф за опоздание');
    expect(await addDeductionKind('штраф за ОПОЗДАНИЕ')).toBeNull();
    expect(await addDeductionKind(' Штрафы ')).toBeNull();
    const kinds = await listKinds();
    expect(kinds).toHaveLength(9);
    expect(kinds[8]).toEqual(added);
  });

  it('321: сумма удержания из окна сотрудника не пишется — 0 принят, больше нуля — 409', async () => {
    expect((await assign(3, { deduction_amount: 0 })).statusCode).toBe(200);
    const saved = await pg.pool!.query(
      `SELECT deduction_amount::text AS amount FROM payroll_compensation_terms WHERE employee_id = 3`,
    );
    expect(saved.rows).toEqual([{ amount: null }]);

    const refused = await assign(3, { deduction_amount: 100, effective_from: '2026-11-01' });
    expect(refused.statusCode).toBe(409);
    expect(refused.body.code).toBe('DEDUCTION_MOVED');
    expect((await pg.pool!.query(`SELECT count(*)::int AS n FROM payroll_compensation_terms WHERE employee_id = 3`)).rows)
      .toEqual([{ n: 1 }]);
  });

  it('переименование: новое название и прежнее для аудита; занятое — дубль; вида нет — null', async () => {
    const byName = Object.fromEntries((await listKinds()).map(kind => [kind.name, kind.id]));
    const id = byName['Штраф за мусор'];

    expect(await renameDeductionKind(id, 'Штраф за мусор на объекте'))
      .toEqual({ kind: { id, name: 'Штраф за мусор на объекте' }, previousName: 'Штраф за мусор' });
    // Свой же вид в другом регистре — не дубль.
    expect(await renameDeductionKind(id, 'ШТРАФ за мусор на объекте'))
      .toEqual({ kind: { id, name: 'ШТРАФ за мусор на объекте' }, previousName: 'Штраф за мусор на объекте' });
    expect(await renameDeductionKind(id, ' питание')).toBe('duplicate');
    expect(await renameDeductionKind(9999, 'Нет такого')).toBeNull();

    // Порядок списка от названия не зависит.
    expect((await listKinds())[2]).toEqual({ id, name: 'ШТРАФ за мусор на объекте' });
  });

  it('удаление: свободный вид уходит, назначенный удержаниям — остаётся с числом разных сотрудников', async () => {
    const byName = Object.fromEntries((await listKinds()).map(kind => [kind.name, kind.id]));
    // «Питание» — у Акимова (1, дважды) и Васильева (3); «ТМЦ» — у Акимова.
    await pg.pool!.query(
      `INSERT INTO staff_deductions (employee_id, kind_id) VALUES ($1, $2), ($1, $2), ($3, $2), ($1, $4)`,
      [1, byName['Питание'], 3, byName['ТМЦ']],
    );

    expect(await deleteDeductionKind(byName['Питание'])).toEqual({ inUse: 2 });
    expect(await deleteDeductionKind(byName['ТМЦ'])).toEqual({ inUse: 1 });
    expect(await deleteDeductionKind(byName['Спецодежда'])).toEqual({ id: byName['Спецодежда'], name: 'Спецодежда' });
    expect(await deleteDeductionKind(byName['Спецодежда'])).toBeNull();

    const names = (await listKinds()).map(kind => kind.name);
    expect(names).toContain('Питание');
    expect(names).not.toContain('Спецодежда');

    // Удержаний с видом не осталось — теперь удаляется.
    await pg.pool!.query(`DELETE FROM staff_deductions WHERE kind_id = $1`, [byName['ТМЦ']]);
    expect(await deleteDeductionKind(byName['ТМЦ'])).toEqual({ id: byName['ТМЦ'], name: 'ТМЦ' });
  });

  it('306: ставки — порядок добавления, значение можно не задать, название уникально', async () => {
    expect(await listRates()).toEqual([]);

    const fitter = await addRate('Монтажник 3 разряда', 450.5);
    const welder = await addRate('Сварщик', null);
    expect(fitter).toEqual({ id: expect.any(Number), name: 'Монтажник 3 разряда', amount: '450.50', code: null });
    expect(welder).toEqual({ id: expect.any(Number), name: 'Сварщик', amount: null, code: null });
    expect(await addRate(' сварщик', 1)).toBeNull();
    expect(await addRate('Подсобный', 0)).toMatchObject({ amount: '0.00' });
    expect((await listRates()).map(rate => rate.name)).toEqual(['Монтажник 3 разряда', 'Сварщик', 'Подсобный']);

    await expect(pg.pool!.query(`INSERT INTO payroll_rates (name, amount) VALUES ('Минус', -1)`))
      .rejects.toThrow(/payroll_rate_amount/);
    await expect(pg.pool!.query(`INSERT INTO payroll_rates (name) VALUES ('  ')`))
      .rejects.toThrow(/payroll_rate_name/);
  });

  it('306: правка ставки отдаёт «было» и «стало»; занятое название — дубль; удаление', async () => {
    const [fitter, welder] = await listRates();

    expect(await updateRate(welder.id, 'Сварщик 5 разряда', 520)).toEqual({
      before: { id: welder.id, name: 'Сварщик', amount: null, code: null },
      after: { id: welder.id, name: 'Сварщик 5 разряда', amount: '520.00', code: null },
    });
    // Значение снимается — снова «не задано».
    expect(await updateRate(welder.id, 'Сварщик 5 разряда', null)).toMatchObject({
      before: { amount: '520.00' }, after: { amount: null },
    });
    expect(await updateRate(welder.id, 'монтажник 3 разряда', 1)).toBe('duplicate');
    expect(await updateRate(9999, 'Нет такой', 1)).toBeNull();
    // Порядок списка — по добавлению, не по правке.
    expect((await listRates()).map(rate => rate.id).slice(0, 2)).toEqual([fitter.id, welder.id]);

    expect(await deleteRate(fitter.id)).toEqual(fitter);
    expect(await deleteRate(fitter.id)).toBeNull();
    expect((await listRates()).map(rate => rate.name)).toEqual(['Сварщик 5 разряда', 'Подсобный']);
  });
});
