import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Статусы выгрузки «сотрудников месяца» в ЗУП3 на настоящем PostgreSQL: миграция 373 (и её повтор), ревизии после
// сборок, надгробие, подтверждения 1С без снимка в памяти (как после рестарта), статусы для «Расчётов», каскад.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;
const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => pg.pool!.query(sql, params as unknown[]);
  return {
    getPool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      const client = await pg.pool!.connect();
      try {
        await client.query('BEGIN');
        const out = await fn(client);
        await client.query('COMMIT');
        return out;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      } finally {
        client.release();
      }
    },
  };
});

import {
  ackStaffMonth,
  loadStaffMonthExportInfo,
  loadZup3ExportStates,
  persistStaffMonthStates,
} from './staff-month-1c.export-state.js';
import { staffMonthExportState } from './staff-month-1c.export-state.rules.js';

const MIGRATION = readFileSync(fileURLToPath(new URL('../../../docs/migrations/373_staff_month_1c_export_states.sql', import.meta.url)), 'utf8');
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const sql = async (text: string, params: unknown[] = []) => (await pg.pool!.query(text, params)).rows;

describe.skipIf(!PG_URL)('staff-month-1c.export-state — PostgreSQL', () => {
  beforeAll(async () => {
    await sql(`DROP TABLE IF EXISTS staff_month_1c_exports, staff_month_1c_states, staff_month_1c_state_revisions,
                 employees, data_api_keys CASCADE`);
    await sql('CREATE TABLE employees (id int PRIMARY KEY)');
    await sql('CREATE TABLE data_api_keys (id uuid PRIMARY KEY)');
    await sql('INSERT INTO employees VALUES (1), (2), (3)');
    await sql(MIGRATION);
    await sql(MIGRATION); // повтор безопасен
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('ревизии, надгробие, ACK без снимка, A → B → A, статусы «Расчётов», каскад', async () => {
    // Сборка 1: 1 — A, 2 — B, 3 — предварительный.
    let states = await persistStaffMonthStates('2026-10', [
      { employeeId: 1, preliminary: false, contentHash: A },
      { employeeId: 2, preliminary: false, contentHash: B },
      { employeeId: 3, preliminary: true, contentHash: A },
    ]);
    expect([...states].map(([id, st]) => [id, st.revision])).toEqual([[1, 1], [2, 1], [3, 1]]);
    // Та же сборка — ревизии не растут.
    await persistStaffMonthStates('2026-10', [
      { employeeId: 1, preliminary: false, contentHash: A },
      { employeeId: 2, preliminary: false, contentHash: B },
      { employeeId: 3, preliminary: true, contentHash: A },
    ]);
    expect((await sql('SELECT count(*)::int AS n FROM staff_month_1c_state_revisions'))[0].n).toBe(3);

    // ACK: 1 и 2 принимаются, 3 — предварительный, чужой хеш и несуществующая ревизия — отказ.
    const ack = await ackStaffMonth({
      month: '2026-10', documentRef: 'ЗУП-15', keyId: null,
      items: [
        { employeeId: 1, revision: 1, contentHash: A },
        { employeeId: 2, revision: 1, contentHash: B },
        { employeeId: 3, revision: 1, contentHash: A },
        { employeeId: 1, revision: 9, contentHash: A },
      ],
    });
    expect(ack.accepted.map(item => item.employee_id)).toEqual([1, 2]);
    expect(ack.rejected.map(item => [item.employee_id, item.code])).toEqual([[3, 'not_ready'], [1, 'not_found']]);
    const again = await ackStaffMonth({ month: '2026-10', documentRef: 'ЗУП-15', keyId: null, items: [{ employeeId: 1, revision: 1, contentHash: A }] });
    expect(again.accepted[0].acked_at).toBe(ack.accepted[0].acked_at);
    const wrong = await ackStaffMonth({ month: '2026-10', documentRef: null, keyId: null, items: [{ employeeId: 2, revision: 1, contentHash: A }] });
    expect(wrong.rejected[0].code).toBe('hash_mismatch');

    // Сборка 2: 1 → B, 2 пропал (надгробие), 3 стал окончательным.
    states = await persistStaffMonthStates('2026-10', [
      { employeeId: 1, preliminary: false, contentHash: B },
      { employeeId: 3, preliminary: false, contentHash: A },
    ]);
    expect(states.get(1)).toMatchObject({ revision: 2, present: true, contentHash: B });
    expect(states.get(2)).toMatchObject({ revision: 2, present: false, contentHash: null });
    let info = await loadStaffMonthExportInfo('2026-10');
    expect(staffMonthExportState(info.states.get(1), info.acks.get(1))).toBe('changed');
    expect(staffMonthExportState(info.states.get(2), info.acks.get(2))).toBe('changed'); // надгробие к удалению в ЗУП3
    expect(staffMonthExportState(info.states.get(3), info.acks.get(3))).toBe('ready');

    // Сборка 3: 1 снова A — ревизия 3; прежний ACK A (ревизия 1) её не закрывает.
    states = await persistStaffMonthStates('2026-10', [
      { employeeId: 1, preliminary: false, contentHash: A },
      { employeeId: 3, preliminary: false, contentHash: A },
    ]);
    expect(states.get(1)?.revision).toBe(3);
    info = await loadStaffMonthExportInfo('2026-10');
    expect(staffMonthExportState(info.states.get(1), info.acks.get(1))).toBe('changed');
    await ackStaffMonth({
      month: '2026-10', documentRef: 'ЗУП-16', keyId: null,
      items: [{ employeeId: 1, revision: 3, contentHash: A }, { employeeId: 2, revision: 2, contentHash: null }],
    });
    info = await loadStaffMonthExportInfo('2026-10');
    expect(staffMonthExportState(info.states.get(1), info.acks.get(1))).toBe('exported');
    expect(staffMonthExportState(info.states.get(2), info.acks.get(2))).toBeNull(); // удаление подтверждено

    // «Расчёты»: по сотрудникам и месяцам, надгробие не показывается.
    const cells = await loadZup3ExportStates([1, 2, 3], ['2026-10', '2026-11']);
    expect(cells.get(1)).toEqual([expect.objectContaining({ month: '2026-10', state: 'exported', document_ref: 'ЗУП-16' })]);
    expect(cells.has(2)).toBe(false);
    expect(cells.get(3)?.[0].state).toBe('ready');

    // Удаление сотрудника — каскадом.
    await sql('DELETE FROM employees WHERE id = 1');
    expect((await sql('SELECT count(*)::int AS n FROM staff_month_1c_state_revisions WHERE employee_id = 1'))[0].n).toBe(0);
  });
});
