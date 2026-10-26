import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Отмена согласованного отпуска (revoke-approval) на настоящем PostgreSQL: статус и след
// отмены, точечное удаление дней табеля по source_id, история, замок закрытого табеля.
// SQL заявления, табеля, истории и замков — настоящий; уведомления, push, realtime и
// право canManageAsHrAdmin — заглушки.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).
const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  // Те же парсеры, что в config/postgres.ts: date и date[] — строками, int8 — числом.
  types.setTypeParser(1082, (val: string) => val);
  type TypeId = Parameters<typeof types.setTypeParser>[0];
  types.setTypeParser(1182 as TypeId, types.getTypeParser(1009 as TypeId));
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

const { hrAdminManageMock } = vi.hoisted(() => ({
  hrAdminManageMock: vi.fn(async (_req: unknown, _page: string) => false),
}));
vi.mock('../services/access-control.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/access-control.service.js')>()),
  canManageAsHrAdmin: hrAdminManageMock,
}));
vi.mock('../services/recipients.service.js', () => ({
  getLeaveRequestRecipients: vi.fn(async () => []),
  getEmployeeUserId: vi.fn(async () => '00000000-0000-4000-8000-000000002071'), // = EMPLOYEE_USER
  resolveRoutedLeaveApprovers: vi.fn(async () => []),
}));
vi.mock('../socket/io-instance.js', () => ({ getIo: vi.fn(() => null) }));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { createMany: vi.fn(async () => undefined) } }));
vi.mock('../services/push.service.js', () => ({
  pushService: { sendGenericNotification: vi.fn(async () => undefined) },
}));

import { leaveRequestsController } from './leave-requests.controller.js';

const DEPT = '00000000-0000-4000-8000-0000000000d1';
const EMPLOYEE = 2071;
const EMPLOYEE_USER = '00000000-0000-4000-8000-000000002071';
const APPROVER = '00000000-0000-4000-8000-0000000000e1'; // руководитель, согласовавший отпуск
const HR_ADMIN = '00000000-0000-4000-8000-0000000000e2'; // кадровый админ, не согласовывал

const VACATION_ID = 11112;
const OTHER_REQUEST_ID = 5983;

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const resetSchema = async (): Promise<void> => {
  await pg.pool!.query(`
    DROP TABLE IF EXISTS leave_request_history, attendance_adjustments, leave_requests,
      timesheet_approval_employees, timesheet_approvals, employee_dismissal_events,
      employee_assignments, user_profiles, employees, org_departments, system_settings CASCADE;
    CREATE TABLE system_settings (key text PRIMARY KEY, value text NULL);
    CREATE TABLE org_departments (
      id uuid PRIMARY KEY, name text NOT NULL, parent_id uuid NULL, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE employees (id integer PRIMARY KEY, full_name text NULL, org_department_id uuid NULL);
    CREATE TABLE user_profiles (id uuid PRIMARY KEY, employee_id integer NULL, full_name text NULL);
    CREATE TABLE employee_assignments (
      id serial PRIMARY KEY, employee_id integer NOT NULL, org_department_id uuid NULL,
      effective_from date NOT NULL, effective_to date NULL
    );
    CREATE TABLE employee_dismissal_events (
      id serial PRIMARY KEY, employee_id integer NOT NULL, from_department_id uuid NULL,
      cancelled boolean NOT NULL DEFAULT false, dismissal_date date NULL
    );
    CREATE TABLE timesheet_approvals (
      id bigserial PRIMARY KEY, department_id uuid NULL, manager_employee_id integer NULL,
      start_date date NOT NULL, end_date date NOT NULL, status text NOT NULL,
      unlocked_at timestamptz NULL
    );
    CREATE TABLE timesheet_approval_employees (
      approval_id bigint NOT NULL REFERENCES timesheet_approvals(id) ON DELETE CASCADE,
      employee_id bigint NOT NULL, full_name text NULL,
      PRIMARY KEY (approval_id, employee_id)
    );
    CREATE TABLE leave_requests (
      id bigint PRIMARY KEY, employee_id integer NOT NULL, request_type text NOT NULL,
      status text NOT NULL, start_date date NOT NULL, end_date date NOT NULL,
      selected_dates date[] NULL, reason text NULL,
      correction_date date NULL, correction_object_id text NULL,
      reviewer_id uuid NULL, reviewed_at timestamptz NULL, review_comment text NULL,
      cancelled_by uuid NULL, cancelled_at timestamptz NULL, cancel_reason text NULL,
      cancel_source text NULL, hr_acknowledged_at timestamptz NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE attendance_adjustments (
      id bigserial PRIMARY KEY, employee_id integer NOT NULL, work_date date NOT NULL,
      status text NOT NULL, source_type text NOT NULL, source_id text NOT NULL,
      approval_status text NOT NULL DEFAULT 'auto_approved',
      UNIQUE (employee_id, work_date, source_type, source_id)
    );
    CREATE TABLE leave_request_history (
      id bigserial PRIMARY KEY, request_id bigint NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
      action text NOT NULL, actor_id uuid NULL, old_value jsonb NULL, new_value jsonb NULL,
      comment text NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
};

/** Согласованный отпуск на 5 дней + его дни в табеле, как после approve. */
const seedVacation = async (from: string, to: string): Promise<string[]> => {
  await q(
    `INSERT INTO leave_requests (id, employee_id, request_type, status, start_date, end_date, reviewer_id, reviewed_at)
     VALUES ($1, $2, 'vacation', 'approved', $3, $4, $5, now())`,
    [VACATION_ID, EMPLOYEE, from, to, APPROVER],
  );
  const days = (await q<{ d: string }>(
    `SELECT d::date::text AS d FROM generate_series($1::date, $2::date, interval '1 day') AS d`,
    [from, to],
  )).map(r => r.d);
  for (const day of days) {
    await q(
      `INSERT INTO attendance_adjustments (employee_id, work_date, status, source_type, source_id)
       VALUES ($1, $2, 'vacation', 'leave_request', $3)`,
      [EMPLOYEE, day, String(VACATION_ID)],
    );
  }
  return days;
};

/** Чужие строки, которые отмена трогать не должна: другое заявление на день отпуска и ручная правка. */
const seedForeignRows = async (sameDay: string, otherDay: string): Promise<void> => {
  await q(
    `INSERT INTO leave_requests (id, employee_id, request_type, status, start_date, end_date, reviewer_id)
     VALUES ($1, $2, 'unpaid', 'approved', $3, $3, $4)`,
    [OTHER_REQUEST_ID, EMPLOYEE, sameDay, APPROVER],
  );
  await q(
    `INSERT INTO attendance_adjustments (employee_id, work_date, status, source_type, source_id) VALUES
       ($1, $2, 'unpaid', 'leave_request', $3),
       ($1, $4, 'work', 'manual', 'manual')`,
    [EMPLOYEE, sameDay, String(OTHER_REQUEST_ID), otherDay],
  );
};

const makeReq = (userId: string, reason?: string) => ({
  params: { id: String(VACATION_ID) },
  body: reason ? { reason } : {},
  user: { id: userId, is_admin: false },
}) as unknown as AuthenticatedRequest;

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as typeof res & Response;
};

const vacationRow = async () => (await q<{
  status: string; cancel_source: string | null; cancelled_by: string | null;
  cancel_reason: string | null; reviewer_id: string | null;
}>(
  `SELECT status, cancel_source, cancelled_by, cancel_reason, reviewer_id FROM leave_requests WHERE id = $1`,
  [VACATION_ID],
))[0];

const adjustmentsOf = async (sourceId: string) => (await q<{ work_date: string }>(
  `SELECT work_date::text AS work_date FROM attendance_adjustments
    WHERE source_type = 'leave_request' AND source_id = $1 ORDER BY work_date`,
  [sourceId],
)).map(r => r.work_date);

const historyOf = async () => q<{ action: string; actor_id: string; comment: string | null }>(
  `SELECT action, actor_id, comment FROM leave_request_history WHERE request_id = $1 ORDER BY id`,
  [VACATION_ID],
);

describe.skipIf(!PG_URL)('revokeApproval — отмена согласованного отпуска (PG)', () => {
  beforeAll(async () => {
    await resetSchema();
  });

  beforeEach(async () => {
    // Фикстуры независимы: каждый сценарий — с чистых таблиц.
    await q(`TRUNCATE leave_request_history, attendance_adjustments, leave_requests,
      timesheet_approval_employees, timesheet_approvals, employee_dismissal_events,
      employee_assignments, user_profiles, employees, org_departments, system_settings CASCADE`);
    await q(`INSERT INTO org_departments (id, name) VALUES ($1, 'ЛИНИЯ')`, [DEPT]);
    await q(`INSERT INTO employees (id, full_name, org_department_id) VALUES ($1, 'Черняк А. А.', $2)`, [EMPLOYEE, DEPT]);
    await q(`INSERT INTO user_profiles (id, employee_id, full_name) VALUES
      ($1, $2, 'Черняк А. А.'), ($3, NULL, 'Кулагин П. А.'), ($4, NULL, 'Кадровый админ')`,
    [EMPLOYEE_USER, EMPLOYEE, APPROVER, HR_ADMIN]);
    hrAdminManageMock.mockReset();
    hrAdminManageMock.mockResolvedValue(false);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('кадровый админ отменяет и прошедший отпуск: удаляются только дни этого заявления', async () => {
    hrAdminManageMock.mockResolvedValue(true);
    const days = await seedVacation('2026-09-01', '2026-09-05');
    await seedForeignRows('2026-09-03', '2026-09-10');
    const res = makeRes();

    await leaveRequestsController.revokeApproval(makeReq(HR_ADMIN, 'согласовано ошибочно'), res);

    expect(res.statusCode).toBe(200);
    expect(hrAdminManageMock).toHaveBeenCalledWith(expect.anything(), '/leave-requests');
    expect(await vacationRow()).toEqual({
      status: 'cancelled',
      cancel_source: 'admin',
      cancelled_by: HR_ADMIN,
      cancel_reason: 'согласовано ошибочно',
      reviewer_id: APPROVER,
    });
    expect(days).toHaveLength(5);
    expect(await adjustmentsOf(String(VACATION_ID))).toEqual([]);
    // Другое заявление на тот же день и ручная правка — на месте.
    expect(await adjustmentsOf(String(OTHER_REQUEST_ID))).toEqual(['2026-09-03']);
    expect(await q(`SELECT 1 FROM attendance_adjustments WHERE source_type = 'manual' AND work_date = '2026-09-10'`))
      .toHaveLength(1);
    expect(await historyOf()).toEqual([{ action: 'revoked', actor_id: HR_ADMIN, comment: 'согласовано ошибочно' }]);
    // Ответ несёт отменившего — по нему карточка подписывает отмену.
    const body = res.body as { data: { status: string; canceller: { full_name: string } | null } };
    expect(body.data.status).toBe('cancelled');
    expect(body.data.canceller?.full_name).toBe('Кадровый админ');
  });

  it('отменяет сам согласовавший (будущий отпуск) → cancel_source=manager', async () => {
    await seedVacation('2099-11-02', '2099-11-06');
    const res = makeRes();

    await leaveRequestsController.revokeApproval(makeReq(APPROVER), res);

    expect(res.statusCode).toBe(200);
    expect(await vacationRow()).toMatchObject({ status: 'cancelled', cancel_source: 'manager', cancelled_by: APPROVER });
    expect(await adjustmentsOf(String(VACATION_ID))).toEqual([]);
  });

  it('дата в утверждённом табеле → 409, данные не меняются', async () => {
    hrAdminManageMock.mockResolvedValue(true);
    const days = await seedVacation('2026-09-01', '2026-09-05');
    const [approval] = await q<{ id: number }>(
      `INSERT INTO timesheet_approvals (department_id, start_date, end_date, status)
       VALUES ($1, '2026-09-01', '2026-09-15', 'approved') RETURNING id`,
      [DEPT],
    );
    await q(`INSERT INTO timesheet_approval_employees (approval_id, employee_id) VALUES ($1, $2)`, [approval.id, EMPLOYEE]);
    const res = makeRes();

    await leaveRequestsController.revokeApproval(makeReq(HR_ADMIN), res);

    expect(res.statusCode).toBe(409);
    expect(await vacationRow()).toMatchObject({ status: 'approved', cancel_source: null, cancelled_by: null });
    expect(await adjustmentsOf(String(VACATION_ID))).toEqual(days);
    expect(await historyOf()).toEqual([]);
  });

  it('повторная отмена → 400, данные не меняются', async () => {
    hrAdminManageMock.mockResolvedValue(true);
    await seedVacation('2026-09-01', '2026-09-05');
    await leaveRequestsController.revokeApproval(makeReq(HR_ADMIN), makeRes());
    const res = makeRes();

    await leaveRequestsController.revokeApproval(makeReq(HR_ADMIN), res);

    expect(res.statusCode).toBe(400);
    expect(await vacationRow()).toMatchObject({ status: 'cancelled', cancelled_by: HR_ADMIN });
    expect(await historyOf()).toHaveLength(1);
  });
});
