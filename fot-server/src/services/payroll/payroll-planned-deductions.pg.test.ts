import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Плановые удержания (миграция 357) на настоящем PostgreSQL: CHECK и повторный запуск миграции, пересечение
// периодов (без подвида — один «подвид»), updated_at против повтора и гонки, «Убрать» (удалить / закрыть прошлым
// месяцем), история для карточки, развёртка по месяцам (приём, увольнение, бессрочно) — одна для таблиц и расчёта
// (monthDeductionsSql в loadSummaryExtras), счёт сотрудников при удалении вида.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).

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

import {
  addPlannedDeduction,
  listEmployeePlannedDeductions,
  listPlannedDeductionChanges,
  listPlannedDeductionMonths,
  listPlannedDeductions,
  removePlannedDeduction,
  updatePlannedDeduction,
  type IPlannedDeduction,
  type IPlannedDeductionInput,
} from './payroll-planned-deductions.service.js';
import { loadSummaryExtras } from './payroll-summary-calc.service.js';
import { monthDeductionsSql } from './payroll-month-deductions.sql.js';
import { deleteDeductionKind } from './payroll-deduction-kinds.service.js';
import { addSubkind, deleteSubkind } from './payroll-deduction-subkinds.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
const run = (sql: string, params?: unknown[]) => pg.pool!.query(sql, params);

const D1 = '00000000-0000-0000-0000-0000000000d1';
const CONTRACTORS = '00000000-0000-0000-0000-0000000000c0';
const AUTHOR = '00000000-0000-0000-0000-0000000000a9';

/** Сотрудники: работающие, принятый в декабре, уволенный 14.11, подрядчик. */
const WORKER = 1;
const SECOND = 2;
const HIRED_DEC = 3;
const FIRED_NOV = 4;
const CONTRACTOR = 5;

const kindId = async (name: string): Promise<number> =>
  (await run(`SELECT id FROM payroll_deduction_kinds WHERE name = $1`, [name])).rows[0].id as number;

const input = (over: Partial<IPlannedDeductionInput> & { kind_id: number }): IPlannedDeductionInput => ({
  subkind_id: null, amount: 5000, month_from: '2026-11', month_to: '2027-01', ...over,
});

/** Ряд добавлен — иначе тест падает понятной ошибкой. */
const added = (result: Awaited<ReturnType<typeof addPlannedDeduction>>): IPlannedDeduction => {
  if (typeof result === 'string' || 'conflict' in result) throw new Error(`не добавлено: ${JSON.stringify(result)}`);
  return result;
};

describe.skipIf(!PG_URL)('плановые удержания на PostgreSQL', () => {
  let loan: number;
  let meals: number;
  let workwear: number;

  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS payroll_planned_deduction_changes, payroll_planned_deductions, staff_deductions,
        payroll_employee_deductions, payroll_deduction_subkinds, payroll_deduction_kinds, payroll_compensation_terms,
        employee_dormitory_stays, role_page_access, access_pages, user_profiles, payroll_one_time_supplements,
        employees, positions,
        org_departments CASCADE;
      DROP FUNCTION IF EXISTS public.get_descendant_department_ids(uuid[]);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, parent_id uuid);
      CREATE TABLE positions (id uuid PRIMARY KEY, name text);
      CREATE TABLE employees (
        id integer PRIMARY KEY,
        full_name text,
        org_department_id uuid REFERENCES org_departments(id),
        position_id uuid REFERENCES positions(id),
        employment_status text NOT NULL DEFAULT 'active',
        is_archived boolean NOT NULL DEFAULT false,
        hire_date date,
        dismissal_date date
      );
      CREATE TABLE user_profiles (id uuid PRIMARY KEY, full_name text);
      -- loadSummaryExtras читает и разовые доплаты: столбцы — как на проде.
      CREATE TABLE payroll_one_time_supplements (
        id serial PRIMARY KEY, employee_id integer NOT NULL, month date NOT NULL, reason text NOT NULL,
        amount numeric(12,2) NOT NULL
      );
      CREATE TABLE payroll_compensation_terms (id serial PRIMARY KEY, deduction_amount numeric(12,2));
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
      CREATE FUNCTION public.get_descendant_department_ids(uuid[]) RETURNS TABLE(id uuid)
        LANGUAGE sql AS $$
          SELECT d.id FROM org_departments d WHERE d.id = ANY($1) OR d.parent_id = ANY($1)
        $$;
      INSERT INTO org_departments (id, name, parent_id) VALUES
        ('${D1}', 'бр.Менгбоев Г.И.', NULL),
        ('${CONTRACTORS}', 'Подрядные организации', NULL),
        ('00000000-0000-0000-0000-0000000000c1', 'Смарт ПСК ООО', '${CONTRACTORS}');
      INSERT INTO user_profiles (id, full_name) VALUES ('${AUTHOR}', 'Есенов Максим');
      INSERT INTO employees (id, full_name, org_department_id, employment_status, hire_date, dismissal_date) VALUES
        (${WORKER}, 'Каримов Акмал', '${D1}', 'active', '2025-03-01', NULL),
        (${SECOND}, 'Борисов Антон', '${D1}', 'active', NULL, NULL),
        (${HIRED_DEC}, 'Васильев Виктор', '${D1}', 'active', '2026-12-15', NULL),
        (${FIRED_NOV}, 'Карпов Уволенный', '${D1}', 'fired', '2024-01-10', '2026-11-14'),
        (${CONTRACTOR}, 'Карпенко Подрядчик', '00000000-0000-0000-0000-0000000000c1', 'active', NULL, NULL);
    `);
    for (const name of [
      '299_payroll_deduction_kinds.sql', '300_payroll_employee_deductions.sql', '314_employee_dormitory_stays.sql',
      '318_staff_deductions.sql', '321_payroll_deduction_subkinds.sql',
    ]) {
      await run(migration(name));
    }
    await run(`INSERT INTO payroll_deduction_kinds (name) VALUES ('Займ') ON CONFLICT DO NOTHING`);
    loan = await kindId('Займ');
    meals = await kindId('Питание');
    workwear = await kindId('Спецодежда');
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('357: повтор безопасен, CHECK суммы, первого числа и порядка месяцев', async () => {
    await run(migration('357_payroll_planned_deductions.sql'));
    await run(migration('357_payroll_planned_deductions.sql'));
    const bad = [
      `(1, ${loan}, 0, '2026-11-01', NULL)`,
      `(1, ${loan}, 100, '2026-11-02', NULL)`,
      `(1, ${loan}, 100, '2026-11-01', '2026-12-15')`,
      `(1, ${loan}, 100, '2026-11-01', '2026-10-01')`,
    ];
    for (const values of bad) {
      await expect(run(`INSERT INTO payroll_planned_deductions (employee_id, kind_id, amount, month_from, month_to)
                        VALUES ${values}`)).rejects.toThrow(/payroll_planned_deduction_/);
    }
    await expect(run(`INSERT INTO payroll_planned_deduction_changes (planned_id, employee_id, action) VALUES (1, 1, 'x')`))
      .rejects.toThrow(/payroll_planned_deduction_change_action/);
    const grants = await run(`SELECT has_table_privilege('public', 'payroll_planned_deductions', 'SELECT') AS a,
                                     has_table_privilege('public', 'payroll_planned_deduction_changes', 'SELECT') AS b`);
    expect(grants.rows[0]).toEqual({ a: false, b: false });
  });

  it('добавление: история «назначено»; пересечение того же вида без подвида — отказ; другой вид и подвиды — можно', async () => {
    const row = added(await addPlannedDeduction(WORKER, input({ kind_id: loan }), AUTHOR));
    expect(row).toMatchObject({
      employee_id: WORKER, full_name: 'Каримов Акмал', department: 'бр.Менгбоев Г.И.', kind_name: 'Займ',
      subkind_id: null, amount: '5000.00', month_from: '2026-11', month_to: '2027-01',
    });
    expect(row.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    // NULL/NULL — один «подвид»: пересечение по одному месяцу (январь) — отказ.
    const overlap = await addPlannedDeduction(WORKER, input({ kind_id: loan, month_from: '2027-01', month_to: null }), AUTHOR);
    expect(overlap).toMatchObject({ conflict: 'exists', existing: { id: row.id } });
    // Встык — можно; другой вид — можно.
    added(await addPlannedDeduction(WORKER, input({ kind_id: loan, amount: 3000, month_from: '2027-02', month_to: null }), AUTHOR));
    added(await addPlannedDeduction(WORKER, input({ kind_id: meals, amount: 1200.5 }), AUTHOR));

    // Подвиды одного вида: разные — можно, тот же — отказ.
    const helmet = await addSubkind(workwear, 'Каска', null);
    const boots = await addSubkind(workwear, 'Ботинки', null);
    if (typeof helmet === 'string' || helmet === null || typeof boots === 'string' || boots === null) throw new Error('подвид');
    added(await addPlannedDeduction(SECOND, input({ kind_id: workwear, subkind_id: helmet.id, amount: 700 }), AUTHOR));
    added(await addPlannedDeduction(SECOND, input({ kind_id: workwear, subkind_id: boots.id, amount: 900 }), AUTHOR));
    expect(await addPlannedDeduction(SECOND, input({ kind_id: workwear, subkind_id: helmet.id, month_from: '2026-12' }), AUTHOR))
      .toMatchObject({ conflict: 'exists' });
    // Подвид чужого вида и несуществующий вид — понятная ошибка, без строки.
    expect(await addPlannedDeduction(SECOND, input({ kind_id: loan, subkind_id: helmet.id, month_from: '2028-01', month_to: null }), AUTHOR))
      .toBe('subkind_missing');
    expect(await addPlannedDeduction(SECOND, input({ kind_id: 99999 }), AUTHOR)).toBe('kind_missing');

    expect((await listPlannedDeductionChanges(WORKER)).map(change => [change.action, change.kind_name, change.amount]))
      .toEqual([['assigned', 'Питание', '1200.50'], ['assigned', 'Займ', '3000.00'], ['assigned', 'Займ', '5000.00']]);
    expect((await listPlannedDeductionChanges(WORKER))[0].changed_by_name).toBe('Есенов Максим');
  });

  it('правка: без изменений — без истории; чужой updated_at — stale; пересечение — отказ; правка — «было → стало»', async () => {
    const [first] = (await listEmployeePlannedDeductions(WORKER)).filter(row => row.kind_id === loan && row.month_from === '2026-11');
    const same = await updatePlannedDeduction(first.id, input({ kind_id: loan }), first.updated_at, AUTHOR);
    expect(same).toMatchObject({ changed: false });
    expect(await updatePlannedDeduction(first.id, input({ kind_id: loan, amount: 6000 }), '2020-01-01T00:00:00.000000Z', AUTHOR))
      .toEqual({ conflict: 'stale' });
    // Продлить на февраль — пересечётся с периодом с февраля; сам с собой — не пересечение.
    expect(await updatePlannedDeduction(first.id, input({ kind_id: loan, month_to: '2027-02' }), first.updated_at, AUTHOR))
      .toMatchObject({ conflict: 'exists' });

    const result = await updatePlannedDeduction(first.id, input({ kind_id: loan, amount: 6000 }), first.updated_at, AUTHOR);
    if (result === null || typeof result === 'string' || 'conflict' in result) throw new Error('не сохранено');
    expect(result.changed).toBe(true);
    expect(result.after.amount).toBe('6000.00');
    expect(result.after.updated_at).not.toBe(first.updated_at);
    // Повтор того же запроса со старой меткой — stale, а не вторая правка.
    expect(await updatePlannedDeduction(first.id, input({ kind_id: loan, amount: 7000 }), first.updated_at, AUTHOR))
      .toEqual({ conflict: 'stale' });

    const [change] = await listPlannedDeductionChanges(WORKER);
    expect(change).toMatchObject({
      action: 'changed', planned_id: first.id, amount: '6000.00', prev_amount: '5000.00',
      month_from: '2026-11', month_to: '2027-01', prev_month_from: '2026-11', prev_month_to: '2027-01',
    });
    expect((await listPlannedDeductionChanges(WORKER)).filter(item => item.action === 'changed')).toHaveLength(1);
  });

  it('«Убрать»: начатое в текущем месяце — удаляется, идущее — закрывается прошлым, повтор и гонка — stale', async () => {
    // Начинается с текущего (ноябрь) — удаляется, а не закрывается октябрём (месяц «по» раньше «с»).
    const fresh = added(await addPlannedDeduction(SECOND, input({ kind_id: loan, month_to: null }), AUTHOR));
    expect(await removePlannedDeduction(fresh.id, fresh.updated_at, '2026-11', AUTHOR)).toMatchObject({ action: 'removed' });

    // Идущее с сентября: в ноябре — закрыть октябрём. Два одновременных «Убрать» с одной меткой: один закрывает, второй — stale.
    const running = added(await addPlannedDeduction(SECOND, input({ kind_id: loan, month_from: '2026-09', month_to: null }), AUTHOR));
    const both = await Promise.all([
      removePlannedDeduction(running.id, running.updated_at, '2026-11', AUTHOR),
      removePlannedDeduction(running.id, running.updated_at, '2026-11', AUTHOR),
    ]);
    expect(both.map(result => (result && 'action' in result ? result.action : result?.conflict)).sort()).toEqual(['closed', 'stale']);
    const [kept] = (await listEmployeePlannedDeductions(SECOND)).filter(row => row.id === running.id);
    expect(kept).toMatchObject({ month_from: '2026-09', month_to: '2026-10' });

    // Уже кончившееся до текущего месяца — удаляется (с новой меткой).
    expect(await removePlannedDeduction(kept.id, kept.updated_at, '2026-11', AUTHOR)).toMatchObject({ action: 'removed' });
    expect(await removePlannedDeduction(kept.id, kept.updated_at, '2026-11', AUTHOR)).toBeNull();

    const actions = (await listPlannedDeductionChanges(SECOND)).filter(change => change.planned_id === running.id || change.planned_id === fresh.id);
    expect(actions.map(change => [change.action, change.month_to, change.prev_month_to])).toEqual([
      ['removed', null, '2026-10'],
      ['closed', '2026-10', null],
      ['assigned', null, null],
      ['removed', null, null],
      ['assigned', null, null],
    ]);
  });

  it('развёртка по месяцам: приём, увольнение, бессрочно, длинный период; та же — в расчёте вместе с разовыми', async () => {
    // Принят 15.12: с ноября — только с декабря. Уволен 14.11: ноябрь — да, декабрь — нет.
    added(await addPlannedDeduction(HIRED_DEC, input({ kind_id: loan, amount: 1000, month_to: null }), AUTHOR));
    added(await addPlannedDeduction(FIRED_NOV, input({ kind_id: loan, amount: 2000, month_from: '2026-10', month_to: null }), AUTHOR));
    // Конец дальше чем через 12 месяцев.
    added(await addPlannedDeduction(SECOND, input({ kind_id: meals, amount: 100, month_to: '2029-12' }), AUTHOR));
    await run(`INSERT INTO staff_deductions (employee_id, kind_id, month, amount) VALUES (${WORKER}, ${loan}, '2026-11-01', 250.25)`);

    const months = ['2026-10-01', '2026-11-01', '2026-12-01', '2029-12-01', '2030-01-01'];
    const scope = { kind: 'employees' as const, employeeIds: null };
    const expanded = await listPlannedDeductionMonths(scope, months);
    const pairs = expanded.map(row => `${row.employee_id}:${row.kind_name}:${row.month}:${row.amount}`).sort();
    expect(pairs).toEqual([
      `${WORKER}:Займ:2026-11:6000.00`, `${WORKER}:Займ:2026-12:6000.00`,
      // Бессрочный с февраля 2027 — и в 2029–2030.
      `${WORKER}:Займ:2029-12:3000.00`, `${WORKER}:Займ:2030-01:3000.00`,
      `${WORKER}:Питание:2026-11:1200.50`, `${WORKER}:Питание:2026-12:1200.50`,
      `${SECOND}:Питание:2026-11:100.00`, `${SECOND}:Питание:2026-12:100.00`, `${SECOND}:Питание:2029-12:100.00`,
      `${SECOND}:Спецодежда:2026-11:700.00`, `${SECOND}:Спецодежда:2026-11:900.00`,
      `${SECOND}:Спецодежда:2026-12:700.00`, `${SECOND}:Спецодежда:2026-12:900.00`,
      `${HIRED_DEC}:Займ:2026-12:1000.00`, `${HIRED_DEC}:Займ:2029-12:1000.00`, `${HIRED_DEC}:Займ:2030-01:1000.00`,
      `${FIRED_NOV}:Займ:2026-10:2000.00`, `${FIRED_NOV}:Займ:2026-11:2000.00`,
    ].sort());

    // Расчёт («Свод», «Выплачено»): разовое + плановое одного вида складываются, уволенному — до месяца увольнения.
    const extras = await loadSummaryExtras(['2026-11', '2026-12']);
    const byKey = (key: string) => [...(extras.deductions.get(key) ?? [])].sort((a, b) => a.kind.localeCompare(b.kind));
    expect(byKey(`${WORKER}|2026-11`)).toEqual([{ kind: 'Займ', amount: '6250.25' }, { kind: 'Питание', amount: '1200.50' }]);
    expect(byKey(`${SECOND}|2026-12`)).toEqual([{ kind: 'Питание', amount: '100.00' }, { kind: 'Спецодежда', amount: '1600.00' }]);
    expect(byKey(`${FIRED_NOV}|2026-11`)).toEqual([{ kind: 'Займ', amount: '2000.00' }]);
    expect(extras.deductions.has(`${FIRED_NOV}|2026-12`)).toBe(false);
    expect(extras.deductions.has(`${HIRED_DEC}|2026-11`)).toBe(false);
    // Повторный расчёт — те же цифры.
    expect((await loadSummaryExtras(['2026-11', '2026-12'])).deductions).toEqual(extras.deductions);

    // Форма вызова расчёта ФОТ за один месяц (loadPayoutExtras): ARRAY[$2::date] и список сотрудников.
    const single = await run(
      `SELECT employee_id, kind_id, SUM(amount)::text AS amount FROM (${monthDeductionsSql('ARRAY[$2::date]', '$1')}) d
        GROUP BY employee_id, kind_id ORDER BY employee_id, kind_id`,
      [[WORKER], '2026-11-01'],
    );
    expect(single.rows).toEqual([
      { employee_id: WORKER, kind_id: Math.min(loan, meals), amount: loan < meals ? '6250.25' : '1200.50' },
      { employee_id: WORKER, kind_id: Math.max(loan, meals), amount: loan < meals ? '1200.50' : '6250.25' },
    ]);
  });

  it('охват: «штат зарплаты» без уволенных и подрядчиков; кадры — свой список; окно сотрудника — и уволенный', async () => {
    added(await addPlannedDeduction(CONTRACTOR, input({ kind_id: loan }), AUTHOR));
    const payroll = { kind: 'payroll' as const, contractorRootId: CONTRACTORS, departmentIds: null };
    const people = (rows: Array<{ employee_id: number }>) => [...new Set(rows.map(row => row.employee_id))].sort();
    // Список периодов — по периоду (принятый в декабре виден с периодом «с ноября»); удерживать начнут с декабря.
    expect(people(await listPlannedDeductions(payroll, ['2026-11-01']))).toEqual([WORKER, SECOND, HIRED_DEC]);
    expect(people(await listPlannedDeductions(payroll, ['2026-10-01']))).toEqual([]);
    expect(people(await listPlannedDeductions(payroll, null))).toEqual([WORKER, SECOND, HIRED_DEC]);
    expect(await listPlannedDeductions({ ...payroll, departmentIds: [] }, null)).toEqual([]);
    expect(people(await listPlannedDeductions({ kind: 'employees', employeeIds: [FIRED_NOV, SECOND] }, null)))
      .toEqual([SECOND, FIRED_NOV]);
    expect(await listPlannedDeductions({ kind: 'employees', employeeIds: [] }, null)).toEqual([]);
    expect((await listEmployeePlannedDeductions(FIRED_NOV)).map(row => row.month_from)).toEqual(['2026-10']);
  });

  it('вид и подвид с плановыми не удалить; число — разных сотрудников по обеим таблицам', async () => {
    // У Каримова «Займ» и разовый, и плановый — один человек; ещё Васильев, Карпов, Карпенко.
    expect(await deleteDeductionKind(loan)).toEqual({ inUse: 4 });
    const [helmet] = (await run(`SELECT id FROM payroll_deduction_subkinds WHERE name = 'Каска'`)).rows;
    expect(await deleteSubkind(helmet.id)).toEqual({ inUse: 1 });
  });
});
