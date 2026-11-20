import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Увольнение из 1С по API на настоящем PostgreSQL: миграция 372 (и повтор), перезапись ячейки «Оплачено» и её возврат,
// защита ячейки триггером, цепочка исправлений, Σ = 0 и возврат из журнала, пробный режим, пачка с ошибкой.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;
const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  return {
    getPool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await pg.pool!.query(sql, params as unknown[])).rows,
  };
});

import { parseDismissalBatch } from './payroll-1c-dismissals.rules.js';
import { applyDismissalBatch, DismissalApiError, listDismissalOrders } from './payroll-1c-dismissals.service.js';

const MIGRATION = readFileSync(fileURLToPath(new URL('../../../../docs/migrations/372_payroll_1c_dismissals.sql', import.meta.url)), 'utf8');
const USER = 'dddddddd-0000-4000-8000-000000000001';
const ID_ALL = 'aaaaaaaa-0000-4000-8000-000000000001';
const G = (n: number) => `${String(n).repeat(8)}-0000-4000-8000-${String(n).repeat(12)}`;
const sql = async (text: string, params: unknown[] = []) => (await pg.pool!.query(text, params)).rows;

const doc = (guid: string, revision: number, over: Record<string, unknown> = {}) => ({
  guid, source_revision: revision, posted: true, supersedes_guid: null,
  number: '0000-002016', date: '2026-11-20', month: '2026-11', organization_inn: '7736255508',
  employee: { employee_id: 1544, id_all: ID_ALL, full_name: 'Савкин Дмитрий Александрович' },
  order: { dismissal_date: '2026-11-20', basis: 'п. 3 ч. 1 ст. 77' },
  accruals: { vacation_compensation: '35602.21', vacation_compensation_days: null, severance: '12000.00' },
  ...over,
});

const send = async (documents: unknown[], dryRun = false) => {
  const parsed = parseDismissalBatch({ documents });
  expect(parsed.errors).toEqual([]);
  return applyDismissalBatch({ docs: parsed.docs, keyId: null, dryRun });
};

const cells = async () => Object.fromEntries((await sql(`
  SELECT item_code, amount::text AS amount, source_kind, updated_by::text AS updated_by
    FROM payroll_paid_amounts WHERE employee_id = 1544 AND month = '2026-11-01' ORDER BY item_code`))
  .map(row => [row.item_code, `${row.amount}|${row.source_kind ?? 'file'}|${row.updated_by ?? '-'}`]));

describe.skipIf(!PG_URL)('payroll-1c-dismissals — PostgreSQL', () => {
  beforeAll(async () => {
    await sql(`DROP TABLE IF EXISTS payroll_1c_dismissal_revisions, payroll_1c_dismissal_documents, payroll_paid_amounts,
                 employee_hr_profiles, employees, user_profiles, data_api_keys CASCADE`);
    await sql('CREATE TABLE user_profiles (id uuid PRIMARY KEY)');
    await sql('CREATE TABLE data_api_keys (id uuid PRIMARY KEY)');
    await sql('CREATE TABLE employees (id int PRIMARY KEY, dismissal_date date)');
    await sql('CREATE TABLE employee_hr_profiles (employee_id int PRIMARY KEY, passdesk_id_all uuid)');
    await sql(`CREATE TABLE payroll_paid_amounts (
                 employee_id int NOT NULL REFERENCES employees(id) ON DELETE CASCADE, month date NOT NULL, item_code text NOT NULL,
                 amount numeric(12,2) NOT NULL, updated_by uuid REFERENCES user_profiles(id) ON DELETE SET NULL,
                 updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (employee_id, month, item_code),
                 CONSTRAINT payroll_paid_item_code CHECK (item_code IN ('severance')))`);
    await sql('INSERT INTO user_profiles VALUES ($1)', [USER]);
    await sql("INSERT INTO employees VALUES (1544, '2026-11-20'), (2000, NULL)");
    await sql(MIGRATION);
    await sql(MIGRATION); // повтор безопасен
    // В «Оплачено» уже лежит пособие из файла 1С.
    await sql("INSERT INTO payroll_paid_amounts (employee_id, month, item_code, amount, updated_by) VALUES (1544, '2026-11-01', 'severance', 10000, $1)", [USER]);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('новый документ перезаписывает ячейку, повтор — без изменений, скрипт её не меняет, распроведение возвращает файл', async () => {
    const [created] = await send([doc(G(1), 1)]);
    expect(created).toMatchObject({ action: 'new', employee_id: 1544, month: '2026-11' });
    expect(created.warnings.map(item => item.code)).toEqual(['id_all_missing_in_fot']);
    expect(await cells()).toEqual({
      severance: '12000.00|api_1c_dismissal|-',
      vacation_compensation: '35602.21|api_1c_dismissal|-',
    });
    expect((await send([doc(G(1), 1)]))[0]).toMatchObject({ action: 'unchanged', cells: [] });

    // Скрипт загрузки файла не может поменять ячейку документа 1С.
    await expect(sql("UPDATE payroll_paid_amounts SET amount = 1 WHERE employee_id = 1544 AND item_code = 'severance'"))
      .rejects.toThrow(/ведётся документом увольнения из 1С/);

    expect((await listDismissalOrders(1544, '2026-11', '2026-11'))[0]).toMatchObject({ doc_number: '0000-002016', fot_dismissal_date: '2026-11-20' });

    const [unposted] = await send([{ guid: G(1), source_revision: 2, posted: false }]);
    expect(unposted.action).toBe('unposted');
    expect(await cells()).toEqual({ severance: '10000.00|file|' + USER });
    expect((await send([doc(G(1), 1)]))[0].action).toBe('stale');
    expect((await send([{ guid: G(1), source_revision: 3, posted: false }]))[0].action).toBe('unchanged');
    expect(await listDismissalOrders(1544, '2026-11', '2026-11')).toEqual([]);
  });

  it('исправление в одной пачке в любом порядке, Σ = 0 стирает пособие, возврат — из журнала', async () => {
    const zeroSeverance = { vacation_compensation: '100.00', vacation_compensation_days: '2.33', severance: '0.00' };
    const results = await send([
      doc(G(3), 1, { supersedes_guid: G(2), accruals: { ...zeroSeverance, vacation_compensation: '200.00' } }),
      doc(G(2), 1, { accruals: zeroSeverance }),
    ]);
    expect(results.map(item => item.action)).toEqual(['new', 'new']);
    expect(await cells()).toEqual({ vacation_compensation: '200.00|api_1c_dismissal|-' });
    const active = await sql('SELECT doc_guid::text AS g FROM payroll_1c_dismissal_documents WHERE is_active ORDER BY 1');
    expect(active.map(row => row.g)).toEqual([G(3)]);

    // Исправление распроведено — снова действует исходный (компенсация 100, пособие 0 — ячейки нет).
    await send([{ guid: G(3), source_revision: 2, posted: false }]);
    expect(await cells()).toEqual({ vacation_compensation: '100.00|api_1c_dismissal|-' });
    // Распроведён и исходный — пособие из файла возвращается из журнала.
    await send([{ guid: G(2), source_revision: 2, posted: false }]);
    expect(await cells()).toEqual({ severance: '10000.00|file|' + USER });
  });

  it('пробный режим и пачка с ошибкой ничего не пишут; чужой код физлица — отказ', async () => {
    const before = await cells();
    const [dry] = await send([doc(G(4), 1)], true);
    expect(dry.action).toBe('new');
    expect(await cells()).toEqual(before);
    expect(await sql('SELECT 1 FROM payroll_1c_dismissal_documents WHERE doc_guid = $1', [G(4)])).toEqual([]);

    const unknown = parseDismissalBatch({ documents: [doc(G(5), 1), doc(G(6), 1, { employee: { employee_id: 999999, id_all: ID_ALL } })] });
    await expect(applyDismissalBatch({ docs: unknown.docs, keyId: null, dryRun: false })).rejects.toMatchObject({
      code: 'unknown_employee', errors: [expect.objectContaining({ index: 1, guid: G(6) })],
    });
    expect(await sql('SELECT 1 FROM payroll_1c_dismissal_documents WHERE doc_guid = $1', [G(5)])).toEqual([]);

    await sql("INSERT INTO employee_hr_profiles VALUES (2000, 'bbbbbbbb-0000-4000-8000-000000000002')");
    const mismatch = parseDismissalBatch({ documents: [doc(G(7), 1, { employee: { employee_id: 2000, id_all: ID_ALL } })] });
    const error = await applyDismissalBatch({ docs: mismatch.docs, keyId: null, dryRun: false }).catch(err => err);
    expect(error).toBeInstanceOf(DismissalApiError);
    expect(error.code).toBe('employee_mismatch');

    // Удаление сотрудника: «Оплачено» — каскадом, журнал документов остаётся (employee_id → NULL).
    await send([doc(G(8), 1)]);
    await sql('DELETE FROM employees WHERE id = 1544');
    expect((await sql('SELECT employee_id FROM payroll_1c_dismissal_documents WHERE doc_guid = $1', [G(8)]))[0].employee_id).toBeNull();
  });
});
