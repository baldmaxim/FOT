import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Сумма правок дня по объектам на настоящем PostgreSQL: что входит в сумму и что два
// параллельных сохранения разных объектов одного дня под общим локом не проходят оба.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).
const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(20, (val: string) => Number.parseInt(val, 10));
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 5 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    pool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: async <T>(fn: (client: import('pg').PoolClient) => Promise<T>): Promise<T> => {
      if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
      const client = await pg.pool.connect();
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

import { withEmployeeMonthQuotaLock } from './timesheet.controller.js';
import {
  assertDayCorrectionsWithinCap,
  CorrectionRestrictionError,
  invalidateCorrectionRestrictionsCache,
} from '../services/correction-restrictions.service.js';

const ROLE = '00000000-0000-4000-8000-0000000000a1';
const ROLE_OFF = '00000000-0000-4000-8000-0000000000a2';
const EMP = 1731;
const DATE = '2026-11-09';

const q = async (sql: string, params?: unknown[]) => (await pg.pool!.query(sql, params)).rows;

const addRow = async (row: {
  objectId: string; hours: number; approval?: string; metadata?: Record<string, unknown>; date?: string;
}): Promise<number> => {
  const rows = await q(
    `INSERT INTO attendance_adjustments (employee_id, work_date, status, source_type, source_id, hours_override, approval_status, metadata)
     VALUES ($1, $2, 'manual', 'manual_object', $3, $4, $5, $6) RETURNING id`,
    [EMP, row.date ?? DATE, row.objectId, row.hours, row.approval ?? 'auto_approved', row.metadata ?? {}],
  );
  return Number(rows[0].id);
};

const input = (hours: number, excludeAdjustmentId: number | null = null, systemRoleId = ROLE) => ({
  systemRoleId, employeeId: EMP, workDate: DATE, hours, correctionCapHours: 8, excludeAdjustmentId,
});

describe.skipIf(!PG_URL)('assertDayCorrectionsWithinCap (PG)', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS attendance_adjustments, system_roles CASCADE;
      CREATE TABLE system_roles (
        id uuid PRIMARY KEY,
        corrections_anomalies_only boolean NOT NULL DEFAULT false,
        corrections_cap_by_schedule_norm boolean NOT NULL DEFAULT false,
        corrections_allow_zero_short_attendance boolean NOT NULL DEFAULT false,
        corrections_disable_bulk boolean NOT NULL DEFAULT false,
        corrections_disable_object_entries boolean NOT NULL DEFAULT false,
        max_corrections_per_month integer NULL,
        weekend_memo_required boolean NOT NULL DEFAULT false
      );
      CREATE TABLE attendance_adjustments (
        id bigserial PRIMARY KEY, employee_id integer NOT NULL, work_date date NOT NULL,
        status text NOT NULL, source_type text NOT NULL, source_id text NOT NULL,
        hours_override numeric(5,2) NULL, approval_status text NOT NULL,
        metadata jsonb NOT NULL DEFAULT '{}',
        UNIQUE (employee_id, work_date, source_type, source_id)
      );
    `);
    await q(
      `INSERT INTO system_roles (id, corrections_cap_by_schedule_norm) VALUES ($1, true), ($2, false)`,
      [ROLE, ROLE_OFF],
    );
  });

  beforeEach(async () => {
    invalidateCorrectionRestrictionsCache();
    await q('TRUNCATE attendance_adjustments');
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('другой объект входит в сумму: 6 + 6 при графике 8 — отказ, 6 + 2 — можно', async () => {
    await addRow({ objectId: 'a', hours: 6 });
    await expect(assertDayCorrectionsWithinCap(null, input(6))).rejects.toMatchObject({
      code: 'hours_exceed_norm',
      details: { otherHours: 6, correctionCapHours: 8 },
    });
    await expect(assertDayCorrectionsWithinCap(null, input(2))).resolves.toBeUndefined();
  });

  it('pending и approved занимают предел, отклонённая — нет', async () => {
    await addRow({ objectId: 'a', hours: 3, approval: 'pending' });
    await addRow({ objectId: 'b', hours: 3, approval: 'approved' });
    await addRow({ objectId: 'c', hours: 8, approval: 'rejected' });
    await expect(assertDayCorrectionsWithinCap(null, input(2))).resolves.toBeUndefined();
    await expect(assertDayCorrectionsWithinCap(null, input(3))).rejects.toMatchObject({ code: 'hours_exceed_norm' });
  });

  it('мигрированная из day-level строка семантически дневная: в сумму не входит', async () => {
    await addRow({ objectId: 'a', hours: 8, metadata: { migrated_from_day_level: true } });
    await expect(assertDayCorrectionsWithinCap(null, input(8))).resolves.toBeUndefined();
  });

  it('правимая строка не считается: снижение на своём объекте идёт от новых часов', async () => {
    const id = await addRow({ objectId: 'a', hours: 8 });
    await expect(assertDayCorrectionsWithinCap(null, input(8, id))).resolves.toBeUndefined();
    await expect(assertDayCorrectionsWithinCap(null, input(9, id))).rejects.toMatchObject({ code: 'hours_exceed_norm' });
  });

  it('другая дата и нулевые часы в сумму не входят', async () => {
    await addRow({ objectId: 'a', hours: 8, date: '2026-11-10' });
    await addRow({ objectId: 'b', hours: 0 });
    await expect(assertDayCorrectionsWithinCap(null, input(8))).resolves.toBeUndefined();
  });

  it('галочка роли снята: сумма сверх графика проходит', async () => {
    await addRow({ objectId: 'a', hours: 8 });
    await expect(assertDayCorrectionsWithinCap(null, input(8, null, ROLE_OFF))).resolves.toBeUndefined();
  });

  it('два параллельных сохранения разных объектов дня: второе видит первое и получает отказ', async () => {
    const saveObject = (objectId: string) => withEmployeeMonthQuotaLock(EMP, DATE, async exec => {
      await assertDayCorrectionsWithinCap(exec, input(5));
      // Пауза между проверкой и записью: без общего лока оба сохранения прошли бы проверку.
      await new Promise(resolve => setTimeout(resolve, 150));
      await exec.query(
        `INSERT INTO attendance_adjustments (employee_id, work_date, status, source_type, source_id, hours_override, approval_status)
         VALUES ($1, $2, 'manual', 'manual_object', $3, 5, 'auto_approved')`,
        [EMP, DATE, objectId],
      );
    });

    const results = await Promise.allSettled([saveObject('a'), saveObject('b')]);

    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    expect(rejected?.reason).toBeInstanceOf(CorrectionRestrictionError);
    const rows = await q(`SELECT source_id FROM attendance_adjustments WHERE employee_id = $1`, [EMP]);
    expect(rows).toHaveLength(1);
  });
});
