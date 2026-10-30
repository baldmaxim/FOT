import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Основа расчёта «К выплате (ФОТ)» на настоящем PostgreSQL (миграция 331): неизменяемые revision, дозаполнение
// без перезаписи снятого при закрытии, перенос в новую редакцию, сбой основы не ломает транзакцию закрытия,
// выборка основ только закрытых подач, исправление переработки новой revision. Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД
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

import {
  copyPayrollBasis,
  insertPayrollBasis,
  writePayrollBasisForVersion,
  type IPayrollBasisDraft,
} from './payroll-basis.service.js';
import { fixPayrollBasisOvertime } from './payroll-basis-overtime-fix.service.js';
import { loadMonthBasisSources } from './payroll-month-basis.service.js';
import type { ITimesheetVersionPayload } from '../timesheet-version.service.js';

const migration = (name: string): string => readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), `../../../../docs/migrations/${name}`),
  'utf8',
);
const MIGRATION = migration('331_payroll_version_basis.sql');
// 339 — даты отсутствий в основе (absence_dates).
const MIGRATION_339 = migration('339_payroll_housing_by_days.sql');

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const draft = (employeeId: number, over: Partial<IPayrollBasisDraft> = {}): IPayrollBasisDraft => ({
  employeeId,
  month: '2026-09-01',
  normDays: 22,
  normMinutes: 10560,
  workdayDates: ['2026-09-01', '2026-09-02'],
  dayoffDates: [],
  absenceDays: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
  absenceDates: { vacation: [], sick: [], educational_leave: [], unpaid: [] },
  overtimeMinutes: { '2026-09-02': 180 },
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
    await q('CREATE TABLE employees (id int PRIMARY KEY, full_name text)');
    await q(`CREATE TABLE timesheet_approvals (
               id bigserial PRIMARY KEY, status text NOT NULL, unlocked_at timestamptz,
               start_date date NOT NULL, end_date date NOT NULL)`);
    await q(`CREATE TABLE timesheet_versions (
               id bigserial PRIMARY KEY, approval_id bigint NOT NULL, revision int NOT NULL, department_id uuid,
               payload jsonb)`);
    await q('CREATE TABLE payroll_compensation_terms (id bigserial PRIMARY KEY, employee_id int NOT NULL)');
    await q(`INSERT INTO employees (id, full_name) VALUES (71, 'Марухина В.С.'), (72, NULL)`);
    // Повторный запуск миграции безопасен.
    await q(MIGRATION);
    await q(MIGRATION);
    await q(MIGRATION_339);
    await q(MIGRATION_339);
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

    const rows = await q<{ revision: number; norm_days: number; norm_minutes: number; workday_dates: string[]; overtime_minutes: unknown }>(
      `SELECT revision, norm_days, norm_minutes, workday_dates::text[] AS workday_dates, overtime_minutes
         FROM timesheet_version_payroll_basis ORDER BY revision`,
    );
    expect(rows).toEqual([
      { revision: 1, norm_days: 22, norm_minutes: 10560, workday_dates: ['2026-09-01', '2026-09-02'], overtime_minutes: { '2026-09-02': 180 } },
      { revision: 2, norm_days: 23, norm_minutes: 10560, workday_dates: ['2026-09-01', '2026-09-02'], overtime_minutes: { '2026-09-02': 180 } },
    ]);
    // Другие часы переработки — тоже новая revision.
    expect(await insertPayrollBasis(pg.pool!, versionId, [draft(71, { normDays: 23, overtimeMinutes: {} })], options)).toBe(1);
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

    const rows = await q<{ employee_id: number; revision: number; norm_days: number; norm_minutes: number; overtime_minutes: unknown; quality: string; reason: string }>(
      `SELECT employee_id, revision, norm_days, norm_minutes, overtime_minutes, quality, reason
         FROM timesheet_version_payroll_basis WHERE version_id = $1`,
      [to],
    );
    expect(rows).toEqual([{
      employee_id: 71, revision: 1, norm_days: 23, norm_minutes: 10560, overtime_minutes: { '2026-09-02': 180 },
      quality: 'materialized', reason: 'rebuild',
    }]);
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

  it('339: даты отсутствий пишутся при закрытии, переносятся в новую редакцию и читаются расчётом', async () => {
    const [first, second] = await seedApproval({ start: '2026-09-01', end: '2026-09-30' }, {}, 2);
    const absenceDates = { vacation: ['2026-09-10', '2026-09-11'], sick: ['2026-09-14'], educational_leave: [], unpaid: [] };
    await insertPayrollBasis(pg.pool!, first, [draft(71, {
      absenceDays: { vacation: 2, sick: 1, educational_leave: 0, unpaid: 0 }, absenceDates,
    })], { quality: 'materialized', reason: 'close', mode: 'changed' });
    const client = await pg.pool!.connect();
    try {
      await client.query('BEGIN');
      await copyPayrollBasis(client, first, second);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const [copied] = await q<{ absence_dates: unknown }>(
      'SELECT absence_dates FROM timesheet_version_payroll_basis WHERE version_id = $1', [second],
    );
    expect(copied.absence_dates).toEqual(absenceDates);
    const [source] = (await loadMonthBasisSources([71], '2026-09')).get(71) ?? [];
    expect(source.absenceDates).toEqual(absenceDates);
  });

  it('исправление переработки: новая revision только с уменьшением, поля и качество прежние, повтор — без эффекта', async () => {
    const [versionId] = await seedApproval({ start: '2026-09-01', end: '2026-09-15' });
    await q(`UPDATE timesheet_versions SET payload = '{"employees": []}'::jsonb WHERE id = $1`, [versionId]);
    // 71: 4-е — короткая пятница (60 мин уходят), 2-е — 11 ч (остаются); у 72 переработка не меняется.
    await insertPayrollBasis(pg.pool!, versionId, [
      draft(71, { overtimeMinutes: { '2026-09-02': 180, '2026-09-04': 60 } }),
      draft(72, { overtimeMinutes: { '2026-09-03': 120 } }),
    ], { quality: 'materialized', reason: 'close', mode: 'changed' });
    // Пересборка по нынешним графикам: больше минут, чем было, и другая норма — не берутся.
    const rebuild = async () => [
      draft(71, { normDays: 99, overtimeMinutes: { '2026-09-02': 240 } }),
      draft(72, { overtimeMinutes: { '2026-09-03': 120 } }),
    ];

    const dry = await fixPayrollBasisOvertime({ apply: false, rebuild, sampleEmployeeIds: new Set([71]) });
    expect(dry).toMatchObject({
      candidates: 2, changed: 1, written: 0, failedVersions: [],
      months: [{ month: '2026-09', rows: 1, people: 1, minutesBefore: 240, minutesAfter: 180 }],
    });
    expect(dry.samples).toEqual([{
      employeeId: 71, fullName: 'Марухина В.С.', month: '2026-09', versionId,
      before: { '2026-09-02': 180, '2026-09-04': 60 }, after: { '2026-09-02': 180 },
    }]);
    expect(await q('SELECT count(*)::int AS n FROM timesheet_version_payroll_basis')).toEqual([{ n: 2 }]);

    expect((await fixPayrollBasisOvertime({ apply: true, rebuild })).written).toBe(1);
    expect(await q(`SELECT employee_id, revision, norm_days, workday_dates::text[] AS workday_dates, overtime_minutes,
                           quality, reason
                      FROM timesheet_version_payroll_basis ORDER BY employee_id, revision`)).toEqual([
      {
        employee_id: 71, revision: 1, norm_days: 22, workday_dates: ['2026-09-01', '2026-09-02'],
        overtime_minutes: { '2026-09-02': 180, '2026-09-04': 60 }, quality: 'materialized', reason: 'close',
      },
      {
        employee_id: 71, revision: 2, norm_days: 22, workday_dates: ['2026-09-01', '2026-09-02'],
        overtime_minutes: { '2026-09-02': 180 }, quality: 'materialized', reason: 'backfill',
      },
      {
        employee_id: 72, revision: 1, norm_days: 22, workday_dates: ['2026-09-01', '2026-09-02'],
        overtime_minutes: { '2026-09-03': 120 }, quality: 'materialized', reason: 'close',
      },
    ]);
    // Расчёт берёт исправленную revision.
    expect((await loadMonthBasisSources([71], '2026-09')).get(71)?.[0].overtimeMinutes).toEqual({ '2026-09-02': 180 });

    // Повтор — без эффекта.
    expect(await fixPayrollBasisOvertime({ apply: true, rebuild })).toMatchObject({ changed: 0, written: 0 });
  });

  it('добор «УУ» с правкой: только дни payload с правкой и часами, бывшие рабочими днями основы; повтор — без эффекта', async () => {
    const [versionId] = await seedApproval({ start: '2026-09-01', end: '2026-09-30' });
    const remote = (hours: number, overridden: boolean) => ({ status: 'remote', hours, corrected: true, hours_overridden: overridden });
    await q('UPDATE timesheet_versions SET payload = $2::jsonb WHERE id = $1', [versionId, JSON.stringify({
      employees: [
        {
          identity: { employee_id: 71 },
          days: {
            '2026-09-10': remote(9, true),
            // Без правки, с нулём часов, выходной (нет в рабочих днях основы), другой месяц — не добавляются.
            '2026-09-11': remote(9, false),
            '2026-09-14': remote(0, true),
            '2026-09-12': remote(9, true),
            '2026-10-01': remote(9, true),
          },
        },
        // Как Ващук: «УУ» 10 ч при графике 10 ч — кандидат без изменений.
        { identity: { employee_id: 72 }, days: { '2026-09-01': remote(10, true) } },
      ],
    })]);
    const seeded = { quality: 'reconstructed', reason: 'backfill', mode: 'missing' } as const;
    await insertPayrollBasis(pg.pool!, versionId, [
      draft(71, { workdayDates: ['2026-09-10', '2026-09-11', '2026-09-14'], overtimeMinutes: {} }),
      draft(72, { workdayDates: ['2026-09-01'], overtimeMinutes: {} }),
    ], seeded);
    const rebuild = async () => [
      draft(71, { normDays: 99, overtimeMinutes: { '2026-09-10': 60, '2026-09-11': 60, '2026-09-12': 60 } }),
      draft(72, { overtimeMinutes: {} }),
    ];

    const dry = await fixPayrollBasisOvertime({ apply: false, mode: 'remote', rebuild, sampleEmployeeIds: new Set([72]) });
    expect(dry).toMatchObject({
      candidates: 2, changed: 1, written: 0, failedVersions: [],
      months: [{ month: '2026-09', rows: 1, people: 1, minutesBefore: 0, minutesAfter: 60 }],
    });
    expect(dry.changes).toEqual([{
      employeeId: 71, fullName: 'Марухина В.С.', month: '2026-09', versionId,
      before: {}, after: { '2026-09-10': 60 }, remoteDates: ['2026-09-10', '2026-09-12'],
    }]);
    expect(dry.samples).toEqual([{
      employeeId: 72, fullName: null, month: '2026-09', versionId, before: {}, after: {}, remoteDates: ['2026-09-01'],
    }]);
    expect(await q('SELECT count(*)::int AS n FROM timesheet_version_payroll_basis')).toEqual([{ n: 2 }]);

    expect((await fixPayrollBasisOvertime({ apply: true, mode: 'remote', rebuild })).written).toBe(1);
    expect(await q(`SELECT employee_id, revision, norm_days, norm_minutes, workday_dates::text[] AS workday_dates,
                           absence_days, overtime_minutes, quality, reason
                      FROM timesheet_version_payroll_basis WHERE employee_id = 71 ORDER BY revision`)).toEqual([
      {
        employee_id: 71, revision: 1, norm_days: 22, norm_minutes: 10560,
        workday_dates: ['2026-09-10', '2026-09-11', '2026-09-14'],
        absence_days: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
        overtime_minutes: {}, quality: 'reconstructed', reason: 'backfill',
      },
      {
        employee_id: 71, revision: 2, norm_days: 22, norm_minutes: 10560,
        workday_dates: ['2026-09-10', '2026-09-11', '2026-09-14'],
        absence_days: { vacation: 0, sick: 0, educational_leave: 0, unpaid: 0 },
        overtime_minutes: { '2026-09-10': 60 }, quality: 'reconstructed', reason: 'backfill',
      },
    ]);
    // Расчёт берёт новую revision.
    expect((await loadMonthBasisSources([71], '2026-09')).get(71)?.[0].overtimeMinutes).toEqual({ '2026-09-10': 60 });

    // Повтор — без эффекта; режим reduce прибавленное не трогает.
    expect(await fixPayrollBasisOvertime({ apply: true, mode: 'remote', rebuild })).toMatchObject({ changed: 0, written: 0 });
    expect(await fixPayrollBasisOvertime({ apply: false, rebuild })).toMatchObject({ changed: 0 });
  });
});
