import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// «Аналитика подбора» на настоящем PostgreSQL: периоды, фильтры метрик и HAVING живут в SQL,
// мок драйвера показал бы ровно то, что ему подложили. Запускается только при FOT_TEST_PG_URL —
// ПУСТАЯ тестовая БД. Таблицы — в своей схеме hiring_analytics_pg_test (search_path).
// В обычном прогоне пропускается.

const PG_URL = process.env.FOT_TEST_PG_URL;
const SCHEMA = 'hiring_analytics_pg_test';

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL
    ? new Pool({
      connectionString: process.env.FOT_TEST_PG_URL,
      options: '-c search_path=hiring_analytics_pg_test',
      max: 4,
    })
    : null;
  const run = async (sql: string, params?: readonly unknown[]) => {
    if (!pg.pool) throw new Error('FOT_TEST_PG_URL не задан');
    return pg.pool.query(sql, params as unknown[]);
  };
  return {
    query: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows,
    queryOne: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rows[0] ?? null,
    execute: async (sql: string, params?: readonly unknown[]) => (await run(sql, params)).rowCount ?? 0,
    withTransaction: vi.fn(),
  };
});

vi.mock('../services/data-scope.service.js', () => ({ hasDeputyAssignment: vi.fn(async () => false) }));
vi.mock('../services/hiring-access.service.js', () => ({
  isHiringManagerByEmployee: vi.fn(async () => false),
  isRecruiter: vi.fn(async () => false),
  getActiveAssigneeEmployeeIds: vi.fn(async () => []),
  getHiringManagerEmployeeIds: vi.fn(async () => []),
  hasActiveHiringAssignment: vi.fn(async () => false),
  hasHiringAutoAccess: vi.fn(async () => true),
  isHiringRequesterRole: () => false,
  resolveHiringDepartmentSides: vi.fn(async () => ({ head: [], deputy: [] })),
}));
vi.mock('../services/recipients.service.js', () => ({ getUserIdsByEmployeeIds: vi.fn(async () => []), getEmployeeUserId: vi.fn(async () => null) }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { createMany: vi.fn() } }));
vi.mock('../services/push.service.js', () => ({ pushService: { sendGenericNotification: vi.fn() } }));
vi.mock('../services/access-control.service.js', () => ({ hasPageView: vi.fn(async () => false), canManageAsHrAdmin: vi.fn(async () => false) }));
vi.mock('../services/r2.service.js', () => ({ r2Service: {} }));

import { hiringRequestsController as c } from './hiring-requests.controller.js';

const RECRUITER_A = 1;
const RECRUITER_B = 2;

interface IAnalyticsRow {
  employee_id: number;
  total: number;
  in_work: number;
  closed: number;
  avg_headcount: string | null;
  interviews: number;
  avg_close_days: string | null;
  closed_in_time: number;
  closed_with_deadline: number;
  overdue: number;
}

const exec = async (sql: string, params?: unknown[]) => {
  await pg.pool!.query(sql, params);
};

/** Заявка главного ответственного; даты — смещения от NOW() в днях. */
const addRequest = async (
  recruiterId: number,
  o: { stage: string; headcount?: number; createdAgo: number; closedAgo?: number; deadlineIn?: number },
): Promise<number> => {
  const { rows } = await pg.pool!.query<{ id: number }>(
    `INSERT INTO hiring_requests (stage, headcount, created_at, closed_at, deadline)
     VALUES ($1, $2, NOW() - make_interval(days => $3::int),
             CASE WHEN $4::int IS NULL THEN NULL ELSE NOW() - make_interval(days => $4::int) END,
             CASE WHEN $5::int IS NULL THEN NULL ELSE CURRENT_DATE + $5::int END)
     RETURNING id`,
    [o.stage, o.headcount ?? 1, o.createdAgo, o.closedAgo ?? null, o.deadlineIn ?? null],
  );
  const id = rows[0].id;
  await exec(
    `INSERT INTO hiring_request_assignees (request_id, employee_id, is_active, is_primary) VALUES ($1, $2, TRUE, TRUE)`,
    [id, recruiterId],
  );
  return id;
};

const analytics = async (period: 'week' | 'month'): Promise<IAnalyticsRow[]> => {
  const res = { _json: null as unknown } as Response & { _json: unknown };
  res.status = vi.fn(() => res) as unknown as Response['status'];
  res.json = vi.fn((j: unknown) => { res._json = j; return res; }) as unknown as Response['json'];
  const req = { params: {}, query: { period }, body: {}, user: { id: 'u1', employee_id: 99, is_admin: true } } as unknown as AuthenticatedRequest;
  await c.analytics(req, res);
  return (res._json as { data: IAnalyticsRow[] }).data;
};

describe.skipIf(!PG_URL)('аналитика подбора на PostgreSQL', () => {
  beforeAll(async () => {
    await exec(`
      DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE;
      CREATE SCHEMA ${SCHEMA};
      CREATE TABLE ${SCHEMA}.employees (id integer PRIMARY KEY, full_name text);
      CREATE TABLE ${SCHEMA}.hiring_requests (
        id serial PRIMARY KEY, stage text NOT NULL, headcount integer NOT NULL DEFAULT 1,
        deadline date, created_at timestamptz NOT NULL, reactivated_at timestamptz, closed_at timestamptz
      );
      CREATE TABLE ${SCHEMA}.hiring_request_assignees (
        request_id integer NOT NULL, employee_id integer NOT NULL,
        is_active boolean NOT NULL, is_primary boolean NOT NULL
      );
      CREATE TABLE ${SCHEMA}.hiring_candidates (request_id integer NOT NULL, status text NOT NULL);
    `);
    await exec(`INSERT INTO ${SCHEMA}.employees (id, full_name) VALUES ($1, 'Рекрутер А'), ($2, 'Рекрутер Б')`, [RECRUITER_A, RECRUITER_B]);

    // А: две открытые (просроченная и в срок), закрытые 3 и 20 дн. назад, «Доработка» с прошедшим сроком
    const openOverdue = await addRequest(RECRUITER_A, { stage: 'in_progress', headcount: 2, createdAgo: 30, deadlineIn: -5 });
    await addRequest(RECRUITER_A, { stage: 'new', headcount: 1, createdAgo: 2, deadlineIn: 10 });
    await addRequest(RECRUITER_A, { stage: 'closed', headcount: 1, createdAgo: 13, closedAgo: 3, deadlineIn: 5 });
    const closedLate = await addRequest(RECRUITER_A, { stage: 'closed', headcount: 4, createdAgo: 50, closedAgo: 20, deadlineIn: -25 });
    await addRequest(RECRUITER_A, { stage: 'rework', headcount: 9, createdAgo: 40, deadlineIn: -1 });
    await exec(
      `INSERT INTO ${SCHEMA}.hiring_candidates (request_id, status) VALUES ($1, 'interview'), ($1, 'new'), ($2, 'interview')`,
      [openOverdue, closedLate],
    );

    // Б: только закрытая 60 дн. назад — не попадает ни в неделю, ни в месяц
    await addRequest(RECRUITER_B, { stage: 'closed', headcount: 5, createdAgo: 90, closedAgo: 60, deadlineIn: -50 });
  });

  afterAll(async () => {
    if (pg.pool) {
      await pg.pool.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`);
      await pg.pool.end();
    }
  });

  it('месяц: метрики — по заявкам в работе и закрытым за месяц', async () => {
    const rows = await analytics('month');
    expect(rows.map(r => r.employee_id)).toEqual([RECRUITER_A]);
    expect(rows[0]).toMatchObject({
      total: 4,
      in_work: 2,
      closed: 2,
      avg_headcount: '2.0', // (2 + 1 + 1 + 4) / 4 — без «Доработки» и старых закрытых
      avg_close_days: '20.0', // (10 + 30) / 2
      closed_in_time: 1,
      closed_with_deadline: 2,
      interviews: 1, // кандидат закрытой заявки не считается
      overdue: 2, // «Доработка» в просрочке осознанно, хотя её нет в in_work
    });
  });

  it('неделя: закрытые и их метрики — только за 7 дней', async () => {
    const rows = await analytics('week');
    expect(rows.map(r => r.employee_id)).toEqual([RECRUITER_A]);
    expect(rows[0]).toMatchObject({
      total: 3,
      in_work: 2,
      closed: 1,
      avg_headcount: '1.3', // (2 + 1 + 1) / 3
      avg_close_days: '10.0',
      closed_in_time: 1,
      closed_with_deadline: 1,
      interviews: 1,
      overdue: 2,
    });
  });
});
