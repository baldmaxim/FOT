import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Основа расчёта «К выплате (ФОТ)» на настоящем PostgreSQL (миграция 331): неизменяемые revision, дозаполнение
// без перезаписи снятого при закрытии, перенос в новую редакцию, сбой основы не ломает транзакцию закрытия,
// выборка основ только закрытых подач. Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД
// (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 4 }) : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    pool: () => pg.pool,
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: vi.fn(),
  };
});

import {
  copyPayrollBasis,
  insertPayrollBasis,
  writePayrollBasisForVersion,
  type IPayrollBasisDraft,
} from './payroll-basis.service.js';
import { loadMonthBasisSources } from './payroll-month-basis.service.js';
import type { ITimesheetVersionPayload } from '../timesheet-version.service.js';

const MIGRATION = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../docs/migrations/331_payroll_version_basis.sql'),
  'utf8',
);

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const draft = (employeeId: number, over: Partial<IPayrollBasisDraft> = {}): IPayrollBasisDraft => ({
  employeeId,
  month: '2026-09-01',
  normDays: 22,
  workdayDates: ['2026-09-01', '2026-09-02'],
  dayoffDates: [],
  absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
  ...over,
});

/** Подача и её редакции; возвращает id редакций по возрастанию revision. */
const seedApproval = async (
  period: { start: string; end: string },
  state: { status?: string; unlocked?: boolean } = {},
  revisions = 1,
): Promise<number[]> => {
  const [approval] = await q<{ id: string }>(
    `INSERT INTO timesheet_approvals (status, unlocked_at, start_date, end_date)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [state.status ?? 'approved', state.unlocked ? new Date() : null, period.start, period.end],
  );
  const ids: number[] = [];
  for (let revision = 1; revision <= revisions; revision++) {
    const [version] = await q<{ id: string }>(
      'INSERT INTO timesheet_versions (approval_id, revision) VALUES ($1, $2) RETURNING id',
      [approval.id, revision],
    );
    ids.push(Number(version.id));
  }
  return ids;
};

describe.skipIf(!PG_URL)('основа расчёта на PostgreSQL', () => {
  beforeAll(async () => {
    await q(`DROP TABLE IF EXISTS timesheet_version_payroll_basis, timesheet_versions, timesheet_approvals,
             payroll_compensation_terms, employees, org_departments CASCADE`);
    await q('CREATE TABLE org_departments (id uuid PRIMARY KEY, name text, kind text)');
    await q('CREATE TABLE employees (id int PRIMARY KEY)');
    await q(`CREATE TABLE timesheet_approvals (
               id bigserial PRIMARY KEY, status text NOT NULL, unlocked_at timestamptz,
               start_date date NOT NULL, end_date date NOT NULL)`);
    await q(`CREATE TABLE timesheet_versions (
               id bigserial PRIMARY KEY, approval_id bigint NOT NULL, revision int NOT NULL, department_id uuid)`);
    await q('CREATE TABLE payroll_compensation_terms (id bigserial PRIMARY KEY, employee_id int NOT NULL)');
    await q('INSERT INTO employees (id) VALUES (71), (72)');
    // Повторный запуск миграции безопасен.
    await q(MIGRATION);
    await q(MIGRATION);
  });

  beforeEach(async () => {
    await q('TRUNCATE timesheet_version_payroll_basis, timesheet_versions, timesheet_approvals RESTART IDENTITY');
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('повторное закрытие: та же основа — ничего; другая норма — revision 2, прежняя строка цела', async () => {
    const [versionId] = await seedApproval({ start: '2026-09-01', end: '2026-09-15' });
    const options = { quality: 'materialized', reason: 'close', mode: 'changed' } as const;

    expect(await insertPayrollBasis(pg.pool!, versionId, [draft(71)], options)).toBe(1);
    expect(await insertPayrollBasis(pg.pool!, versionId, [draft(71)], options)).toBe(0);
    expect(await insertPayrollBasis(pg.pool!, versionId, [draft(71, { normDays: 23 })], options)).toBe(1);

    const rows = await q<{ revision: number; norm_days: number; workday_dates: string[] }>(
      `SELECT revision, norm_days, workday_dates::text[] AS workday_dates
         FROM timesheet_version_payroll_basis ORDER BY revision`,
    );
    expect(rows).toEqual([
      { revision: 1, norm_days: 22, workday_dates: ['2026-09-01', '2026-09-02'] },
      { revision: 2, norm_days: 23, workday_dates: ['2026-09-01', '2026-09-02'] },
    ]);
  });

  it('дозаполнение не трогает снятую при закрытии основу и повторяется без эффекта', async () => {
    const [versionId] = await seedApproval({ start: '2026-09-01', end: '2026-09-15' });
    await insertPayrollBasis(pg.pool!, versionId, [draft(71)], { quality: 'materialized', reason: 'close', mode: 'changed' });
    const backfill = { quality: 'reconstructed', reason: 'backfill', mode: 'missing' } as const;

    expect(await insertPayrollBasis(pg.pool!, versionId, [draft(71, { normDays: 21 }), draft(72)], backfill)).toBe(1);
    expect(await insertPayrollBasis(pg.pool!, versionId, [draft(72, { normDays: 21 })], backfill)).toBe(0);

    const rows = await q<{ employee_id: number; quality: string; norm_days: number }>(
      'SELECT employee_id, quality, norm_days FROM timesheet_version_payroll_basis ORDER BY employee_id',
    );
    expect(rows).toEqual([
      { employee_id: 71, quality: 'materialized', norm_days: 22 },
      { employee_id: 72, quality: 'reconstructed', norm_days: 22 },
    ]);
  });

  it('перенос в новую редакцию — последняя revision, без исключённых, качество прежнее', async () => {
    const [from, to] = await seedApproval({ start: '2026-09-01', end: '2026-09-15' }, {}, 2);
    await insertPayrollBasis(pg.pool!, from, [draft(71), draft(72)], { quality: 'reconstructed', reason: 'backfill', mode: 'missing' });
    await insertPayrollBasis(pg.pool!, from, [draft(71, { normDays: 23 })], { quality: 'materialized', reason: 'close', mode: 'changed' });

    const client = await pg.pool!.connect();
    try {
      await client.query('BEGIN');
      await copyPayrollBasis(client, from, to, [72]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }

    const rows = await q<{ employee_id: number; revision: number; norm_days: number; quality: string; reason: string }>(
      'SELECT employee_id, revision, norm_days, quality, reason FROM timesheet_version_payroll_basis WHERE version_id = $1',
      [to],
    );
    expect(rows).toEqual([{ employee_id: 71, revision: 1, norm_days: 23, quality: 'materialized', reason: 'rebuild' }]);
  });

  it('сбой сборки основы не ломает транзакцию закрытия', async () => {
    const [versionId] = await seedApproval({ start: '2026-09-01', end: '2026-09-15' });
    // В заглушке employees нет колонок увольнения — запрос основы падает внутри SAVEPOINT.
    const payload = {
      approval: { start_date: '2026-09-01', end_date: '2026-09-15' },
      employees: [{ identity: { employee_id: 71 }, days: {} }],
    } as unknown as ITimesheetVersionPayload;

    const client = await pg.pool!.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE timesheet_approvals SET status = $1', ['approved']);
      await writePayrollBasisForVersion(client, versionId, payload);
      const [{ ok }] = (await client.query<{ ok: number }>('SELECT 1 AS ok')).rows;
      expect(ok).toBe(1);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await q('SELECT 1 FROM timesheet_version_payroll_basis')).toEqual([]);
  });

  it('выборка основ: только закрытые подачи, последняя редакция и последняя revision', async () => {
    const [, firstLatest] = await seedApproval({ start: '2026-09-01', end: '2026-09-15' }, {}, 2);
    const [second] = await seedApproval({ start: '2026-09-16', end: '2026-09-30' });
    const [reopened] = await seedApproval({ start: '2026-09-16', end: '2026-09-30' }, { unlocked: true });
    const [submitted] = await seedApproval({ start: '2026-09-16', end: '2026-09-30' }, { status: 'submitted' });
    const close = { quality: 'materialized', reason: 'close', mode: 'changed' } as const;
    await insertPayrollBasis(pg.pool!, firstLatest, [draft(71)], close);
    await insertPayrollBasis(pg.pool!, firstLatest, [draft(71, { workdayDates: ['2026-09-03'] })], close);
    await insertPayrollBasis(pg.pool!, second, [draft(71, { workdayDates: ['2026-09-16'] })], close);
    await insertPayrollBasis(pg.pool!, reopened, [draft(71, { workdayDates: ['2026-09-17'] })], close);
    await insertPayrollBasis(pg.pool!, submitted, [draft(71, { workdayDates: ['2026-09-18'] })], close);
    await insertPayrollBasis(pg.pool!, second, [draft(71, { month: '2026-10-01', workdayDates: ['2026-10-01'] })], close);

    const sources = (await loadMonthBasisSources([71], '2026-09')).get(71) ?? [];
    expect(sources.map(source => [source.coverFrom, source.coverTo, source.workdayDates]).sort()).toEqual([
      ['2026-09-01', '2026-09-15', ['2026-09-03']],
      ['2026-09-16', '2026-09-30', ['2026-09-16']],
    ]);
  });
});
