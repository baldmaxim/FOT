import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';

// Роль «Заместитель» (миграция 292) на настоящем PostgreSQL: инвариант «каждая пара
// (сотрудник, дата) — ровно в одной активной подаче» при отделе роли, ручных deputy,
// корне с подотделами, начальнике выше, снятой галочке правки и переводе. Плюс EXCLUDE
// одной подачи на (отдел, период) и то, что смена роли ничего не пишет.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).
const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));
vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
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
  };
});

// Галочка «Табель → правка» роли «Заместитель»; у «Руководителя» правка есть всегда.
const matrix = vi.hoisted(() => ({ deputyCanEdit: true }));
vi.mock('./access-control.service.js', () => ({
  hasPageEdit: vi.fn(async (roleCode: string) => (roleCode === 'deputy_head' ? matrix.deputyCanEdit : true)),
  roleHasAdminAccess: vi.fn(async () => true),
}));

import { resolveDayOwnership, ownsDay, ownershipKey, enumerateDatesInclusive } from './timesheet-day-ownership.service.js';
import { listDepartmentTimesheetOwners } from './department-managers.service.js';
import { findDeputyTopologyViolations, loadDeputyHeadDepartmentIds } from './deputy-role.service.js';

// Отделы: ROOT → X, W (листья), P → Y, Q → Z.
const ROOT = '00000000-0000-4000-8000-0000000000a0';
const X = '00000000-0000-4000-8000-0000000000a1';
const W = '00000000-0000-4000-8000-0000000000a2';
const P = '00000000-0000-4000-8000-0000000000a3';
const Y = '00000000-0000-4000-8000-0000000000a4';
const Q = '00000000-0000-4000-8000-0000000000a5';
const Z = '00000000-0000-4000-8000-0000000000a6';
const FREE_LEAF = '00000000-0000-4000-8000-0000000000a7';

const ROLE_MANAGER = '00000000-0000-4000-8000-0000000000b1';
const ROLE_DEPUTY = '00000000-0000-4000-8000-0000000000b2';
const ROLE_OFFICE = '00000000-0000-4000-8000-0000000000b3';

// Сотрудники.
const H = 1; // начальник X (full)
const D = 2; // заместитель по роли, свой отдел X, ручной deputy на W
const D2 = 3; // заместитель по роли в корне P (есть подотдел) — отдел не засчитывается
const D3 = 4; // заместитель по роли в Z, выше начальник Q — отдел не засчитывается
const H2 = 5; // начальник Q (full)
const M = 6; // личный руководитель E, E2, F
const E = 10; // сотрудник X
const E2 = 11; // сотрудник W
const F = 12; // сотрудник Y
const G = 13; // сотрудник Z

const FROM = '2026-09-01';
const TO = '2026-09-10';
const DATES = enumerateDatesInclusive(FROM, TO);

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const profileId = (employeeId: number): string => `00000000-0000-4000-8000-${String(employeeId).padStart(12, '0')}`;

const resetSchema = async (): Promise<void> => {
  await pg.pool!.query(`
    CREATE EXTENSION IF NOT EXISTS btree_gist;
    CREATE SCHEMA IF NOT EXISTS app_auth;
    DROP TABLE IF EXISTS timesheet_approvals, employee_assignments, employee_department_access,
      user_profiles, system_roles, employees, org_departments, system_settings, app_auth.users CASCADE;
    CREATE TABLE system_settings (key text PRIMARY KEY, value text NULL);
    CREATE TABLE org_departments (
      id uuid PRIMARY KEY, name text NOT NULL, parent_id uuid NULL, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE employees (
      id integer PRIMARY KEY, full_name text NULL, org_department_id uuid NULL,
      is_archived boolean NOT NULL DEFAULT false, employment_status text NOT NULL DEFAULT 'active'
    );
    CREATE TABLE system_roles (
      id uuid PRIMARY KEY, code text NOT NULL UNIQUE, is_admin boolean NOT NULL DEFAULT false,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE user_profiles (
      id uuid PRIMARY KEY, employee_id integer NULL, system_role_id uuid NULL,
      is_approved boolean NOT NULL DEFAULT true
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
    CREATE TABLE timesheet_approvals (
      id serial PRIMARY KEY, department_id uuid NULL, manager_employee_id integer NULL,
      start_date date NOT NULL, end_date date NOT NULL, status text NOT NULL,
      CONSTRAINT timesheet_approvals_dept_no_overlap EXCLUDE USING gist (
        department_id WITH =, daterange(start_date, end_date, '[]') WITH &&
      ) WHERE (status = ANY (ARRAY['submitted', 'approved', 'returned']) AND department_id IS NOT NULL)
    );
  `);
};

const seed = async (): Promise<void> => {
  await q(`INSERT INTO org_departments (id, name, parent_id) VALUES
    ($1, 'Корень', NULL), ($2, 'Лист X', $1), ($3, 'Лист W', $1), ($4, 'Родитель P', $1),
    ($5, 'Подотдел Y', $4), ($6, 'Родитель Q', $1), ($7, 'Подотдел Z', $6), ($8, 'Свободный лист', $1)`,
  [ROOT, X, W, P, Y, Q, Z, FREE_LEAF]);
  await q(`INSERT INTO system_roles (id, code) VALUES ($1, 'manager'), ($2, 'deputy_head'), ($3, 'office')`,
    [ROLE_MANAGER, ROLE_DEPUTY, ROLE_OFFICE]);
  const employees: Array<[number, string]> = [
    [H, X], [D, X], [D2, P], [D3, Z], [H2, Q], [M, ROOT], [E, X], [E2, W], [F, Y], [G, Z],
  ];
  for (const [id, dept] of employees) {
    await q('INSERT INTO employees (id, full_name, org_department_id) VALUES ($1, $2, $3)', [id, `Сотрудник ${id}`, dept]);
    // Членство Sigur: владельцем оно не делает (source = sigur_sync).
    await q(`INSERT INTO employee_department_access (employee_id, department_id, access_level, source)
             VALUES ($1, $2, 'full', 'sigur_sync')`, [id, dept]);
    await q('INSERT INTO employee_assignments (employee_id, org_department_id, effective_from) VALUES ($1, $2, $3)',
      [id, dept, '2026-01-01']);
  }
  const profiles: Array<[number, string]> = [
    [H, ROLE_MANAGER], [D, ROLE_DEPUTY], [D2, ROLE_DEPUTY], [D3, ROLE_DEPUTY], [H2, ROLE_MANAGER], [M, ROLE_MANAGER],
  ];
  for (const [employeeId, roleId] of profiles) {
    await q('INSERT INTO user_profiles (id, employee_id, system_role_id) VALUES ($1, $2, $3)', [profileId(employeeId), employeeId, roleId]);
    await q('INSERT INTO app_auth.users (id) VALUES ($1)', [profileId(employeeId)]);
  }
  await q(`INSERT INTO employee_department_access (employee_id, department_id, access_level) VALUES
    ($1, $2, 'full'), ($3, $4, 'full'), ($5, $6, 'deputy')`, [H, X, H2, Q, D, W]);
};

/** Подачи периода: отдел (roster — состав) и персональная M. */
interface IApproval { approvalId: number; departmentId: string | null; managerEmployeeId?: number; roster: number[] }

/** Сколько активных подач владеют каждой парой (сотрудник, дата). */
const ownersPerDay = async (approvals: IApproval[]): Promise<Map<string, number>> => {
  const ownership = await resolveDayOwnership(approvals.map(a => ({
    approvalId: a.approvalId,
    departmentId: a.departmentId,
    managerEmployeeId: a.managerEmployeeId ?? null,
    employeeIds: a.roster,
    dates: DATES,
  })), undefined);
  const counts = new Map<string, number>();
  for (const a of approvals) {
    for (const employeeId of a.roster) {
      for (const date of DATES) {
        if (!ownsDay(ownership.get(ownershipKey(a.approvalId, employeeId, date)))) continue;
        const key = `${employeeId}|${date}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }
    }
  }
  return counts;
};

const expectEachDayOwnedOnce = (counts: Map<string, number>, employees: number[]): void => {
  for (const employeeId of employees) {
    for (const date of DATES) {
      expect(counts.get(`${employeeId}|${date}`), `${employeeId} ${date}`).toBe(1);
    }
  }
};

describe.skipIf(!PG_URL)('роль «Заместитель» (292): владение днями на PostgreSQL', () => {
  beforeAll(async () => {
    await resetSchema();
    await seed();
  });

  beforeEach(() => {
    matrix.deputyCanEdit = true;
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('правило А: засчитываются только листы без владельца выше', async () => {
    expect(new Set(await loadDeputyHeadDepartmentIds(D))).toEqual(new Set([X, W]));
    expect(await loadDeputyHeadDepartmentIds(D2)).toEqual([]); // корень с подотделом
    expect(await loadDeputyHeadDepartmentIds(D3)).toEqual([]); // выше начальник Q
    expect(await loadDeputyHeadDepartmentIds(E)).toEqual([]); // не роль
  });

  it('владельцы табеля: роль вместе с начальником, без неё — ни в корне, ни под начальником', async () => {
    const owners = await listDepartmentTimesheetOwners([X, W, P, Y, Z]);
    expect(new Set(owners.get(X))).toEqual(new Set([H, D]));
    expect(owners.get(W)).toEqual([D]);
    expect(owners.get(P)).toBeUndefined();
    expect(owners.get(Y)).toBeUndefined();
    expect(owners.get(Z)).toBeUndefined();
  });

  it('каждая пара (сотрудник, дата) — ровно в одной подаче', async () => {
    const counts = await ownersPerDay([
      { approvalId: 1, departmentId: X, roster: [E] },
      { approvalId: 2, departmentId: W, roster: [E2] },
      { approvalId: 3, departmentId: Q, roster: [G] }, // подача начальника Q забирает подотдел Z
      { approvalId: 4, departmentId: null, managerEmployeeId: M, roster: [E, E2, F] },
    ]);
    expectEachDayOwnedOnce(counts, [E, E2, F, G]);
  });

  it('без «Табель → правка» заместитель не владелец: дни W уходят личной подаче', async () => {
    matrix.deputyCanEdit = false;
    const owners = await listDepartmentTimesheetOwners([X, W]);
    expect(owners.get(X)).toEqual([H]);
    expect(owners.get(W)).toBeUndefined();
    // Подать W без правки заместитель не может (маршрут отдаст 403), подачи W нет.
    const counts = await ownersPerDay([
      { approvalId: 1, departmentId: X, roster: [E] },
      { approvalId: 4, departmentId: null, managerEmployeeId: M, roster: [E, E2, F] },
    ]);
    expectEachDayOwnedOnce(counts, [E, E2, F]);
  });

  it('перевод W → Y внутри периода делит дни без пересечений', async () => {
    await q('UPDATE employee_assignments SET effective_to = $2 WHERE employee_id = $1', [E2, '2026-09-05']);
    await q('INSERT INTO employee_assignments (employee_id, org_department_id, effective_from) VALUES ($1, $2, $3)',
      [E2, Y, '2026-09-06']);
    try {
      const approvals: IApproval[] = [
        { approvalId: 2, departmentId: W, roster: [E2] },
        { approvalId: 4, departmentId: null, managerEmployeeId: M, roster: [E, E2, F] },
      ];
      const counts = await ownersPerDay(approvals);
      expectEachDayOwnedOnce(counts, [E2]);
      const ownership = await resolveDayOwnership(approvals.map(a => ({
        approvalId: a.approvalId, departmentId: a.departmentId, managerEmployeeId: a.managerEmployeeId ?? null,
        employeeIds: a.roster, dates: DATES,
      })), undefined);
      expect(ownsDay(ownership.get(ownershipKey(2, E2, '2026-09-05')))).toBe(true);
      expect(ownsDay(ownership.get(ownershipKey(2, E2, '2026-09-06')))).toBe(false);
      expect(ownsDay(ownership.get(ownershipKey(4, E2, '2026-09-06')))).toBe(true);
    } finally {
      await q('DELETE FROM employee_assignments WHERE employee_id = $1 AND org_department_id = $2', [E2, Y]);
      await q('UPDATE employee_assignments SET effective_to = NULL WHERE employee_id = $1', [E2]);
    }
  });

  it('одна активная подача на (отдел, период): вторая — exclusion_violation', async () => {
    await q(`INSERT INTO timesheet_approvals (department_id, start_date, end_date, status) VALUES ($1, $2, $3, 'submitted')`,
      [X, FROM, TO]);
    await expect(q(`INSERT INTO timesheet_approvals (department_id, start_date, end_date, status) VALUES ($1, $2, $3, 'submitted')`,
      [X, '2026-09-05', '2026-09-15'])).rejects.toMatchObject({ code: '23P01' });
    await q('DELETE FROM timesheet_approvals');
  });

  it('смена роли «Офисный → Заместитель → Офисный» ничего не пишет', async () => {
    const snapshot = async () => q<{ t: string; n: string }>(`
      SELECT 'eda' AS t, count(*)::text AS n FROM employee_department_access
      UNION ALL SELECT 'ea', count(*)::text FROM employee_assignments
      UNION ALL SELECT 'ta', count(*)::text FROM timesheet_approvals`);
    const before = await snapshot();
    await q('UPDATE user_profiles SET system_role_id = $2 WHERE employee_id = $1', [D, ROLE_OFFICE]);
    expect(await loadDeputyHeadDepartmentIds(D)).toEqual([]);
    // Отдел роли (X) пропал; ручное назначение deputy на W работает по-старому (как у
    // Гладкой) — роль ни при чём, владелец тот же.
    const officeOwners = await listDepartmentTimesheetOwners([X, W]);
    expect(officeOwners.get(X)).toEqual([H]);
    expect(officeOwners.get(W)).toEqual([D]);
    await q('UPDATE user_profiles SET system_role_id = $2 WHERE employee_id = $1', [D, ROLE_DEPUTY]);
    expect(new Set(await loadDeputyHeadDepartmentIds(D))).toEqual(new Set([X, W]));
    expect(await snapshot()).toEqual(before);
  });

  it('проверка ручных назначений: подотделы, владелец выше (в т.ч. в этом же сохранении), годный лист', async () => {
    const violations = await findDeputyTopologyViolations({
      employeeId: D, checkDepartmentIds: [P, Z, FREE_LEAF], finalOwnedDepartmentIds: [],
    });
    expect(violations.map(v => [v.department_id, v.reason])).toEqual([[P, 'has_children'], [Z, 'owner_above']]);
    expect(violations.find(v => v.department_id === Z)?.owner_department_name).toBe('Родитель Q');

    const sameSave = await findDeputyTopologyViolations({
      employeeId: D, checkDepartmentIds: [FREE_LEAF], finalOwnedDepartmentIds: [ROOT, FREE_LEAF],
    });
    expect(sameSave.map(v => v.reason)).toEqual(['owner_above']);
  });
});
