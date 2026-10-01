import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { AuthenticatedRequest } from '../types/index.js';

// Авто-persona подача руководителя на настоящем PostgreSQL: полный цикл
// «подача отдела → повтор → отзыв → повтор → переподача» с адресно назначенными
// сотрудниками и кейсом Карасени (persona со строкой руководителя держала замок
// при отозванном отделе). Guard-UPDATE, каскад через user_profiles, снимки, замки —
// настоящий SQL; уведомления, аудит и история — заглушки.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).
const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
vi.mock('../config/postgres.js', async () => {
  const { Pool, types } = await import('pg');
  // Те же парсеры, что в config/postgres.ts: date — строкой, int8 — числом. Иначе
  // submit не узнаёт подачу «за тот же диапазон» и вытесняет её новой строкой.
  types.setTypeParser(1082, (val: string) => val);
  types.setTypeParser(1182, types.getTypeParser(1009));
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

vi.mock('../services/access-control.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/access-control.service.js')>()),
  hasPageEdit: vi.fn(async () => true),
  resolveEffectivePageAccess: vi.fn(async () => false),
}));
vi.mock('../services/data-scope.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/data-scope.service.js')>()),
  resolveTimesheetEditableDepartmentIds: vi.fn(async () => 'all'),
}));

// Состав подачи отдела — по сотрудникам отдела (детали членства здесь не проверяются).
const membersByDept = vi.hoisted(() => new Map<string, number[]>());
vi.mock('../services/timesheet-department-assignments.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-department-assignments.service.js')>()),
  listEmployeeIdsAssignedToDepartmentPeriod: vi.fn(async (deptId: string) => membersByDept.get(deptId) ?? []),
}));
vi.mock('../services/timesheet-approval-correction-validation.service.js', () => ({
  validateCorrectionAttachments: vi.fn(async () => ({ ok: true })),
  listPendingCorrectionDays: vi.fn(async () => []),
}));
vi.mock('../services/correction-restrictions.service.js', () => ({
  loadRoleRestrictions: vi.fn(async () => ({ weekend_memo_required: false })),
}));
vi.mock('../services/timesheet-approval-weekend-check.service.js', async (importActual) => ({
  ...(await importActual<typeof import('../services/timesheet-approval-weekend-check.service.js')>()),
  checkManagerObjWeekendMemoRequirement: vi.fn(async () => ({ required: false, satisfied: true, weekendWorkDates: [] })),
}));
const { eventsMock, auditMock } = vi.hoisted(() => ({
  eventsMock: vi.fn(async () => undefined),
  auditMock: vi.fn(async () => undefined),
}));
vi.mock('../services/timesheet-approval-history.service.js', () => ({
  timesheetApprovalHistoryService: { appendEvent: eventsMock, listByApprovalId: vi.fn(async () => []) },
}));
vi.mock('../services/audit.service.js', () => ({
  auditService: { logFromRequest: auditMock },
  AUDIT_ACTIONS: new Proxy({}, { get: (_target, key) => key }),
}));
vi.mock('../services/timesheet-workflow-recipients.service.js', () => ({
  listTimesheetWorkflowRecipientIds: vi.fn(async () => []),
}));
vi.mock('../services/realtime-broadcast.service.js', () => ({ emitDomainChange: vi.fn() }));
vi.mock('../services/notification.service.js', () => ({ notificationService: { createMany: vi.fn(async () => undefined) } }));
vi.mock('../services/push.service.js', () => ({
  pushService: { sendToUsers: vi.fn(async () => undefined), sendGenericNotification: vi.fn(async () => undefined) },
}));
vi.mock('../middleware/cacheResponse.js', () => ({ invalidateCaches: vi.fn() }));

import { timesheetApprovalController } from './timesheet-approval.controller.js';
import { findApprovalLocksForEmployeeDates } from '../services/timesheet-lock.service.js';
import { splitDirectReportsByCoverage } from '../services/direct-report-coverage.service.js';

const ROOT = '00000000-0000-4000-8000-0000000000a0';
const D = '00000000-0000-4000-8000-0000000000a1'; // добавленный отдел: M — заместитель, сам не числится
const E = '00000000-0000-4000-8000-0000000000a2'; // свой отдел M: M — руководитель (как МТО у Карасени)
const U = '00000000-0000-4000-8000-0000000000a3'; // отдел без владельца табеля (как ЛИНИЯ)
const O = '00000000-0000-4000-8000-0000000000a4'; // отдел с другим руководителем H
const KD = '00000000-0000-4000-8000-0000000000a5'; // добавленный отдел K2
const KU = '00000000-0000-4000-8000-0000000000a6'; // свой отдел K2 без владельца

const ROLE_MANAGER = '00000000-0000-4000-8000-0000000000b1';

const M = 1; // руководитель: deputy D, full E (свой)
const A = 2; // сотрудник D
const B = 3; // лично у M, сидит в U (без владельца)
const C = 4; // лично у M, сидит в O (владелец H)
const H = 5; // руководитель O
const K2 = 6; // руководитель KD, сам в KU без владельца
const A2 = 7; // сотрудник KD

const FROM = '2026-09-01';
const TO = '2026-09-15';
const DAY = '2026-09-10';

const profileId = (employeeId: number): string => `00000000-0000-4000-8000-${String(employeeId).padStart(12, '0')}`;

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const resetSchema = async (): Promise<void> => {
  await pg.pool!.query(`
    CREATE EXTENSION IF NOT EXISTS btree_gist;
    CREATE SCHEMA IF NOT EXISTS app_auth;
    DROP TABLE IF EXISTS timesheet_approval_employees, timesheet_approvals, employee_direct_reports,
      employee_dismissal_events, employee_assignments, employee_department_access, user_profiles,
      system_roles, employees, org_departments, system_settings, app_auth.users CASCADE;
    CREATE TABLE system_settings (key text PRIMARY KEY, value text NULL);
    CREATE TABLE org_departments (
      id uuid PRIMARY KEY, name text NOT NULL, parent_id uuid NULL, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE employees (
      id integer PRIMARY KEY, full_name text NULL, org_department_id uuid NULL,
      is_archived boolean NOT NULL DEFAULT false, employment_status text NOT NULL DEFAULT 'active',
      dismissal_date date NULL, excluded_from_timesheet boolean NOT NULL DEFAULT false,
      excluded_from_timesheet_date date NULL
    );
    CREATE TABLE system_roles (
      id uuid PRIMARY KEY, code text NOT NULL UNIQUE, is_admin boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE user_profiles (
      id uuid PRIMARY KEY, employee_id integer NULL, system_role_id uuid NULL,
      is_approved boolean NOT NULL DEFAULT true, full_name text NULL
    );
    CREATE TABLE app_auth.users (id uuid PRIMARY KEY, is_disabled boolean NOT NULL DEFAULT false);
    CREATE TABLE employee_department_access (
      id serial PRIMARY KEY, employee_id integer NOT NULL, department_id uuid NOT NULL,
      access_level text NOT NULL DEFAULT 'full', source text NOT NULL DEFAULT 'manual_admin_ui',
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE employee_assignments (
      id serial PRIMARY KEY, employee_id integer NOT NULL, org_department_id uuid NULL,
      effective_from date NOT NULL, effective_to date NULL
    );
    CREATE TABLE employee_dismissal_events (
      id serial PRIMARY KEY, employee_id integer NOT NULL, from_department_id uuid NULL,
      cancelled boolean NOT NULL DEFAULT false, dismissal_date date NULL
    );
    CREATE TABLE employee_direct_reports (
      id serial PRIMARY KEY, manager_employee_id integer NOT NULL, subordinate_employee_id integer NOT NULL,
      is_active boolean NOT NULL DEFAULT true, assigned_at timestamptz NOT NULL DEFAULT now(),
      unassigned_at timestamptz NULL
    );
    CREATE TABLE timesheet_approvals (
      id bigserial PRIMARY KEY, department_id uuid NULL, manager_employee_id integer NULL,
      start_date date NOT NULL, end_date date NOT NULL, status text NOT NULL,
      submitted_by uuid NULL, submitted_at timestamptz NULL, reviewed_by uuid NULL, reviewed_at timestamptz NULL,
      review_comment text NULL, unlocked_at timestamptz NULL, unlocked_by uuid NULL, unlock_reason text NULL,
      created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
      CONSTRAINT timesheet_approvals_dept_no_overlap EXCLUDE USING gist (
        department_id WITH =, daterange(start_date, end_date, '[]') WITH &&
      ) WHERE (status = ANY (ARRAY['submitted', 'approved', 'returned']) AND department_id IS NOT NULL),
      CONSTRAINT timesheet_approvals_manager_no_overlap EXCLUDE USING gist (
        manager_employee_id WITH =, daterange(start_date, end_date, '[]') WITH &&
      ) WHERE (status = ANY (ARRAY['submitted', 'approved', 'returned']) AND manager_employee_id IS NOT NULL)
    );
    CREATE TABLE timesheet_approval_employees (
      approval_id bigint NOT NULL REFERENCES timesheet_approvals(id) ON DELETE CASCADE,
      employee_id bigint NOT NULL, full_name text NULL,
      PRIMARY KEY (approval_id, employee_id)
    );
  `);
};

const seed = async (): Promise<void> => {
  await q(`INSERT INTO org_departments (id, name, parent_id) VALUES
    ($1, 'Корень', NULL), ($2, 'Закупка.Про', $1), ($3, 'МТО', $1), ($4, 'ЛИНИЯ', $1), ($5, 'Отдел H', $1),
    ($6, 'Отдел K2', $1), ($7, 'ЛИНИЯ-2', $1)`,
  [ROOT, D, E, U, O, KD, KU]);
  await q(`INSERT INTO system_roles (id, code) VALUES ($1, 'manager')`, [ROLE_MANAGER]);
  const employees: Array<[number, string]> = [[M, E], [A, D], [B, U], [C, O], [H, O], [K2, KU], [A2, KD]];
  for (const [id, dept] of employees) {
    await q('INSERT INTO employees (id, full_name, org_department_id) VALUES ($1, $2, $3)', [id, `Сотрудник ${id}`, dept]);
    await q('INSERT INTO employee_assignments (employee_id, org_department_id, effective_from) VALUES ($1, $2, $3)',
      [id, dept, '2026-01-01']);
  }
  for (const employeeId of [M, H, K2]) {
    await q('INSERT INTO user_profiles (id, employee_id, system_role_id) VALUES ($1, $2, $3)',
      [profileId(employeeId), employeeId, ROLE_MANAGER]);
    await q('INSERT INTO app_auth.users (id) VALUES ($1)', [profileId(employeeId)]);
  }
  await q(`INSERT INTO employee_department_access (employee_id, department_id, access_level) VALUES
    ($1, $2, 'deputy'), ($1, $3, 'full'), ($4, $5, 'full'), ($6, $7, 'full')`, [M, D, E, H, O, K2, KD]);
  await q(`INSERT INTO employee_direct_reports (manager_employee_id, subordinate_employee_id, assigned_at) VALUES
    ($1, $2, '2026-01-01'), ($1, $3, '2026-01-01')`, [M, B, C]);
  membersByDept.set(D, [A]);
  membersByDept.set(E, [M]);
  membersByDept.set(KD, [A2]);
};

const reqFor = (employeeId: number, departmentId: string): AuthenticatedRequest => ({
  params: {},
  query: {},
  body: { department_id: departmentId, start_date: FROM, end_date: TO },
  user: {
    id: profileId(employeeId), employee_id: employeeId, is_admin: false,
    role_code: 'manager', timesheet_show_full_period: true,
  },
} as unknown as AuthenticatedRequest);

const call = async (
  handler: 'submit' | 'recall', employeeId: number, departmentId: string,
): Promise<{ status: number; body: { success: boolean; data?: { id: number | string; status: string } } }> => {
  const out = { status: 200, body: undefined as unknown };
  const res = {
    status: (code: number) => { out.status = code; return res; },
    json: (payload: unknown) => { out.body = payload; return res; },
  };
  await timesheetApprovalController[handler](
    reqFor(employeeId, departmentId),
    res as unknown as Parameters<typeof timesheetApprovalController.submit>[1],
  );
  return out as { status: number; body: { success: boolean; data?: { id: number | string; status: string } } };
};

interface IApprovalState { id: number; status: string; roster: number[] }

const deptApproval = async (departmentId: string): Promise<IApprovalState | null> => approvalState(
  'department_id = $1 AND manager_employee_id IS NULL', [departmentId]);
const personalApproval = async (managerEmployeeId: number): Promise<IApprovalState | null> => approvalState(
  'manager_employee_id = $1', [managerEmployeeId]);

async function approvalState(where: string, params: unknown[]): Promise<IApprovalState | null> {
  const rows = await q<{ id: string; status: string; roster: string[] | null }>(
    `SELECT a.id, a.status,
            (SELECT array_agg(s.employee_id ORDER BY s.employee_id) FROM timesheet_approval_employees s
              WHERE s.approval_id = a.id) AS roster
       FROM timesheet_approvals a
      WHERE ${where} AND a.start_date = '${FROM}' AND a.end_date = '${TO}'`,
    params,
  );
  if (rows.length > 1) throw new Error(`ожидалась одна подача, найдено ${rows.length}`);
  const row = rows[0];
  return row ? { id: Number(row.id), status: row.status, roster: (row.roster ?? []).map(Number) } : null;
}

/** Кому из сотрудников день DAY закрыт поданной/утверждённой подачей. */
const lockedEmployees = async (ids: number[]): Promise<number[]> => {
  const locks = await findApprovalLocksForEmployeeDates(ids.map(employeeId => ({ employeeId, workDate: DAY })));
  return ids.filter(id => locks.has(`${id}|${DAY}`));
};

const dbSnapshot = async () => q(`
  SELECT a.id, a.department_id, a.manager_employee_id, a.status, a.submitted_by, a.unlocked_at,
         (SELECT array_agg(s.employee_id ORDER BY s.employee_id) FROM timesheet_approval_employees s
           WHERE s.approval_id = a.id) AS roster
    FROM timesheet_approvals a ORDER BY a.id`);

describe.skipIf(!PG_URL)('авто-persona подача руководителя: цикл подачи/отзыва на PostgreSQL', () => {
  beforeAll(async () => {
    await resetSchema();
    await seed();
  });

  beforeEach(() => {
    eventsMock.mockClear();
    auditMock.mockClear();
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('право правки лично назначенного C (у его отдела свой руководитель) — не у M', async () => {
    const split = await splitDirectReportsByCoverage([B, C], FROM, TO, undefined, M);
    expect(split.owned).toEqual([B]);
    expect(split.fullyCovered).toEqual([C]);
  });

  it('подача D: в отделе A; в persona только B — без M (свой отдел ведёт сам) и без C', async () => {
    const res = await call('submit', M, D);
    expect(res.status).toBe(200);

    expect(await deptApproval(D)).toMatchObject({ status: 'submitted', roster: [A] });
    expect(await personalApproval(M)).toMatchObject({ status: 'submitted', roster: [B] });
    // Строка M не закрыта ничем: свой отдел E ещё не подан.
    expect(await lockedEmployees([M, A, B, C])).toEqual([A, B]);
  });

  it('повторная подача D: те же id, без новых событий и аудита', async () => {
    const before = await dbSnapshot();
    const res = await call('submit', M, D);
    expect(res.status).toBe(200);
    expect(await dbSnapshot()).toEqual(before);
    expect(eventsMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('отзыв D: отдел и persona — в draft вместе; A и B открыты для правки', async () => {
    const dept = await deptApproval(D);
    const personal = await personalApproval(M);
    const res = await call('recall', M, D);
    expect(res.status).toBe(200);

    expect(await deptApproval(D)).toMatchObject({ id: dept!.id, status: 'draft' });
    expect(await personalApproval(M)).toMatchObject({ id: personal!.id, status: 'draft' });
    expect(await lockedEmployees([M, A, B, C])).toEqual([]);
  });

  it('повторный отзыв: 409, данные не меняются', async () => {
    const before = await dbSnapshot();
    const res = await call('recall', M, D);
    expect(res.status).toBe(409);
    expect(await dbSnapshot()).toEqual(before);
  });

  it('переподача D: те же id, обе submitted, замки вернулись; ещё одна подача — no-op', async () => {
    const deptId = (await deptApproval(D))!.id;
    const personalId = (await personalApproval(M))!.id;

    expect((await call('submit', M, D)).status).toBe(200);
    expect(await deptApproval(D)).toEqual({ id: deptId, status: 'submitted', roster: [A] });
    expect(await personalApproval(M)).toEqual({ id: personalId, status: 'submitted', roster: [B] });
    expect(await lockedEmployees([M, A, B, C])).toEqual([A, B]);

    eventsMock.mockClear();
    auditMock.mockClear();
    const before = await dbSnapshot();
    expect((await call('submit', M, D)).status).toBe(200);
    expect(await dbSnapshot()).toEqual(before);
    expect(eventsMock).not.toHaveBeenCalled();
    expect(auditMock).not.toHaveBeenCalled();
  });

  it('подача своего отдела E: строка M закрыта подачей E, persona по-прежнему без M', async () => {
    expect((await call('submit', M, E)).status).toBe(200);
    const own = await deptApproval(E);
    expect(own).toMatchObject({ status: 'submitted', roster: [M] });
    expect(await personalApproval(M)).toMatchObject({ status: 'submitted', roster: [B] });

    const locks = await findApprovalLocksForEmployeeDates([{ employeeId: M, workDate: DAY }]);
    expect(locks.get(`${M}|${DAY}`)?.id).toBe(own!.id);

    // Отзыв E открывает строку M — persona её не держит.
    expect((await call('recall', M, E)).status).toBe(200);
    expect(await lockedEmployees([M])).toEqual([]);
  });

  it('кейс Карасени: stale persona {M} при отозванном D → подача D уводит её в пустой draft', async () => {
    await q('DELETE FROM timesheet_approvals');
    // Состояние прода до фикса: D отозван, persona со строкой M осталась submitted.
    const [{ id: staleId }] = await q<{ id: string }>(
      `INSERT INTO timesheet_approvals (department_id, manager_employee_id, start_date, end_date, status, submitted_by)
       VALUES (NULL, $1, $2, $3, 'submitted', $4) RETURNING id`, [M, FROM, TO, profileId(M)]);
    await q('INSERT INTO timesheet_approval_employees (approval_id, employee_id) VALUES ($1, $2)', [staleId, M]);
    await q(`INSERT INTO timesheet_approvals (department_id, start_date, end_date, status) VALUES ($1, $2, $3, 'draft')`,
      [D, FROM, TO]);
    // У M нет лично назначенных — как у Карасени.
    await q('UPDATE employee_direct_reports SET unassigned_at = $1, is_active = false WHERE manager_employee_id = $2',
      ['2026-08-01', M]);
    try {
      expect(await lockedEmployees([M])).toEqual([M]);

      expect((await call('submit', M, D)).status).toBe(200);

      expect(await personalApproval(M)).toEqual({ id: Number(staleId), status: 'draft', roster: [] });
      expect(await lockedEmployees([M])).toEqual([]);
      const recalled = (auditMock.mock.calls as unknown as Array<[unknown, unknown, string, {
        entityId: string; details: Record<string, unknown>;
      }]>).find(c => c[3].entityId === String(staleId));
      expect(recalled?.[2]).toBe('TIMESHEET_APPROVAL_RECALLED');
      expect(recalled?.[3].details).toMatchObject({ auto_self_personal: true, from_status: 'submitted' });
    } finally {
      await q('UPDATE employee_direct_reports SET unassigned_at = NULL, is_active = true WHERE manager_employee_id = $1', [M]);
    }
  });

  it('свой отдел без владельца (K2): persona со строкой K2 отзывается вместе с отделом', async () => {
    expect((await call('submit', K2, KD)).status).toBe(200);
    const personal = await personalApproval(K2);
    expect(personal).toMatchObject({ status: 'submitted', roster: [K2] });
    expect(await lockedEmployees([K2, A2])).toEqual([K2, A2]);

    expect((await call('recall', K2, KD)).status).toBe(200);
    expect(await personalApproval(K2)).toMatchObject({ id: personal!.id, status: 'draft' });
    expect(await lockedEmployees([K2, A2])).toEqual([]);

    expect((await call('submit', K2, KD)).status).toBe(200);
    expect(await personalApproval(K2)).toEqual({ id: personal!.id, status: 'submitted', roster: [K2] });
  });

  it('approved persona не трогают ни отзыв отдела, ни сверка', async () => {
    const personal = await personalApproval(K2);
    await q(`UPDATE timesheet_approvals SET status = 'approved' WHERE id = $1`, [personal!.id]);
    try {
      expect((await call('recall', K2, KD)).status).toBe(200);
      expect(await personalApproval(K2)).toEqual({ id: personal!.id, status: 'approved', roster: [K2] });
      expect((await call('submit', K2, KD)).status).toBe(200);
      expect(await personalApproval(K2)).toEqual({ id: personal!.id, status: 'approved', roster: [K2] });
    } finally {
      await q(`UPDATE timesheet_approvals SET status = 'submitted' WHERE id = $1`, [personal!.id]);
    }
  });

  it('сбой каскада откатывает и отзыв отдела', async () => {
    expect((await deptApproval(KD))?.status).toBe('submitted');
    await q('ALTER TABLE user_profiles RENAME TO user_profiles_off');
    try {
      expect((await call('recall', K2, KD)).status).toBe(500);
    } finally {
      await q('ALTER TABLE user_profiles_off RENAME TO user_profiles');
    }
    expect((await deptApproval(KD))?.status).toBe('submitted');
    expect((await personalApproval(K2))?.status).toBe('submitted');
  });
});
