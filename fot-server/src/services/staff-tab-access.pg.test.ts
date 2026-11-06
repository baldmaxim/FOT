import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Галочки «Проживание»/«Удержания» (миграция 351) на настоящем PostgreSQL: миграция и её повтор, CHECK и ключ пары,
// запись и снятие, FK (удаление сотрудника и учётки), fail-closed до миграции, снимок увольнения и возврат из него.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
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

const { listStaffTabGrants, loadStaffTabGrant, setStaffTabGrant } = await import('./staff-tab-access.service.js');
const { restoreFromSnapshot, revokeStaffTabAccessWithSnapshot } = await import('./lifecycle-revocations.service.js');

const migration = (file: string) => readFileSync(
  fileURLToPath(new URL(`../../../docs/migrations/${file}`, import.meta.url)),
  'utf8',
);
const MIGRATION_269 = migration('269_employee_lifecycle_revocations.sql');
const MIGRATION_351 = migration('351_employee_staff_tab_access.sql');

const EMPLOYEE = 441;
const OTHER_EMPLOYEE = 2520;
const DELETED_EMPLOYEE = 9001;
const GRANTOR = '11111111-1111-4111-8111-111111111111';
const GRANTOR_2 = '22222222-2222-4222-8222-222222222222';
const DISMISS_OP = '33333333-3333-4333-8333-333333333333';

const withClient = async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
  const client = await pg.pool!.connect();
  try {
    return await fn(client);
  } finally {
    client.release();
  }
};

const pgError = async (sql: string): Promise<string | undefined> => {
  try {
    await pg.pool!.query(sql);
    return undefined;
  } catch (err) {
    return (err as { code?: string }).code;
  }
};

describe.skipIf(!PG_URL)('employee_staff_tab_access (351)', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS public.employee_staff_tab_access;
      DROP TABLE IF EXISTS public.employee_lifecycle_revocations;
      DROP TABLE IF EXISTS public.employee_lifecycle_operations;
      -- CASCADE снимает ссылки заглушек других PG-тестов: база общая, а заглушки employees у всех свои.
      DROP TABLE IF EXISTS public.employees CASCADE;
      DROP TABLE IF EXISTS public.user_profiles CASCADE;
      CREATE TABLE public.employees (id bigint PRIMARY KEY);
      CREATE TABLE public.user_profiles (id uuid PRIMARY KEY);
      CREATE TABLE public.employee_lifecycle_operations (id uuid PRIMARY KEY);
      INSERT INTO public.employees (id) VALUES (${EMPLOYEE}), (${OTHER_EMPLOYEE}), (${DELETED_EMPLOYEE});
      INSERT INTO public.user_profiles (id) VALUES ('${GRANTOR}'), ('${GRANTOR_2}');
      INSERT INTO public.employee_lifecycle_operations (id) VALUES ('${DISMISS_OP}');
    `);
    await pg.pool!.query(MIGRATION_269);
  });

  afterAll(async () => {
    // Свои таблицы со ссылками на employees убираем: иначе следующий PG-тест не пересоздаст свою заглушку.
    await pg.pool?.query(`
      DROP TABLE IF EXISTS public.employee_staff_tab_access;
      DROP TABLE IF EXISTS public.employee_lifecycle_revocations;
      DROP TABLE IF EXISTS public.employee_lifecycle_operations;
    `);
    await pg.pool?.end();
  });

  it('до миграции: галочек нет, а не ошибка', async () => {
    await expect(listStaffTabGrants(EMPLOYEE)).resolves.toEqual([]);
  });

  it('миграция применяется и повторяется', async () => {
    await pg.pool!.query(MIGRATION_351);
    await pg.pool!.query(MIGRATION_351);
    await expect(listStaffTabGrants(EMPLOYEE)).resolves.toEqual([]);
  });

  it('недопустимая вкладка и повтор пары отклоняются', async () => {
    expect(await pgError(`INSERT INTO employee_staff_tab_access (employee_id, tab) VALUES (${EMPLOYEE}, 'payroll')`)).toBe('23514');
    await pg.pool!.query(`INSERT INTO employee_staff_tab_access (employee_id, tab) VALUES (${OTHER_EMPLOYEE}, 'dormitory')`);
    expect(await pgError(`INSERT INTO employee_staff_tab_access (employee_id, tab) VALUES (${OTHER_EMPLOYEE}, 'dormitory')`)).toBe('23505');
    expect(await pgError(`INSERT INTO employee_staff_tab_access (employee_id, tab, created_at) VALUES (${OTHER_EMPLOYEE}, 'deductions', NULL)`)).toBe('23502');
    await pg.pool!.query(`DELETE FROM employee_staff_tab_access WHERE employee_id = ${OTHER_EMPLOYEE}`);
  });

  it('две галочки независимы; повтор без изменений; снятие', async () => {
    await withClient(async (client) => {
      await expect(setStaffTabGrant(client, EMPLOYEE, 'deductions', true, GRANTOR)).resolves.toBe(true);
      await expect(listStaffTabGrants(EMPLOYEE)).resolves.toEqual(['deductions']);
      await expect(loadStaffTabGrant(EMPLOYEE, 'dormitory')).resolves.toBe(false);
      await expect(setStaffTabGrant(client, EMPLOYEE, 'deductions', true, GRANTOR)).resolves.toBe(false);
      await expect(setStaffTabGrant(client, EMPLOYEE, 'dormitory', true, GRANTOR_2)).resolves.toBe(true);
      await expect(setStaffTabGrant(client, EMPLOYEE, 'deductions', false, GRANTOR)).resolves.toBe(true);
      await expect(listStaffTabGrants(EMPLOYEE)).resolves.toEqual(['dormitory']);
      await expect(setStaffTabGrant(client, EMPLOYEE, 'deductions', false, GRANTOR)).resolves.toBe(false);
      await expect(listStaffTabGrants(OTHER_EMPLOYEE)).resolves.toEqual([]);
    });
  });

  it('удаление сотрудника удаляет его галочки', async () => {
    await withClient(client => setStaffTabGrant(client, DELETED_EMPLOYEE, 'dormitory', true, GRANTOR));
    await pg.pool!.query(`DELETE FROM employees WHERE id = ${DELETED_EMPLOYEE}`);
    const rows = await pg.pool!.query(`SELECT 1 FROM employee_staff_tab_access WHERE employee_id = ${DELETED_EMPLOYEE}`);
    expect(rows.rowCount).toBe(0);
  });

  it('увольнение: обе галочки снимаются в снимок, «Восстановить» возвращает их с автором и датой; повтор не задваивает', async () => {
    await withClient(async (client) => {
      await setStaffTabGrant(client, EMPLOYEE, 'deductions', true, GRANTOR);
      const before = (await pg.pool!.query(
        `SELECT tab, created_by, created_at FROM employee_staff_tab_access WHERE employee_id = ${EMPLOYEE} ORDER BY tab`,
      )).rows;
      expect(before.map(r => r.tab)).toEqual(['deductions', 'dormitory']);

      await expect(revokeStaffTabAccessWithSnapshot(client, DISMISS_OP, EMPLOYEE)).resolves.toBe(2);
      await expect(listStaffTabGrants(EMPLOYEE)).resolves.toEqual([]);
      // Повтор операции по lease снимок не задваивает.
      await expect(revokeStaffTabAccessWithSnapshot(client, DISMISS_OP, EMPLOYEE)).resolves.toBe(0);
      const snapshot = await pg.pool!.query(
        `SELECT kind, row_id FROM employee_lifecycle_revocations WHERE operation_id = '${DISMISS_OP}' ORDER BY row_id`,
      );
      expect(snapshot.rows).toEqual([
        { kind: 'staff_tab_access', row_id: 'deductions' },
        { kind: 'staff_tab_access', row_id: 'dormitory' },
      ]);

      // Автор одной из галочек удалён за время увольнения — галочка возвращается без автора.
      await pg.pool!.query(`DELETE FROM user_profiles WHERE id = '${GRANTOR_2}'`);

      const restored = await restoreFromSnapshot(client, DISMISS_OP, EMPLOYEE);
      expect(restored.staffTabAccessRestored).toBe(2);
      const after = (await pg.pool!.query(
        `SELECT tab, created_by, created_at FROM employee_staff_tab_access WHERE employee_id = ${EMPLOYEE} ORDER BY tab`,
      )).rows;
      expect(after).toEqual([
        { tab: 'deductions', created_by: GRANTOR, created_at: before[0].created_at },
        { tab: 'dormitory', created_by: null, created_at: before[1].created_at },
      ]);

      const again = await restoreFromSnapshot(client, DISMISS_OP, EMPLOYEE);
      expect(again.staffTabAccessRestored).toBe(0);
    });
  });

  it('удаление учётки автора обнуляет created_by, галочка остаётся', async () => {
    await pg.pool!.query(`DELETE FROM user_profiles WHERE id = '${GRANTOR}'`);
    const rows = (await pg.pool!.query(
      `SELECT tab, created_by FROM employee_staff_tab_access WHERE employee_id = ${EMPLOYEE} ORDER BY tab`,
    )).rows;
    expect(rows).toEqual([
      { tab: 'deductions', created_by: null },
      { tab: 'dormitory', created_by: null },
    ]);
  });

  it('снимок по-прежнему принимает прежние виды и отклоняет чужие', async () => {
    await pg.pool!.query(
      `INSERT INTO employee_lifecycle_revocations (operation_id, employee_id, kind, row_id)
       VALUES ('${DISMISS_OP}', ${EMPLOYEE}, 'department_access', 'acc-1')`,
    );
    expect(await pgError(
      `INSERT INTO employee_lifecycle_revocations (operation_id, employee_id, kind, row_id)
       VALUES ('${DISMISS_OP}', ${EMPLOYEE}, 'something_else', 'x')`,
    )).toBe('23514');
  });
});
