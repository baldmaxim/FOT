import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { Response } from 'express';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuthenticatedRequest } from '../../types/index.js';

// Блок «Пересчёт» на настоящем PostgreSQL (миграция 348): запись прежних условий в транзакции сохранения, какие месяцы
// считаются, «Доплачено», политика FK. Сам расчёт месяца подменён: здесь он отдаёт оклады, правила расчёта проверяет
// payroll-terms-recalc.rules.test.ts. Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).

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

vi.mock('./payroll-staff-category.js', () => ({
  resolveCurrentStaffCategories: async (ids: number[]) => new Map(ids.map(id => [id, 'office'])),
}));

const scopeMock = vi.hoisted(() => ({ canRead: true, canEdit: true, canEditPage: true }));

vi.mock('./payroll-scope.service.js', () => ({
  resolvePayrollReadableDepartmentIds: async () => 'all',
  canReadPayrollEmployee: async () => scopeMock.canRead,
  canEditPayrollEmployee: async () => scopeMock.canEdit,
  resolvePayrollEditPredicate: async () => () => true,
}));

vi.mock('../access-control.service.js', () => ({
  resolveEffectivePageAccess: async () => scopeMock.canEditPage,
}));

vi.mock('../../config/contractor.js', () => ({ getContractorRootId: async () => null }));

const auditMock = vi.hoisted(() => ({ logFromRequest: vi.fn(async (..._args: unknown[]) => undefined) }));
vi.mock('../audit.service.js', () => ({ auditService: auditMock }));

vi.mock('../employee-archive-department.service.js', () => ({
  getKnownArchiveDepartment: async () => ({ id: '00000000-0000-0000-0000-0000000000a0', name: 'Уволенные' }),
}));

// Расчёт месяца: «Стало» — текущий оклад месяца из БД, «Было» — оклад из присланных прежних условий.
vi.mock('./payroll-calc.service.js', () => ({
  toCalcTermsRow: (row: Record<string, unknown>) => ({ ...row, monthly_salary: String(row.monthly_salary) }),
  getPayoutForEmployees: async () => new Map(),
  getPreliminaryPayoutForEmployees: async (
    ids: readonly number[],
    month: string,
    _req: unknown,
    _metrics: unknown,
    options?: { previousTerms?: ReadonlyMap<number, ReadonlyArray<{ monthly_salary: string | null }>> },
  ) => {
    const { rows } = await pg.pool!.query(
      `SELECT to_char(effective_from, 'YYYY-MM-DD') AS effective_from, to_char(effective_to, 'YYYY-MM-DD') AS effective_to,
              calc_type, monthly_salary::text AS monthly_salary, hourly_rate::text AS hourly_rate,
              bonus_amount::text AS bonus_amount, proration_rounding
         FROM payroll_compensation_terms
        WHERE employee_id = $1 AND effective_from <= ($2 || '-28')::date
          AND (effective_to IS NULL OR effective_to >= ($2 || '-01')::date)
        ORDER BY effective_from`,
      [ids[0], month],
    );
    const before = options?.previousTerms?.get(ids[0]) ?? [];
    return new Map([[ids[0], {
      state: 'closed',
      net: rows.at(-1)?.monthly_salary ?? null,
      previous_net: before.at(-1)?.monthly_salary ?? null,
      terms: rows,
    }]]);
  },
}));

import { payrollTermsRecalcController } from '../../controllers/payroll-terms-recalc.controller.js';
import { payrollTermsController } from '../../controllers/payroll-terms.controller.js';
import { getEmployeeRecalc, settleEmployeeRecalc } from './payroll-terms-recalc.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');

const AUTHOR = '00000000-0000-0000-0000-00000000000b';
const CASHIER = '00000000-0000-0000-0000-00000000000c';
const AGARKOVA = 80;

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
    setHeader() { return this; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
};

const makeReq = (employeeId: number, body: unknown = undefined, userId = AUTHOR) => ({
  params: { empId: String(employeeId) },
  body,
  query: {},
  user: { id: userId, is_admin: true },
  headers: {},
} as unknown as AuthenticatedRequest);

const seedTerms = (employeeId: number, from: string, to: string | null, salary: string) => pg.pool!.query(
  `INSERT INTO payroll_compensation_terms (employee_id, staff_category, calc_type, monthly_salary, effective_from, effective_to)
   VALUES ($1, 'office', 'salary', $2::numeric, $3::date, $4::date)`,
  [employeeId, salary, from, to],
);

/** Сохранить оклад через контроллер так же, как карточка; changedAt — момент правки вместо now() в БД. */
const assign = async (
  employeeId: number,
  salary: number,
  effectiveFrom: string,
  changedAt = '2026-11-05 12:00+03',
) => {
  const res = makeRes();
  await payrollTermsController.assign(makeReq(employeeId, {
    calc_type: 'salary', monthly_salary: salary, effective_from: effectiveFrom,
  }), res);
  await pg.pool!.query(
    'UPDATE payroll_terms_recalcs SET created_at = $2::timestamptz WHERE employee_id = $1 AND id = (SELECT max(id) FROM payroll_terms_recalcs WHERE employee_id = $1)',
    [employeeId, changedAt],
  );
  return res;
};

const records = async (employeeId: number) => (await pg.pool!.query(
  `SELECT id, to_char(effective_from, 'YYYY-MM-DD') AS effective_from, previous_terms,
          ARRAY(SELECT to_char(m, 'YYYY-MM') FROM unnest(paid_months_1c) AS m ORDER BY m) AS paid_months_1c,
          created_by, settled_by, settled_at
     FROM payroll_terms_recalcs WHERE employee_id = $1 ORDER BY id`,
  [employeeId],
)).rows;

const addPayout = async (employeeId: number, periodMonth: string, docDate: string, method: string, amount = '1000.00') => {
  const doc = await pg.pool!.query<{ id: number }>(
    `INSERT INTO payroll_1c_payout_documents (period_month, doc_date, doc_number, payment_method)
     VALUES ($1::date, $2::date, '0000-1', $3) RETURNING id`,
    [`${periodMonth}-01`, docDate, method],
  );
  await pg.pool!.query(
    'INSERT INTO payroll_1c_payout_lines (document_id, employee_id, amount) VALUES ($1, $2, $3::numeric)',
    [doc.rows[0].id, employeeId, amount],
  );
};

const req = makeReq(AGARKOVA);

describe.skipIf(!PG_URL)('блок «Пересчёт» на PostgreSQL', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS payroll_terms_recalcs, payroll_1c_payout_lines, payroll_1c_payout_documents,
        payroll_paid_amounts, payroll_compensation_terms, payroll_item_types, payroll_settings,
        payroll_planned_supplements, user_profiles, employees, org_departments CASCADE;
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, parent_id uuid, kind text);
      CREATE TABLE employees (id integer PRIMARY KEY, full_name text, employment_status text NOT NULL DEFAULT 'active');
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      CREATE TABLE payroll_paid_amounts (employee_id integer, month date, item_code text, amount numeric(12,2));
      CREATE TABLE payroll_1c_payout_documents (
        id serial PRIMARY KEY, period_month date, doc_date date, doc_number text, payment_method text
      );
      CREATE TABLE payroll_1c_payout_lines (document_id integer, employee_id integer, amount numeric(12,2));
    `);
    await pg.pool!.query(migration('271_payroll_terms.sql'));
    await pg.pool!.query(migration('282_payroll_terms_bonus_housing.sql'));
    await pg.pool!.query(migration('286_payroll_terms_compensations.sql'));
    await pg.pool!.query(`ALTER TABLE payroll_compensation_terms
      ADD COLUMN IF NOT EXISTS proration_rounding TEXT NOT NULL DEFAULT 'ruble'`);
    // Тип договора (352) — колонка условий: список и сохранение читают и пишут её.
    await pg.pool!.query(migration('352_payroll_terms_contract_type.sql'));
    await pg.pool!.query(migration('348_payroll_terms_recalcs.sql'));
    // Повторный запуск миграции безопасен.
    await pg.pool!.query(migration('348_payroll_terms_recalcs.sql'));
    await pg.pool!.query(`
      CREATE OR REPLACE FUNCTION test_fail_terms_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'test: назначение упало'; END $$;
      CREATE TRIGGER test_fail_terms_insert BEFORE INSERT ON payroll_compensation_terms
        FOR EACH ROW WHEN (NEW.employee_id = 77 AND NEW.created_by IS NOT NULL) EXECUTE FUNCTION test_fail_terms_insert();
    `);
  });

  beforeEach(async () => {
    vi.useFakeTimers({ now: new Date('2026-11-05T12:00:00+03:00'), toFake: ['Date'] });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    scopeMock.canRead = true;
    scopeMock.canEdit = true;
    scopeMock.canEditPage = true;
    auditMock.logFromRequest.mockClear();
    await pg.pool!.query(`
      TRUNCATE payroll_terms_recalcs, payroll_1c_payout_lines, payroll_1c_payout_documents, payroll_paid_amounts,
        payroll_compensation_terms, user_profiles, employees CASCADE;
      INSERT INTO employees (id, full_name) VALUES (80, 'Агаркова В.В.'), (77, 'Падает при назначении'), (90, 'Новый');
      INSERT INTO user_profiles (id, full_name) VALUES
        ('${AUTHOR}', 'Петрова А.А.'), ('${CASHIER}', 'Иванова И.И.');
    `);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  describe('запись при сохранении условий', () => {
    it('Правка задним числом: сохранена вся прежняя история, строки условий после правки другие', async () => {
      await seedTerms(AGARKOVA, '2026-07-01', '2026-07-31', '150000.00');
      await seedTerms(AGARKOVA, '2026-08-01', '2026-09-30', '180000.00');
      await seedTerms(AGARKOVA, '2026-10-01', null, '190000.00');
      await pg.pool!.query(
        `INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES
           (80, '2026-07-01', 'contract', 150000), (80, '2026-08-01', 'contract', 180000), (80, '2026-08-01', 'travel', 2730),
           (80, '2026-09-01', 'travel', 2730)`,
      );

      const res = await assign(AGARKOVA, 200000, '2026-09-01');

      expect(res.statusCode).toBe(200);
      const [record, ...rest] = await records(AGARKOVA);
      expect(rest).toEqual([]);
      expect(record).toMatchObject({ effective_from: '2026-09-01', created_by: AUTHOR, settled_at: null });
      // Без статьи «По трудовому договору» месяц 1С не считается выплаченным (сентябрь — только проезд).
      expect(record.paid_months_1c).toEqual(['2026-07', '2026-08']);
      expect(record.previous_terms.map((row: { monthly_salary: string; effective_to: string | null }) => [
        row.monthly_salary, row.effective_to,
      ])).toEqual([['150000.00', '2026-07-31'], ['180000.00', '2026-09-30'], ['190000.00', null]]);
      const live = (await pg.pool!.query(
        `SELECT monthly_salary::text AS salary, to_char(effective_to, 'YYYY-MM-DD') AS effective_to
           FROM payroll_compensation_terms WHERE employee_id = 80 ORDER BY effective_from`,
      )).rows;
      expect(live).toEqual([
        { salary: '150000.00', effective_to: '2026-07-31' },
        { salary: '180000.00', effective_to: '2026-08-31' },
        { salary: '200000.00', effective_to: null },
      ]);
    });

    it('запись не нужна: дата в текущем месяце, первое назначение, те же суммы', async () => {
      await seedTerms(AGARKOVA, '2026-08-01', null, '180000.00');
      await assign(AGARKOVA, 200000, '2026-11-01');
      await assign(AGARKOVA, 200000, '2026-11-10');
      await assign(90, 230000, '2026-09-01');
      expect(await records(AGARKOVA)).toEqual([]);
      expect(await records(90)).toEqual([]);

      // Повторное сохранение тех же условий (Карасени: 350 000 дважды).
      await assign(90, 230000, '2026-09-01');
      await assign(90, 230000, '2026-09-15');
      expect(await records(90)).toEqual([]);
    });

    it('дата 31 октября при правке 1 ноября — прошлый месяц по Москве: запись есть', async () => {
      // 1 ноября 00:30 МСК = 31 октября 21:30 UTC: сервер в UTC.
      vi.setSystemTime(new Date('2026-10-31T21:30:00Z'));
      await seedTerms(AGARKOVA, '2026-08-01', null, '180000.00');
      await assign(AGARKOVA, 200000, '2026-10-31');
      expect(await records(AGARKOVA)).toHaveLength(1);
    });

    it('назначение упало — запись откатывается вместе с ним', async () => {
      await seedTerms(77, '2026-08-01', null, '180000.00');
      const res = await assign(77, 200000, '2026-09-01');

      expect(res.statusCode).toBe(500);
      expect(await records(77)).toEqual([]);
      expect((await pg.pool!.query(`SELECT monthly_salary::text AS salary, effective_to
        FROM payroll_compensation_terms WHERE employee_id = 77`)).rows).toEqual([{ salary: '180000.00', effective_to: null }]);
    });
  });

  describe('какие месяцы в блоке', () => {
    beforeEach(async () => {
      await seedTerms(AGARKOVA, '2026-08-01', null, '180000.00');
    });

    it('Агаркова: сентябрь выплачен, в октябре только аванс — только сентябрь', async () => {
      await addPayout(AGARKOVA, '2026-09', '2026-10-05', 'Аванс');
      await addPayout(AGARKOVA, '2026-09', '2026-10-20', 'Зарплата за месяц');
      await addPayout(AGARKOVA, '2026-10', '2026-11-02', 'Аванс');
      await assign(AGARKOVA, 200000, '2026-09-01');

      expect(await getEmployeeRecalc(AGARKOVA, req)).toMatchObject({
        total: '20000.00',
        months: [{
          month: '2026-09',
          was: '180000.00',
          became: '200000.00',
          difference: '20000.00',
          terms_from: { calc_type: 'salary', amount: '180000.00' },
          terms_to: { calc_type: 'salary', amount: '200000.00' },
        }],
      });
    });

    it('ведомость «Увольнения» закрывает месяц, «Премии» и «Отпуска» — нет', async () => {
      await addPayout(AGARKOVA, '2026-09', '2026-10-20', 'Увольнения');
      await addPayout(AGARKOVA, '2026-10', '2026-11-01', 'Премии');
      await addPayout(AGARKOVA, '2026-10', '2026-11-01', 'Отпуска');
      await assign(AGARKOVA, 200000, '2026-09-01');

      expect((await getEmployeeRecalc(AGARKOVA, req)).months.map(row => row.month)).toEqual(['2026-09']);
    });

    it('ведомость с датой после правки не считается, с датой до правки — считается и при поздней загрузке', async () => {
      await assign(AGARKOVA, 200000, '2026-09-01');
      await addPayout(AGARKOVA, '2026-10', '2026-11-20', 'Зарплата за месяц');
      expect((await getEmployeeRecalc(AGARKOVA, req)).months).toEqual([]);

      await addPayout(AGARKOVA, '2026-09', '2026-10-20', 'Зарплата за месяц');
      expect((await getEmployeeRecalc(AGARKOVA, req)).months.map(row => row.month)).toEqual(['2026-09']);
    });

    it('статья 1С, загруженная после правки, месяц выплаченным не делает', async () => {
      await assign(AGARKOVA, 200000, '2026-09-01');
      await pg.pool!.query(`INSERT INTO payroll_paid_amounts VALUES (80, '2026-09-01', 'contract', 180000)`);
      expect((await getEmployeeRecalc(AGARKOVA, req)).months).toEqual([]);
    });

    it('ничего не выплачено — блока нет, но записи остаются', async () => {
      await assign(AGARKOVA, 200000, '2026-09-01');
      const recalc = await getEmployeeRecalc(AGARKOVA, req);
      expect(recalc.months).toEqual([]);
      expect(recalc.record_ids).toHaveLength(1);
    });

    it('две правки подряд: «Было» — от первой, «Стало» — текущее', async () => {
      await addPayout(AGARKOVA, '2026-09', '2026-10-20', 'Зарплата за месяц');
      await assign(AGARKOVA, 190000, '2026-09-01', '2026-11-03 12:00+03');
      await assign(AGARKOVA, 200000, '2026-09-01', '2026-11-05 12:00+03');

      const recalc = await getEmployeeRecalc(AGARKOVA, req);
      expect(recalc.months).toMatchObject([{ was: '180000.00', became: '200000.00', difference: '20000.00' }]);
      expect(recalc.record_ids).toHaveLength(2);
    });

    it('оклад вернули — разницы нет, блока нет', async () => {
      await addPayout(AGARKOVA, '2026-09', '2026-10-20', 'Зарплата за месяц');
      await assign(AGARKOVA, 200000, '2026-09-01');
      await assign(AGARKOVA, 180000, '2026-09-01');
      expect((await getEmployeeRecalc(AGARKOVA, req)).months).toEqual([]);
    });

    it('чужие правки и ведомости не считаются', async () => {
      await seedTerms(90, '2026-08-01', null, '100000.00');
      await addPayout(90, '2026-09', '2026-10-20', 'Зарплата за месяц');
      await assign(90, 120000, '2026-09-01');
      await assign(AGARKOVA, 200000, '2026-09-01');
      expect((await getEmployeeRecalc(AGARKOVA, req)).months).toEqual([]);
      expect((await getEmployeeRecalc(90, req)).total).toBe('20000.00');
    });
  });

  describe('«Доплачено»', () => {
    beforeEach(async () => {
      await seedTerms(AGARKOVA, '2026-08-01', null, '180000.00');
      await addPayout(AGARKOVA, '2026-09', '2026-10-20', 'Зарплата за месяц');
    });

    it('блок исчезает; следующая правка считается от доплаченного оклада', async () => {
      await assign(AGARKOVA, 200000, '2026-09-01');
      const { record_ids: recordIds } = await getEmployeeRecalc(AGARKOVA, req);

      const res = makeRes();
      await payrollTermsRecalcController.settle(makeReq(AGARKOVA, { record_ids: recordIds }, CASHIER), res);

      expect(res.body).toEqual({ success: true, data: { settled: 1 } });
      expect(await getEmployeeRecalc(AGARKOVA, req)).toEqual({ months: [], total: '0.00', record_ids: [] });
      expect((await records(AGARKOVA))[0]).toMatchObject({ settled_by: CASHIER });
      expect(auditMock.logFromRequest).toHaveBeenCalledWith(
        expect.anything(), CASHIER, 'PAYROLL_TERMS_RECALC_SETTLED',
        expect.objectContaining({
          details: expect.objectContaining({ employee_id: AGARKOVA, record_ids: recordIds, total: '20000.00' }),
        }),
      );

      await assign(AGARKOVA, 210000, '2026-09-01');
      expect((await getEmployeeRecalc(AGARKOVA, req)).months).toMatchObject([
        { was: '200000.00', became: '210000.00', difference: '10000.00' },
      ]);
    });

    it('правка, сделанная пока карточка открыта, не закрывается', async () => {
      await assign(AGARKOVA, 200000, '2026-09-01');
      const { record_ids: shown } = await getEmployeeRecalc(AGARKOVA, req);
      await assign(AGARKOVA, 210000, '2026-09-01');

      await settleEmployeeRecalc(AGARKOVA, shown, CASHIER);

      expect((await getEmployeeRecalc(AGARKOVA, req)).months).toMatchObject([
        { was: '200000.00', became: '210000.00' },
      ]);
    });

    it('повторное нажатие и чужая запись ничего не закрывают и не пишут аудит', async () => {
      await assign(AGARKOVA, 200000, '2026-09-01');
      const { record_ids: recordIds } = await getEmployeeRecalc(AGARKOVA, req);
      await settleEmployeeRecalc(AGARKOVA, recordIds, CASHIER);

      auditMock.logFromRequest.mockClear();
      const again = makeRes();
      await payrollTermsRecalcController.settle(makeReq(AGARKOVA, { record_ids: recordIds }), again);
      expect(again.body).toEqual({ success: true, data: { settled: 0 } });
      expect(auditMock.logFromRequest).not.toHaveBeenCalled();

      await seedTerms(90, '2026-08-01', null, '100000.00');
      await assign(90, 120000, '2026-09-01');
      const [foreign] = await records(90);
      expect(await settleEmployeeRecalc(AGARKOVA, [foreign.id], CASHIER)).toEqual([]);
      expect((await records(90))[0].settled_at).toBeNull();
    });

    it('доступ: чтение и отметка — по скоупу; пустой список — 400', async () => {
      await assign(AGARKOVA, 200000, '2026-09-01');

      const read = makeRes();
      await payrollTermsRecalcController.getByEmployee(req, read);
      expect(read.body.data.can_settle).toBe(true);

      scopeMock.canEditPage = false;
      const viewOnlyPage = makeRes();
      await payrollTermsRecalcController.getByEmployee(req, viewOnlyPage);
      expect(viewOnlyPage.body.data.can_settle).toBe(false);
      scopeMock.canEditPage = true;

      scopeMock.canEdit = false;
      const viewOnly = makeRes();
      await payrollTermsRecalcController.getByEmployee(req, viewOnly);
      expect(viewOnly.body.data.can_settle).toBe(false);
      const denied = makeRes();
      await payrollTermsRecalcController.settle(makeReq(AGARKOVA, { record_ids: [1] }), denied);
      expect(denied.statusCode).toBe(403);
      scopeMock.canEdit = true;

      const empty = makeRes();
      await payrollTermsRecalcController.settle(makeReq(AGARKOVA, { record_ids: [] }), empty);
      expect(empty.statusCode).toBe(400);

      scopeMock.canRead = false;
      const hidden = makeRes();
      await payrollTermsRecalcController.getByEmployee(req, hidden);
      expect(hidden.statusCode).toBe(403);
    });
  });

  describe('политика FK', () => {
    it('удаление пользователя оставляет запись, удаление сотрудника убирает её', async () => {
      await seedTerms(AGARKOVA, '2026-08-01', null, '180000.00');
      await assign(AGARKOVA, 200000, '2026-09-01');
      const [record] = await records(AGARKOVA);
      await settleEmployeeRecalc(AGARKOVA, [record.id], CASHIER);

      await pg.pool!.query('UPDATE payroll_compensation_terms SET created_by = NULL');
      await pg.pool!.query('DELETE FROM user_profiles');
      expect((await records(AGARKOVA))[0]).toMatchObject({ created_by: null, settled_by: null });
      expect((await records(AGARKOVA))[0].settled_at).not.toBeNull();

      await pg.pool!.query('DELETE FROM payroll_compensation_terms');
      await pg.pool!.query('DELETE FROM employees WHERE id = 80');
      expect(await records(AGARKOVA)).toEqual([]);
    });
  });
});
