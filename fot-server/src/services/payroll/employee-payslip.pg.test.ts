import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Расчётный лист в ЛК (миграция 353) на настоящем PostgreSQL: миграция и повтор, доступ по списку / «всем», месяцы
// только отмеченные и только с данными сотрудника, листок 1С (статьи, ведомости по документу, сальдо), ФОТ-месяц.
// Табель и расчёт ФОТ подменены (их проверяют свои тесты). Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД.

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
const fx = vi.hoisted(() => ({
  closed: new Map<string, { workday: number; dayoff: number }>(),
  live: null as { workday: number; dayoff: number } | null,
  calc: null as unknown,
  calcCalls: [] as unknown[][],
}));

vi.mock('../../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(20, (value: string) => Number(value));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 3 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
  };
});

// Закрытая основа табеля: ключ — месяц; нет ключа — не закрыт.
vi.mock('./payroll-month-basis.service.js', () => ({
  loadMonthBasisSources: vi.fn(async (_ids: number[], month: string) => new Map([[2520, [{ month }]]])),
  assembleMonthBasis: vi.fn((sources: Array<{ month: string }>) => {
    const days = fx.closed.get(sources[0]?.month ?? '');
    return days
      ? { state: 'closed', workdayDates: Array(days.workday).fill('d'), dayoffDates: Array(days.dayoff).fill('d') }
      : { state: 'not_closed', reason: 'not_covered' };
  }),
}));
vi.mock('../timesheet-export.service.js', () => ({ fetchTimesheetDataForEmployees: vi.fn(async () => ({})) }));
vi.mock('./payroll-payslip.service.js', () => ({ splitWorkedDays: vi.fn(() => fx.live) }));
vi.mock('./payroll-calc.service.js', () => ({
  getPayoutForEmployees: vi.fn(async (...args: unknown[]) => {
    fx.calcCalls.push(args);
    return new Map(fx.calc ? [[2520, fx.calc]] : []);
  }),
}));
vi.mock('./payroll-vacation.service.js', () => ({
  getVacationBalance: vi.fn(async () => ({ current_days: '16.31', until: '2026-11-06' })),
}));

const { hasEmployeePayslipAccess } = await import('../employee-payslip-access.service.js');
const { getEmployeePayslip, getEmployeeVacationLeft, listEmployeePayslipMonths } = await import('./employee-payslip.service.js');

const MIGRATION_353 = readFileSync(
  fileURLToPath(new URL('../../../../docs/migrations/353_employee_payslip.sql', import.meta.url)),
  'utf8',
);

const YESENOV = 2520;
const PASHAEVA = 2394;
const OTHER = 2329;
const req = { user: { id: 'u1', employee_id: YESENOV } } as never;

const q = async (sql: string, params?: unknown[]) => (await pg.pool!.query(sql, params)).rows;

const pgCode = async (sql: string): Promise<string | undefined> => {
  try {
    await pg.pool!.query(sql);
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

describe.skipIf(!PG_URL)('расчётный лист в ЛК (353)', () => {
  beforeAll(async () => {
    await q(`
      DROP TABLE IF EXISTS public.employee_payslip_access, public.employee_payslip_months, public.payroll_paid_amounts,
        public.payroll_1c_payout_lines, public.payroll_1c_payout_documents, public.system_settings, public.access_pages,
        public.positions CASCADE;
      DROP TABLE IF EXISTS public.employees CASCADE;
      CREATE TABLE public.positions (id integer PRIMARY KEY, name text);
      CREATE TABLE public.employees (
        id integer PRIMARY KEY, full_name text, position_id integer, hire_date date, dismissal_date date,
        org_department_id uuid, employment_status text DEFAULT 'active', excluded_from_timesheet_date date);
      CREATE TABLE public.system_settings (
        key text PRIMARY KEY, value text, description text, is_secret boolean NOT NULL DEFAULT false,
        updated_at timestamptz NOT NULL DEFAULT now(), updated_by uuid);
      CREATE TABLE public.access_pages (
        key text PRIMARY KEY, label text NOT NULL, group_code text NOT NULL, group_label text NOT NULL,
        surface text NOT NULL, supports_edit boolean NOT NULL DEFAULT true,
        requires_data_scope boolean NOT NULL DEFAULT false, requires_employee_variant boolean NOT NULL DEFAULT false,
        sort_order integer NOT NULL DEFAULT 0, is_active boolean NOT NULL DEFAULT true,
        is_system boolean NOT NULL DEFAULT true, area text NOT NULL DEFAULT 'admin',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE public.payroll_paid_amounts (
        employee_id integer, month date, item_code text, amount numeric(12,2), PRIMARY KEY (employee_id, month, item_code));
      CREATE TABLE public.payroll_1c_payout_documents (
        id bigserial PRIMARY KEY, doc_number text, zup2_number text, doc_date date, period_month date, payment_method text);
      CREATE TABLE public.payroll_1c_payout_lines (
        document_id bigint REFERENCES public.payroll_1c_payout_documents(id), line_no integer, employee_id integer,
        amount numeric(12,2));
      INSERT INTO public.positions (id, name) VALUES (1, 'Разработчик');
      INSERT INTO public.employees (id, full_name, position_id, hire_date) VALUES
        (${YESENOV}, 'Есенов Максим Николаевич', 1, '2026-05-12'),
        (${PASHAEVA}, 'Пашаева Луарат Рамазановна', NULL, '2026-04-21'),
        (${OTHER}, 'Берсенев Алексей Владимирович', NULL, '2026-04-21');
    `);
    await q(MIGRATION_353);
    await q(MIGRATION_353);
  });

  beforeEach(async () => {
    await q(`TRUNCATE public.payroll_paid_amounts, public.payroll_1c_payout_lines, public.payroll_1c_payout_documents`);
    await q(`UPDATE public.system_settings SET value = 'false' WHERE key = 'employee_payslip_for_all'`);
    await q(`DELETE FROM public.employee_payslip_months WHERE month >= '2026-09-01'`);
    fx.closed = new Map();
    fx.live = null;
    fx.calc = null;
    fx.calcCalls = [];
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('миграция: список Есенов + Пашаева, май–август 1С, «всем» выключено, страница ЛК без правки', async () => {
    expect((await q('SELECT employee_id FROM employee_payslip_access ORDER BY 1')).map(row => row.employee_id))
      .toEqual([PASHAEVA, YESENOV]);
    expect(await q(`SELECT to_char(month, 'YYYY-MM') AS month, source FROM employee_payslip_months ORDER BY 1`)).toEqual([
      { month: '2026-05', source: '1c' },
      { month: '2026-06', source: '1c' },
      { month: '2026-07', source: '1c' },
      { month: '2026-08', source: '1c' },
    ]);
    expect(await q(`SELECT value FROM system_settings WHERE key = 'employee_payslip_for_all'`)).toEqual([{ value: 'false' }]);
    expect(await q(`SELECT surface, area, supports_edit, group_code FROM access_pages WHERE key = '/employee/payslip'`))
      .toEqual([{ surface: 'page', area: 'personal', supports_edit: false, group_code: 'lk' }]);
  });

  it('CHECK: месяц — 1-е число, источник — 1c или fot', async () => {
    expect(await pgCode(`INSERT INTO employee_payslip_months (month, source) VALUES ('2026-09-15', '1c')`)).toBe('23514');
    expect(await pgCode(`INSERT INTO employee_payslip_months (month, source) VALUES ('2026-09-01', 'zup')`)).toBe('23514');
  });

  it('доступ: список, «всем» (только ровно true), без сотрудника — нет', async () => {
    await expect(hasEmployeePayslipAccess(YESENOV)).resolves.toBe(true);
    await expect(hasEmployeePayslipAccess(OTHER)).resolves.toBe(false);
    await q(`UPDATE system_settings SET value = 'TRUE' WHERE key = 'employee_payslip_for_all'`);
    await expect(hasEmployeePayslipAccess(OTHER)).resolves.toBe(false);
    await q(`UPDATE system_settings SET value = 'true' WHERE key = 'employee_payslip_for_all'`);
    await expect(hasEmployeePayslipAccess(OTHER)).resolves.toBe(true);
    await expect(hasEmployeePayslipAccess(null)).resolves.toBe(false);
    await q(`DELETE FROM system_settings WHERE key = 'employee_payslip_for_all'`);
    await expect(hasEmployeePayslipAccess(OTHER)).resolves.toBe(false);
    await q(MIGRATION_353);
  });

  it('удаление сотрудника снимает его из списка', async () => {
    await q(`INSERT INTO employees (id, full_name) VALUES (9001, 'Удаляемый')`);
    await q(`INSERT INTO employee_payslip_access (employee_id) VALUES (9001)`);
    await q(`DELETE FROM employees WHERE id = 9001`);
    expect(await q(`SELECT 1 FROM employee_payslip_access WHERE employee_id = 9001`)).toHaveLength(0);
  });

  it('месяцы: только отмеченные и с «Оплачено» сотрудника; неотмеченный сентябрь с одной строкой отпускных не виден', async () => {
    await q(`INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES
      (${YESENOV}, '2026-07-01', 'contract', 150000), (${YESENOV}, '2026-08-01', 'contract', 167142.89),
      (${YESENOV}, '2026-09-01', 'vacation', 1000), (${OTHER}, '2026-06-01', 'contract', 1)`);
    expect(await listEmployeePayslipMonths(YESENOV)).toEqual(['2026-08', '2026-07']);
    expect(await getEmployeePayslip(YESENOV, '2026-09', req)).toBeNull();

    await q(`INSERT INTO employee_payslip_months (month, source) VALUES ('2026-09-01', '1c')`);
    expect(await listEmployeePayslipMonths(YESENOV)).toEqual(['2026-09', '2026-08', '2026-07']);
    // Отмечен, но у сотрудника данных нет — не виден.
    expect(await getEmployeePayslip(YESENOV, '2026-06', req)).toBeNull();
  });

  it('листок 1С: статьи, должность, дни по закрытой основе, ведомости по документу, сальдо', async () => {
    await q(`INSERT INTO employee_payslip_months (month, source) VALUES ('2026-09-01', '1c')`);
    await q(`INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES
      (${YESENOV}, '2026-09-01', 'contract', 180000), (${YESENOV}, '2026-09-01', 'travel', 2730)`);
    const [advance, salary] = await q(`INSERT INTO payroll_1c_payout_documents (doc_number, doc_date, period_month, payment_method)
      VALUES ('0000-002526', '2026-10-05', '2026-09-01', 'Аванс'), ('0000-002721', '2026-10-16', '2026-09-01', 'Зарплата за месяц')
      RETURNING id`);
    await q(`INSERT INTO payroll_1c_payout_lines (document_id, line_no, employee_id, amount) VALUES
      (${advance.id}, 1, ${YESENOV}, 30000.25), (${advance.id}, 2, ${YESENOV}, 24999.25),
      (${salary.id}, 1, ${YESENOV}, 55000.50), (${salary.id}, 2, ${OTHER}, 1)`);
    fx.closed.set('2026-09', { workday: 22, dayoff: 0 });

    const slip = await getEmployeePayslip(YESENOV, '2026-09', req);
    expect(slip).toMatchObject({
      state: 'ready',
      full_name: 'Есенов Максим Николаевич',
      position_name: 'Разработчик',
      period_from: '2026-09-01',
      period_to: '2026-09-30',
      worked_days: { workday: 22, dayoff: 0 },
      salary_parts: [],
      accrued_total: '182730.00',
      deducted_total: '0.00',
      paid_total: '110000.00',
      balance: '72730.00',
    });
    expect(slip && slip.state === 'ready' && slip.payouts.map(item => [item.doc_number, item.amount])).toEqual([
      ['0000-002526', '54999.50'],
      ['0000-002721', '55000.50'],
    ]);
    expect(fx.calcCalls).toHaveLength(0);
  });

  it('листок 1С без закрытой основы — дни по живому табелю; без ведомостей — без сальдо', async () => {
    await q(`INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount) VALUES (${YESENOV}, '2026-08-01', 'contract', 167142.89)`);
    fx.live = { workday: 21, dayoff: 1 };
    const slip = await getEmployeePayslip(YESENOV, '2026-08', req);
    expect(slip).toMatchObject({ state: 'ready', worked_days: { workday: 21, dayoff: 1 }, paid_total: null, balance: null });
  });

  it('ФОТ-месяц: виден при закрытой основе и без истории 1С; расчёт без фиксации бригад; неполный — not_ready', async () => {
    await q(`INSERT INTO employee_payslip_months (month, source) VALUES ('2026-10-01', 'fot')`);
    expect(await listEmployeePayslipMonths(YESENOV)).not.toContain('2026-10');
    expect(await getEmployeePayslip(YESENOV, '2026-10', req)).toBeNull();

    fx.closed.set('2026-10', { workday: 22, dayoff: 0 });
    expect((await listEmployeePayslipMonths(YESENOV))[0]).toBe('2026-10');

    fx.calc = {
      state: 'closed', period_from: '2026-10-01', period_to: '2026-10-31', worked_days: { workday: 22, dayoff: 0 },
      lines: [{ code: 'contract', amount: '180000.00' }, { code: 'travel', amount: '2730.00' }],
      deductions: [], accrued: '182730.00', deducted: '0.00', net: '182730.00', missing: [],
    };
    const slip = await getEmployeePayslip(YESENOV, '2026-10', req);
    expect(slip).toMatchObject({ state: 'ready', accrued_total: '182730.00', balance: null });
    expect(fx.calcCalls[0]?.[4]).toEqual({ fixBrigades: false });

    fx.calc = { ...(fx.calc as object), net: null, missing: ['no_terms'] };
    expect(await getEmployeePayslip(YESENOV, '2026-10', req)).toEqual({ state: 'not_ready', month: '2026-10' });
    fx.calc = { state: 'not_closed', reason: 'brigade_open' };
    expect(await getEmployeePayslip(YESENOV, '2026-10', req)).toEqual({ state: 'not_ready', month: '2026-10' });
  });

  it('неизвестный месяц и неизвестный сотрудник — null (404)', async () => {
    expect(await getEmployeePayslip(YESENOV, '2025-01', req)).toBeNull();
    expect(await getEmployeePayslip(777777, '2026-08', req)).toBeNull();
  });

  it('остаток отпуска: days = current_days, until — день счёта', async () => {
    await expect(getEmployeeVacationLeft(YESENOV, '2026-11-06')).resolves.toEqual({ days: '16.31', until: '2026-11-06' });
  });
});
