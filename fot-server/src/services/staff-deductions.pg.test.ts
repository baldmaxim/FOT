import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// «Удержания» кадров и переименование «Общежития» в «Проживание» (миграция 318), подвиды и одна запись на кадры
// и «Зарплату» (миграция 321) на настоящем PostgreSQL: повторный запуск, стоп-проверка 321, права, CHECK месяца
// и суммы, сумма по умолчанию у вида и подвида, подвид — только своего вида, вид и подвид не удалить, пока
// назначены, сервис удержаний и выборка «штата зарплаты».
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
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

import {
  addDeduction,
  deleteDeduction,
  getDeduction,
  listDeductions,
  listPayrollDeductions,
  updateDeduction,
} from './staff-deductions.service.js';
import {
  addDeductionKindWithDefault,
  deleteDeductionKind,
  updateDeductionKind,
} from './payroll/payroll-deduction-kinds.service.js';
import {
  addSubkind,
  deleteSubkind,
  listDeductionKindTree,
  updateSubkind,
} from './payroll/payroll-deduction-subkinds.service.js';

const MIGRATIONS_DIR = fileURLToPath(new URL('../../../docs/migrations/', import.meta.url));
const migration = (name: string): string => readFileSync(`${MIGRATIONS_DIR}${name}`, 'utf8');
const run = (sql: string) => pg.pool!.query(sql);

const D1 = '00000000-0000-0000-0000-0000000000d1';
const CONTRACTORS = '00000000-0000-0000-0000-0000000000c0';

describe.skipIf(!PG_URL)('«Удержания» кадров на PostgreSQL', () => {
  const kindId = async (name: string): Promise<number> =>
    (await listDeductionKindTree()).find(kind => kind.name === name)!.id;

  beforeAll(async () => {
    await run(`
      DROP TABLE IF EXISTS staff_deductions, payroll_employee_deductions, payroll_deduction_subkinds,
        payroll_deduction_kinds, payroll_compensation_terms, employee_dormitory_stays, role_page_access, access_pages,
        employees, positions, org_departments CASCADE;
      DROP FUNCTION IF EXISTS public.get_descendant_department_ids(uuid[]);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, parent_id uuid);
      CREATE TABLE positions (id uuid PRIMARY KEY, name text);
      CREATE TABLE employees (
        id integer PRIMARY KEY,
        full_name text,
        org_department_id uuid REFERENCES org_departments(id),
        position_id uuid REFERENCES positions(id),
        employment_status text NOT NULL DEFAULT 'active',
        is_archived boolean NOT NULL DEFAULT false
      );
      -- 299/300 трогают условия оплаты: здесь достаточно столбца суммы удержания.
      CREATE TABLE payroll_compensation_terms (id serial PRIMARY KEY, deduction_amount numeric(12,2));
      -- Права: столбцы и ключи — как на проде.
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
      -- «Штат зарплаты» отсекает подрядчиков по поддереву их корня.
      CREATE FUNCTION public.get_descendant_department_ids(uuid[]) RETURNS TABLE(id uuid)
        LANGUAGE sql AS $$
          SELECT d.id FROM org_departments d WHERE d.id = ANY($1) OR d.parent_id = ANY($1)
        $$;
      INSERT INTO org_departments (id, name, parent_id) VALUES
        ('${D1}', 'бр.Менгбоев Г.И.', NULL),
        ('${CONTRACTORS}', 'Подрядные организации', NULL),
        ('00000000-0000-0000-0000-0000000000c1', 'Смарт ПСК ООО', '${CONTRACTORS}');
      INSERT INTO positions (id, name) VALUES ('00000000-0000-0000-0000-0000000000a1', 'Монтажник');
      INSERT INTO employees (id, full_name, org_department_id, position_id, employment_status) VALUES
        (1, 'Каримов Акмал', '${D1}', '00000000-0000-0000-0000-0000000000a1', 'active'),
        (2, 'Борисов Антон', '${D1}', NULL, 'active'),
        (3, 'Васильев Виктор', NULL, NULL, 'active'),
        (4, 'Карпов Уволенный', '${D1}', NULL, 'dismissed'),
        (5, 'Карпенко Подрядчик', '00000000-0000-0000-0000-0000000000c1', NULL, 'active');
    `);
    await run(migration('299_payroll_deduction_kinds.sql'));
    await run(migration('300_payroll_employee_deductions.sql'));
    await run(migration('314_employee_dormitory_stays.sql'));
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('318: «Общежитие» → «Проживание», право «Удержания» у admin и hr_admin; повтор безопасен', async () => {
    await run(migration('318_staff_deductions.sql'));
    await run(migration('318_staff_deductions.sql'));
    expect((await run(`SELECT key, label, surface, supports_edit FROM access_pages ORDER BY key`)).rows).toEqual([
      { key: '/staff-control/deductions', label: 'Управление кадрами — Удержания', surface: 'technical', supports_edit: true },
      { key: '/staff-control/dormitory', label: 'Управление кадрами — Проживание', surface: 'technical', supports_edit: true },
    ]);
    expect((await run(`SELECT role_code, can_view, can_edit FROM role_page_access
                        WHERE page_path = '/staff-control/deductions' ORDER BY role_code`)).rows).toEqual([
      { role_code: 'admin', can_view: true, can_edit: true },
      { role_code: 'hr_admin', can_view: true, can_edit: true },
    ]);
  });

  it('321: старая модель «Зарплаты» не пуста — миграция останавливается; повтор безопасен', async () => {
    // Дерево видов читает подвиды — до 321 их таблицы нет, вид берём прямо.
    const kind = (await run(`SELECT id FROM payroll_deduction_kinds WHERE name = 'ТМЦ'`)).rows[0].id as number;
    // Отдельное соединение: ошибка внутри BEGIN миграции оставляет его в прерванной транзакции — откатываем сами.
    const refused = async (pattern: RegExp) => {
      const client = await pg.pool!.connect();
      try {
        await expect(client.query(migration('321_payroll_deduction_subkinds.sql'))).rejects.toThrow(pattern);
        await client.query('ROLLBACK');
      } finally {
        client.release();
      }
      expect((await run(`SELECT to_regclass('public.payroll_deduction_subkinds') AS t`)).rows[0].t).toBeNull();
    };
    await run(`INSERT INTO payroll_employee_deductions (employee_id, kind_id) VALUES (1, ${kind})`);
    await refused(/payroll_employee_deductions/);
    await run(`DELETE FROM payroll_employee_deductions`);
    await run(`INSERT INTO payroll_compensation_terms (deduction_amount) VALUES (1500)`);
    await refused(/deduction_amount/);
    // Ноль — не сумма: не мешает.
    await run(`UPDATE payroll_compensation_terms SET deduction_amount = 0`);

    await run(migration('321_payroll_deduction_subkinds.sql'));
    await run(migration('321_payroll_deduction_subkinds.sql'));
    expect((await run(`SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'staff_deductions_subkind_fk'`)).rows[0].n)
      .toBe(1);
    expect((await run(`SELECT indexname FROM pg_indexes WHERE tablename = 'payroll_deduction_subkinds' ORDER BY 1`)).rows)
      .toEqual([
        { indexname: 'payroll_deduction_subkinds_kind_id_uniq' },
        { indexname: 'payroll_deduction_subkinds_name_uniq' },
        { indexname: 'payroll_deduction_subkinds_pkey' },
      ]);
  });

  it('виды: сумма по умолчанию — у новых и прежних, правка, 0 не принимается', async () => {
    expect((await listDeductionKindTree()).slice(0, 2)).toEqual([
      { id: expect.any(Number), name: 'Корректировка удержаний', default_amount: null, subkinds: [] },
      { id: expect.any(Number), name: 'ТМЦ', default_amount: null, subkinds: [] },
    ]);
    const added = await addDeductionKindWithDefault('Штраф за опоздание', 1500.5);
    expect(added).toEqual({ id: expect.any(Number), name: 'Штраф за опоздание', default_amount: '1500.50' });
    expect(await addDeductionKindWithDefault(' штраф за ОПОЗДАНИЕ', null)).toBeNull();
    expect((await listDeductionKindTree()).at(-1)).toEqual({ ...added, subkinds: [] });

    const garbage = await kindId('Штраф за мусор');
    expect(await updateDeductionKind(garbage, 'Штраф за мусор', 5000)).toEqual({
      before: { id: garbage, name: 'Штраф за мусор', default_amount: null },
      after: { id: garbage, name: 'Штраф за мусор', default_amount: '5000.00' },
    });
    expect(await updateDeductionKind(garbage, 'ТМЦ', 5000)).toBe('duplicate');
    expect(await updateDeductionKind(9999, 'Нет такого', null)).toBeNull();

    await expect(run(`UPDATE payroll_deduction_kinds SET default_amount = 0 WHERE id = ${garbage}`))
      .rejects.toThrow(/payroll_deduction_kind_default_amount/);
  });

  it('подвиды: у каждого вида свои, имя без учёта регистра — в пределах вида; сумма; порядок дерева стабилен', async () => {
    const workwear = await kindId('Спецодежда');
    const fines = await kindId('Штрафы');
    const helmet = await addSubkind(workwear, 'Каска', 800);
    expect(helmet).toEqual({ id: expect.any(Number), kind_id: workwear, name: 'Каска', default_amount: '800.00' });
    const boots = await addSubkind(workwear, 'Сапоги', null);
    expect(await addSubkind(workwear, ' КАСКА', 900)).toBe('duplicate');
    // То же имя у другого вида — можно.
    const finesHelmet = await addSubkind(fines, 'Каска', null);
    expect(finesHelmet).toMatchObject({ kind_id: fines, name: 'Каска' });
    expect(await addSubkind(9999, 'Нет вида', null)).toBe('kind_missing');
    await expect(run(`INSERT INTO payroll_deduction_subkinds (kind_id, name, default_amount) VALUES (${workwear}, 'Ноль', 0)`))
      .rejects.toThrow(/payroll_deduction_subkind_default_amount/);
    await expect(run(`INSERT INTO payroll_deduction_subkinds (kind_id, name) VALUES (${workwear}, '  ')`))
      .rejects.toThrow(/payroll_deduction_subkind_name/);

    if (typeof helmet === 'string' || typeof boots === 'string') throw new Error('не добавлено');
    expect(await updateSubkind(boots.id, 'Сапоги резиновые', 2500)).toEqual({
      before: { id: boots.id, kind_id: workwear, name: 'Сапоги', default_amount: null },
      after: { id: boots.id, kind_id: workwear, name: 'Сапоги резиновые', default_amount: '2500.00' },
    });
    expect(await updateSubkind(boots.id, 'каска', 2500)).toBe('duplicate');
    expect(await updateSubkind(9999, 'Нет', null)).toBeNull();

    // Порядок подвидов — по добавлению (id), не по имени; повторное чтение — то же.
    const tree = await listDeductionKindTree();
    expect(tree.find(kind => kind.id === workwear)!.subkinds.map(sub => sub.name)).toEqual(['Каска', 'Сапоги резиновые']);
    expect(tree.find(kind => kind.id === fines)!.subkinds).toEqual([
      { id: expect.any(Number), kind_id: fines, name: 'Каска', default_amount: null },
    ]);
    expect(await listDeductionKindTree()).toEqual(tree);
  });

  it('удержания: повтор в том же месяце — новой строкой, правка, удаление, список по охвату', async () => {
    const garbage = await kindId('Штраф за мусор');
    const meals = await kindId('Питание');
    const first = await addDeduction(1, { kind_id: garbage, subkind_id: null, month: '2026-10', amount: 5000 });
    expect(first).toEqual({
      id: expect.any(Number), employee_id: 1, full_name: 'Каримов Акмал', department: 'бр.Менгбоев Г.И.',
      position: 'Монтажник', kind_id: garbage, kind_name: 'Штраф за мусор', subkind_id: null, subkind_name: null,
      month: '2026-10', amount: '5000.00',
    });
    const again = await addDeduction(1, { kind_id: garbage, subkind_id: null, month: '2026-10', amount: 2500 });
    expect(again).toMatchObject({ month: '2026-10', amount: '2500.00' });
    const other = await addDeduction(2, { kind_id: meals, subkind_id: null, month: '2026-09', amount: 1200 });
    expect(await addDeduction(2, { kind_id: 9999, subkind_id: null, month: '2026-09', amount: 1 })).toBe('kind_missing');

    expect((await listDeductions({ employeeIds: null })).map(row => [row.full_name, row.month, row.amount])).toEqual([
      ['Борисов Антон', '2026-09', '1200.00'],
      ['Каримов Акмал', '2026-10', '5000.00'],
      ['Каримов Акмал', '2026-10', '2500.00'],
    ]);
    expect((await listDeductions({ employeeIds: [2] })).map(row => row.employee_id)).toEqual([2]);
    expect(await listDeductions({ employeeIds: [] })).toEqual([]);

    if (typeof again === 'string' || typeof other === 'string') throw new Error('не добавлено');
    expect(await updateDeduction(again.id, { kind_id: meals, subkind_id: null, month: '2026-11', amount: 300 })).toMatchObject({
      before: { kind_name: 'Штраф за мусор', month: '2026-10', amount: '2500.00' },
      after: { kind_name: 'Питание', month: '2026-11', amount: '300.00' },
    });
    expect(await updateDeduction(again.id, { kind_id: 9999, subkind_id: null, month: '2026-11', amount: 300 }))
      .toBe('kind_missing');
    expect(await getDeduction(again.id)).toMatchObject({ kind_id: meals });
    expect(await updateDeduction(9999, { kind_id: meals, subkind_id: null, month: '2026-11', amount: 300 })).toBeNull();

    expect(await deleteDeduction(other.id)).toMatchObject({ id: other.id, employee_id: 2 });
    expect(await deleteDeduction(other.id)).toBeNull();

    await expect(run(`INSERT INTO staff_deductions (employee_id, kind_id, month, amount) VALUES (1, ${meals}, '2026-10-15', 10)`))
      .rejects.toThrow(/staff_deduction_month/);
    await expect(run(`INSERT INTO staff_deductions (employee_id, kind_id, month, amount) VALUES (1, ${meals}, '2026-10-01', 0)`))
      .rejects.toThrow(/staff_deduction_amount/);
  });

  it('подвид удержания: только своего вида, снять — null, удалённый подвид — subkind_missing; назначенный не удалить', async () => {
    const workwear = await kindId('Спецодежда');
    const fines = await kindId('Штрафы');
    const tree = await listDeductionKindTree();
    const helmet = tree.find(kind => kind.id === workwear)!.subkinds.find(sub => sub.name === 'Каска')!;
    const finesHelmet = tree.find(kind => kind.id === fines)!.subkinds[0];

    const row = await addDeduction(2, { kind_id: workwear, subkind_id: helmet.id, month: '2026-10', amount: 800 });
    expect(row).toMatchObject({ kind_name: 'Спецодежда', subkind_id: helmet.id, subkind_name: 'Каска', amount: '800.00' });
    // Подвид другого вида (у «Штрафов» тоже «Каска») — составной FK не пускает.
    expect(await addDeduction(2, { kind_id: workwear, subkind_id: finesHelmet.id, month: '2026-10', amount: 1 }))
      .toBe('subkind_missing');
    expect(await addDeduction(2, { kind_id: workwear, subkind_id: 9999, month: '2026-10', amount: 1 })).toBe('subkind_missing');
    if (typeof row === 'string') throw new Error('не добавлено');

    // Смена вида с прежним подвидом — тот же отказ, строка не меняется.
    expect(await updateDeduction(row.id, { kind_id: fines, subkind_id: helmet.id, month: '2026-10', amount: 800 }))
      .toBe('subkind_missing');
    expect(await getDeduction(row.id)).toMatchObject({ kind_id: workwear, subkind_id: helmet.id });

    // Подвид назначен — не удалить (число разных сотрудников); вид с ним — тоже.
    await addDeduction(2, { kind_id: workwear, subkind_id: helmet.id, month: '2026-11', amount: 800 });
    expect(await deleteSubkind(helmet.id)).toEqual({ inUse: 1 });
    expect(await deleteDeductionKind(workwear)).toEqual({ inUse: 1 });

    // Снять подвид — null; без подвида строка остаётся.
    expect(await updateDeduction(row.id, { kind_id: workwear, subkind_id: null, month: '2026-10', amount: 800 }))
      .toMatchObject({ before: { subkind_name: 'Каска' }, after: { subkind_id: null, subkind_name: null } });

    await run(`DELETE FROM staff_deductions WHERE subkind_id = ${helmet.id}`);
    expect(await deleteSubkind(helmet.id)).toEqual(helmet);
    expect(await deleteSubkind(helmet.id)).toBeNull();

    // Неиспользуемый вид уходит вместе с подвидами.
    const spare = await addDeductionKindWithDefault('Инструмент', null);
    if (!spare) throw new Error('вид не добавлен');
    await addSubkind(spare.id, 'Перфоратор', 12000);
    expect(await deleteDeductionKind(spare.id)).toEqual({ id: spare.id, name: 'Инструмент' });
    expect((await run(`SELECT count(*)::int AS n FROM payroll_deduction_subkinds WHERE kind_id = ${spare.id}`)).rows[0].n).toBe(0);
  });

  it('«Зарплата»: те же удержания в «штате зарплаты» — без уволенных и подрядчиков; месяцы, на дату, охват', async () => {
    const meals = await kindId('Питание');
    await addDeduction(4, { kind_id: meals, subkind_id: null, month: '2026-10', amount: 100 });
    await addDeduction(5, { kind_id: meals, subkind_id: null, month: '2026-10', amount: 100 });
    // Кадры видят и уволенного, и подрядчика (порядок — по ФИО).
    expect((await listDeductions({ employeeIds: [4, 5] })).map(row => row.full_name))
      .toEqual(['Карпенко Подрядчик', 'Карпов Уволенный']);

    const scope = { contractorRootId: CONTRACTORS, departmentIds: null };
    const people = (rows: Array<{ full_name: string; month: string }>) => rows.map(row => `${row.full_name} ${row.month}`);
    const all = await listPayrollDeductions({ ...scope, period: { monthStarts: null } });
    expect(people(all)).toEqual([
      'Борисов Антон 2026-10',
      'Каримов Акмал 2026-10',
      'Каримов Акмал 2026-11',
    ]);
    // Те же строки, что у кадров, — с подвидом.
    expect(all[0]).toEqual(await getDeduction(all[0].id));
    expect(people(await listPayrollDeductions({ ...scope, period: { monthStarts: ['2026-11-01'] } })))
      .toEqual(['Каримов Акмал 2026-11']);
    expect(people(await listPayrollDeductions({ ...scope, period: { onDate: '2026-10-21' } })))
      .toEqual(['Борисов Антон 2026-10', 'Каримов Акмал 2026-10']);
    // Охват — отделы; сотрудник без отдела вне охвата отдела не виден.
    expect(await listPayrollDeductions({ ...scope, departmentIds: [], period: { monthStarts: null } })).toEqual([]);
    await addDeduction(3, { kind_id: meals, subkind_id: null, month: '2026-10', amount: 100 });
    expect(people(await listPayrollDeductions({ ...scope, departmentIds: [D1], period: { monthStarts: ['2026-10-01'] } })))
      .toEqual(['Борисов Антон 2026-10', 'Каримов Акмал 2026-10']);
    await run(`DELETE FROM staff_deductions WHERE employee_id IN (3, 4, 5)`);
  });

  it('вид не удалить, пока он назначен удержаниям: число — разных сотрудников', async () => {
    const meals = await kindId('Питание');
    const garbage = await kindId('Штраф за мусор');
    // «Питание»: у Каримова (после правки выше) — дважды, но сотрудник один.
    await addDeduction(1, { kind_id: meals, subkind_id: null, month: '2026-12', amount: 300 });
    expect(await deleteDeductionKind(meals)).toEqual({ inUse: 1 });
    // «Штраф за мусор» — у Каримова.
    expect(await deleteDeductionKind(garbage)).toEqual({ inUse: 1 });

    await run(`DELETE FROM staff_deductions WHERE kind_id = ${garbage}`);
    expect(await deleteDeductionKind(garbage)).toEqual({ id: garbage, name: 'Штраф за мусор' });
  });
});
