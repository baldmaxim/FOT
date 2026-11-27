import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Статусы выгрузки «сотрудников месяца» в ЗУП3 по половинам месяца на настоящем PostgreSQL: миграция 375 (повтор, в
// том числе после подтверждений; откат и повторное применение), ревизии половин после сборок, надгробие, подтверждения
// 1С без снимка в памяти (как после рестарта), подтверждение одной половины не трогает другую, статусы для «Расчётов»,
// каскад. Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

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
  loadStaffMonthBuild,
  loadStaffMonthExportInfo,
  persistStaffMonthStates,
} from './staff-month-1c.export-state.js';
import { staffMonthExportState } from './staff-month-1c.export-state.rules.js';

const read = (path: string): string => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const MIGRATION = read('../../../docs/migrations/375_staff_month_1c_halves.sql');
const ROLLBACK = read('../../../docs/rollbacks/375_staff_month_1c_halves_rollback.sql');
const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const sql = async (text: string, params: unknown[] = []) => (await pg.pool!.query(text, params)).rows;
const count = async (table: string): Promise<number> => (await sql(`SELECT count(*)::int AS n FROM ${table}`))[0].n;
const row = (employeeId: number, contentHash: string, preliminary = false) => ({ employeeId, preliminary, contentHash });

describe.skipIf(!PG_URL)('staff-month-1c.export-state — половины на PostgreSQL', () => {
  beforeAll(async () => {
    await sql(`DROP TABLE IF EXISTS staff_month_1c_half_exports, staff_month_1c_half_states, staff_month_1c_half_revisions,
                 staff_month_1c_half_builds, employees, data_api_keys, schema_migrations CASCADE`);
    await sql('CREATE TABLE employees (id int PRIMARY KEY)');
    await sql('CREATE TABLE data_api_keys (id uuid PRIMARY KEY)');
    await sql('CREATE TABLE schema_migrations (filename text PRIMARY KEY)');
    await sql('INSERT INTO employees VALUES (1), (2), (3)');
    await sql(MIGRATION);
    await sql(MIGRATION); // повтор безопасен
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('ревизии половин, подтверждение половины не трогает другую, надгробие, A → B → A, «Расчёты», повтор миграции', async () => {
    // Сборка 1: в 1–15 — 1 (A), 2 (B), 3 (предварительный); в 16–31 — 1 (B), 2 (предварительный).
    let states = await persistStaffMonthStates('2026-10', new Map([
      [1, [row(1, A), row(2, B), row(3, A, true)]],
      [2, [row(1, B), row(2, A, true)]],
    ]), 'fp');
    expect([...states.get(1)!].map(([id, st]) => [id, st.revision])).toEqual([[1, 1], [2, 1], [3, 1]]);
    expect([...states.get(2)!].map(([id, st]) => [id, st.revision])).toEqual([[1, 1], [2, 1]]);
    // Та же сборка — ревизии не растут.
    await persistStaffMonthStates('2026-10', new Map([
      [1, [row(1, A), row(2, B), row(3, A, true)]],
      [2, [row(1, B), row(2, A, true)]],
    ]), 'fp');
    expect(await count('staff_month_1c_half_revisions')).toBe(5);
    expect((await loadStaffMonthBuild('2026-10'))?.fingerprint).toBe('fp');
    expect(await loadStaffMonthBuild('2026-11')).toBeNull();

    // Подтверждение 1–15: 1 и 2 приняты, 3 — предварительный, ревизия 9 — нет; хеш 16–31 для 1–15 — отказ.
    const ack = await ackStaffMonth({
      month: '2026-10', half: 1, documentRef: 'ЗУП-15', keyId: null,
      items: [
        { employeeId: 1, revision: 1, contentHash: A },
        { employeeId: 2, revision: 1, contentHash: B },
        { employeeId: 3, revision: 1, contentHash: A },
        { employeeId: 1, revision: 9, contentHash: A },
      ],
    });
    expect(ack.accepted.map(item => item.employee_id)).toEqual([1, 2]);
    expect(ack.rejected.map(item => [item.employee_id, item.code])).toEqual([[3, 'not_ready'], [1, 'not_found']]);
    const again = await ackStaffMonth({ month: '2026-10', half: 1, documentRef: 'ЗУП-15', keyId: null, items: [{ employeeId: 1, revision: 1, contentHash: A }] });
    expect(again.accepted[0].acked_at).toBe(ack.accepted[0].acked_at);
    const wrongHalf = await ackStaffMonth({ month: '2026-10', half: 1, documentRef: null, keyId: null, items: [{ employeeId: 1, revision: 1, contentHash: B }] });
    expect(wrongHalf.rejected[0].code).toBe('hash_mismatch');

    // 1–15 выгружена, 16–31 у того же сотрудника — «готов»: подтверждение половины другую не закрывает.
    const first = await loadStaffMonthExportInfo('2026-10', 1);
    const second = await loadStaffMonthExportInfo('2026-10', 2);
    expect(staffMonthExportState(first.states.get(1), first.acks.get(1))).toBe('exported');
    expect(staffMonthExportState(second.states.get(1), second.acks.get(1))).toBe('ready');
    expect(staffMonthExportState(second.states.get(2), second.acks.get(2))).toBe('not_ready');

    // Повтор миграции после подтверждений — подтверждения и ревизии на месте.
    await sql(MIGRATION);
    expect(await count('staff_month_1c_half_exports')).toBe(2);
    expect(await count('staff_month_1c_half_revisions')).toBe(5);

    // Сборка 2 (1–15): 1 → B, 2 пропал (надгробие), 3 стал окончательным. 16–31 без изменений.
    states = await persistStaffMonthStates('2026-10', new Map([
      [1, [row(1, B), row(3, A)]],
      [2, [row(1, B), row(2, A, true)]],
    ]), 'fp');
    expect(states.get(1)!.get(1)).toMatchObject({ revision: 2, present: true, contentHash: B });
    expect(states.get(1)!.get(2)).toMatchObject({ revision: 2, present: false, contentHash: null });
    expect(states.get(2)!.get(1)?.revision).toBe(1);
    let info = await loadStaffMonthExportInfo('2026-10', 1);
    expect(staffMonthExportState(info.states.get(1), info.acks.get(1))).toBe('changed');
    expect(staffMonthExportState(info.states.get(2), info.acks.get(2))).toBe('changed'); // надгробие к удалению в ЗУП3
    expect(staffMonthExportState(info.states.get(3), info.acks.get(3))).toBe('ready');

    // Сборка 3 (1–15): 1 снова A — ревизия 3; прежний ACK A (ревизия 1) её не закрывает.
    states = await persistStaffMonthStates('2026-10', new Map([[1, [row(1, A), row(3, A)]]]), 'fp');
    expect(states.get(1)!.get(1)?.revision).toBe(3);
    info = await loadStaffMonthExportInfo('2026-10', 1);
    expect(staffMonthExportState(info.states.get(1), info.acks.get(1))).toBe('changed');
    await ackStaffMonth({
      month: '2026-10', half: 1, documentRef: 'ЗУП-16', keyId: null,
      items: [{ employeeId: 1, revision: 3, contentHash: A }, { employeeId: 2, revision: 2, contentHash: null }],
    });
    info = await loadStaffMonthExportInfo('2026-10', 1);
    expect(staffMonthExportState(info.states.get(1), info.acks.get(1))).toBe('exported');
    expect(staffMonthExportState(info.states.get(2), info.acks.get(2))).toBeNull(); // удаление подтверждено

    // Удаление сотрудника — каскадом.
    await sql('DELETE FROM employees WHERE id = 1');
    expect((await sql('SELECT count(*)::int AS n FROM staff_month_1c_half_revisions WHERE employee_id = 1'))[0].n).toBe(0);
  });

  it('откат 375 удаляет таблицы половин, повторное применение создаёт их заново', async () => {
    await sql(`INSERT INTO schema_migrations VALUES ('375_staff_month_1c_halves.sql')`);
    await sql(ROLLBACK);
    expect(await sql(`SELECT to_regclass('staff_month_1c_half_states') AS t`)).toEqual([{ t: null }]);
    expect(await count('schema_migrations')).toBe(0);
    await sql(ROLLBACK); // повтор отката не падает
    await sql(MIGRATION);
    expect(await count('staff_month_1c_half_states')).toBe(0);
    const states = await persistStaffMonthStates('2026-12', new Map([[1, [row(2, A)]]]), 'fp');
    expect(states.get(1)!.get(2)?.revision).toBe(1);
  });
});
