import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Response } from 'express';
import type { AuthenticatedRequest } from '../types/index.js';

// Заявление «Корректировка табеля» и предел графика на настоящем PostgreSQL: отказ при
// согласовании откатывает всё, а правка часов согласованного не считает свою строку.
// SQL заявления, табеля, истории и проверки суммы — настоящий; график дня, маршруты,
// уведомления и realtime — заглушки.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы пересоздаются).
const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
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

vi.mock('../services/correction-restrictions.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/correction-restrictions.service.js')>()),
  resolveCorrectionDayLimits: vi.fn(async () => ({ normHours: 8, capHours: 8, capEnabled: true })),
}));
vi.mock('./timesheet.controller.js', () => ({
  resolveAdjustmentApprovalStatus: vi.fn(async () => 'auto_approved'),
  quotaLockKeys: (employeeId: number, workDate: string) => {
    const [y, m] = workDate.split('-');
    return [employeeId, Number(`${y}${m}`)];
  },
  reapproveEmployeeMonthTail: vi.fn(async () => []),
  reportQuotaTailTransitions: vi.fn(async () => undefined),
}));
vi.mock('../services/data-scope.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/data-scope.service.js')>()),
  resolveAccessibleDepartmentIds: vi.fn(async () => 'all'),
}));
vi.mock('../services/access-control.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/access-control.service.js')>()),
  canManageAsHrAdmin: vi.fn(async () => true),
  resolveEffectivePageAccess: vi.fn(async () => true),
  resolveRolePageAccess: vi.fn(async () => true),
}));
vi.mock('../services/approval-routing.service.js', () => ({
  resolveResponsibleEmployeeIdsByEmployee: vi.fn(async () => new Map()),
  resolveLeaveApproverEmployeeIdsByEmployee: vi.fn(async () => new Map()),
}));
vi.mock('../services/weekend-approval-assignments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/weekend-approval-assignments.service.js')>()),
  resolveResponsibleEmployeeForTarget: vi.fn(async () => null),
}));
vi.mock('../services/recipients.service.js', () => ({
  getLeaveRequestRecipients: vi.fn(async () => []),
  getEmployeeUserId: vi.fn(async () => null),
  resolveRoutedLeaveApprovers: vi.fn(async () => []),
}));
vi.mock('../socket/io-instance.js', () => ({ getIo: vi.fn(() => null) }));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { createMany: vi.fn(async () => undefined) } }));
vi.mock('../services/push.service.js', () => ({
  pushService: { sendGenericNotification: vi.fn(async () => undefined) },
}));

import { leaveRequestsController } from './leave-requests.controller.js';
import { invalidateCorrectionRestrictionsCache } from '../services/correction-restrictions.service.js';

const ROLE = '00000000-0000-4000-8000-0000000000a1';
const APPROVER = '00000000-0000-4000-8000-0000000000e1';
const EMP = 1731;
const REQUEST_ID = 708;
const DATE = '2026-10-05';

const q = async (sql: string, params?: unknown[]) => (await pg.pool!.query(sql, params)).rows;

const makeRes = () => {
  const res = {
    statusCode: 200,
    body: undefined as unknown,
    status(code: number) { this.statusCode = code; return this; },
    json(payload: unknown) { this.body = payload; return this; },
  };
  return res as typeof res & Response;
};

const makeReq = (body: Record<string, unknown> = {}) => ({
  params: { id: String(REQUEST_ID) },
  query: {},
  body,
  headers: { 'user-agent': 'vitest' },
  socket: { remoteAddress: '127.0.0.1' },
  user: { id: APPROVER, system_role_id: ROLE, is_admin: true, employee_id: null, role_code: 'admin' },
}) as unknown as AuthenticatedRequest;

const addObjectRow = async (objectId: string, hours: number) => {
  await q(
    `INSERT INTO attendance_adjustments (employee_id, work_date, status, source_type, source_id, hours_override, approval_status)
     VALUES ($1, $2, 'manual', 'manual_object', $3, $4, 'auto_approved')`,
    [EMP, DATE, objectId, hours],
  );
};

const addRequest = async (status: string, hours: number) => {
  await q(
    `INSERT INTO leave_requests (id, employee_id, request_type, status, start_date, end_date,
       correction_date, correction_status, correction_hours, correction_object_id, correction_object_name, reviewer_id)
     VALUES ($1, $2, 'time_correction', $3, $4, $4, $4, 'work', $5, 'obj-b', 'Объект Б', $6)`,
    [REQUEST_ID, EMP, status, DATE, hours, status === 'approved' ? APPROVER : null],
  );
};

const requestRow = async () => (await q(`SELECT status, correction_hours FROM leave_requests WHERE id = $1`, [REQUEST_ID]))[0];
const objectRows = async () => q(
  `SELECT source_id, hours_override FROM attendance_adjustments
    WHERE employee_id = $1 AND source_type = 'manual_object' ORDER BY source_id`,
  [EMP],
);

describe.skipIf(!PG_URL)('заявление «Корректировка табеля»: предел графика (PG)', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS leave_request_history, attendance_adjustments, leave_requests,
        timesheet_approval_employees, timesheet_approvals, employee_dismissal_events, employee_assignments,
        user_profiles, employees, org_departments, system_settings, system_roles, audit_logs CASCADE;
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
        start_date date NOT NULL, end_date date NOT NULL, status text NOT NULL, unlocked_at timestamptz NULL
      );
      CREATE TABLE timesheet_approval_employees (
        approval_id bigint NOT NULL REFERENCES timesheet_approvals(id) ON DELETE CASCADE,
        employee_id bigint NOT NULL, full_name text NULL,
        PRIMARY KEY (approval_id, employee_id)
      );
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
      CREATE TABLE leave_requests (
        id bigint PRIMARY KEY, employee_id integer NOT NULL, request_type text NOT NULL,
        status text NOT NULL, start_date date NOT NULL, end_date date NOT NULL,
        selected_dates date[] NULL, reason text NULL,
        correction_date date NULL, correction_status text NULL, correction_hours numeric(5,2) NULL,
        correction_object_id text NULL, correction_object_name text NULL,
        reviewer_id uuid NULL, reviewed_at timestamptz NULL, review_comment text NULL,
        updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE attendance_adjustments (
        id bigserial PRIMARY KEY, employee_id integer NOT NULL, work_date date NOT NULL,
        status text NOT NULL, source_type text NOT NULL, source_id text NOT NULL,
        hours_override numeric(5,2) NULL, approval_status text NOT NULL DEFAULT 'auto_approved',
        approved_by uuid NULL, approved_at timestamptz NULL, reason text NULL, created_by uuid NULL, updated_by uuid NULL, approval_comment text NULL, approval_request_id bigint NULL,
        metadata jsonb NOT NULL DEFAULT '{}',
        created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (employee_id, work_date, source_type, source_id)
      );
      CREATE TABLE leave_request_history (
        id bigserial PRIMARY KEY, request_id bigint NOT NULL REFERENCES leave_requests(id) ON DELETE CASCADE,
        action text NOT NULL, actor_id uuid NULL, old_value jsonb NULL, new_value jsonb NULL,
        comment text NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE audit_logs (
        id bigserial PRIMARY KEY, user_id uuid NULL, action text NULL, entity_type text NULL, entity_id text NULL,
        details jsonb NULL, ip_address text NULL, user_agent text NULL, created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
    await q(`INSERT INTO system_roles (id, corrections_cap_by_schedule_norm) VALUES ($1, true)`, [ROLE]);
  });

  beforeEach(async () => {
    invalidateCorrectionRestrictionsCache();
    await q(`TRUNCATE leave_request_history, attendance_adjustments, leave_requests, employees, user_profiles, audit_logs CASCADE`);
    await q(`INSERT INTO employees (id, full_name) VALUES ($1, 'Талбаков И. Р.')`, [EMP]);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('6 ч на объекте А + заявление 6 ч на объект Б при графике 8: отказ, заявление на согласовании, табель цел', async () => {
    await addObjectRow('obj-a', 6);
    await addRequest('pending', 6);
    const res = makeRes();

    await leaveRequestsController.approve(makeReq(), res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ success: false, code: 'hours_exceed_schedule' });
    expect(await requestRow()).toMatchObject({ status: 'pending' });
    expect(await objectRows()).toEqual([{ source_id: 'obj-a', hours_override: '6.00' }]);
    expect(await q(`SELECT id FROM leave_request_history`)).toHaveLength(0);
  });

  it('согласующий снижает часы до 2 — согласование проходит, в табеле сумма по графику', async () => {
    await addObjectRow('obj-a', 6);
    await addRequest('pending', 6);

    const edit = makeRes();
    await leaveRequestsController.updateCorrectionHours(makeReq({ hours: 2 }), edit);
    expect(edit.statusCode).toBe(200);

    const approve = makeRes();
    await leaveRequestsController.approve(makeReq(), approve);

    expect(approve.statusCode).toBe(200);
    expect(await requestRow()).toMatchObject({ status: 'approved' });
    expect(await objectRows()).toEqual([
      { source_id: 'obj-a', hours_override: '6.00' },
      { source_id: 'obj-b', hours_override: '2.00' },
    ]);
  });

  it('правка часов на согласовании сверх графика: 422, часы заявления не меняются', async () => {
    await addObjectRow('obj-a', 6);
    await addRequest('pending', 2);
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeReq({ hours: 3 }), res);

    expect(res.statusCode).toBe(422);
    expect(res.body).toMatchObject({ code: 'hours_exceed_norm' });
    expect(await requestRow()).toMatchObject({ correction_hours: '2.00' });
  });

  it('правка часов согласованного: своя строка не считается, 8 → 7 проходит и переписывает табель', async () => {
    await addRequest('approved', 8);
    await addObjectRow('obj-b', 8);
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeReq({ hours: 7 }), res);

    expect(res.statusCode).toBe(200);
    expect(await objectRows()).toEqual([{ source_id: 'obj-b', hours_override: '7.00' }]);
  });

  it('правка согласованного сверх графика с учётом другого объекта: 422, табель не меняется', async () => {
    await addObjectRow('obj-a', 6);
    await addRequest('approved', 2);
    await addObjectRow('obj-b', 2);
    const res = makeRes();

    await leaveRequestsController.updateCorrectionHours(makeReq({ hours: 3 }), res);

    expect(res.statusCode).toBe(422);
    expect(await objectRows()).toEqual([
      { source_id: 'obj-a', hours_override: '6.00' },
      { source_id: 'obj-b', hours_override: '2.00' },
    ]);
    expect(await requestRow()).toMatchObject({ correction_hours: '2.00' });
  });
});
