import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Перенос сотрудников между редакциями закрытых подач на настоящем PostgreSQL: часы, разбивка
// и основа зарплаты переезжают как есть, остальные — байт в байт. Запускается только при
// FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

const PG_URL = process.env.FOT_TEST_PG_URL;

const pg = vi.hoisted(() => ({ pool: null as import('pg').Pool | null }));

vi.mock('../config/postgres.js', async () => {
  const { Pool } = await import('pg');
  pg.pool = process.env.FOT_TEST_PG_URL ? new Pool({ connectionString: process.env.FOT_TEST_PG_URL, max: 10 }) : null;
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

import { findApprovalLocksForEmployeeDates } from './timesheet-lock.service.js';
import { computeContentHash, type ITimesheetVersionPayload } from './timesheet-version.service.js';
import {
  EmployeeMoveRefusedError,
  moveEmployeesBetweenApprovals,
  previewEmployeeMove,
} from './timesheet-version-employee-move.service.js';

const DEPT_LINIYA = '00000000-0000-0000-0000-00000000aa01';
const DEPT_OBSH = '00000000-0000-0000-0000-00000000aa02';
const MOVED = 6550;
const STAY_OBSH = 11;
const STAY_LINIYA = 12;
const PERIOD = { start: '2026-10-01', end: '2026-10-15' };

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

interface ISeedEmployee { id: number; name: string; hours: number; days?: boolean }

const employeeRow = ({ id, name, hours, days = true }: ISeedEmployee) => ({
  identity: { employee_id: id, sigur_employee_id: 1000 + id, tab_number: `0${id}`, full_name: name },
  position: 'Инженер',
  total_hours: hours,
  zero_activity: !days,
  days: days ? { '2026-10-05': { status: 'work', hours, corrected: false, hours_overridden: false } } : {},
  object_rows: [],
});
const objectsRow = ({ id, name, hours, days = true }: ISeedEmployee) => ({
  employee_id: id, full_name: name, mode: 'object', total_hours: hours,
  objects: days ? [{ object_id: null, object_key: 'o', object_name: 'ЖК', object_address: 'адрес', total_hours: hours, days: { '2026-10-05': hours } }] : [],
});

/** Подача отдела с одной редакцией: payload, объекты, руководители, основа зарплаты. */
const seedApproval = async (departmentId: string, employees: ISeedEmployee[], period = PERIOD): Promise<{ approvalId: number; versionId: number }> => {
  const [approval] = await q<{ id: string }>(
    `INSERT INTO timesheet_approvals (department_id, start_date, end_date, status)
     VALUES ($1, $2, $3, 'approved') RETURNING id`,
    [departmentId, period.start, period.end],
  );
  const approvalId = Number(approval.id);
  for (const employee of employees) {
    await q('INSERT INTO timesheet_approval_employees (approval_id, employee_id, full_name) VALUES ($1, $2, $3)',
      [approvalId, employee.id, employee.name]);
  }
  const payload = {
    approval: {
      id: approvalId,
      scope: { kind: 'department', department_id: departmentId, department_name: departmentId === DEPT_LINIYA ? 'ЛИНИЯ' : 'ЛИНИЯ-Общестрой', manager_employee_id: null },
      start_date: period.start, end_date: period.end, status: 'approved',
    },
    employees_count: employees.length,
    total_hours: employees.reduce((sum, employee) => sum + employee.hours, 0),
    employees: employees.map(employeeRow),
  } as unknown as ITimesheetVersionPayload;
  const windows = Object.fromEntries(employees.map(employee => [String(employee.id), {
    joined_date: departmentId === DEPT_OBSH ? '2026-05-22' : null, transferred_out_date: null, joined_via_transfer: departmentId === DEPT_OBSH,
  }]));
  const [version] = await q<{ id: string }>(
    `INSERT INTO timesheet_versions (approval_id, revision, content_hash, payload, scope_kind, department_id,
       start_date, end_date, employees_count, total_hours, membership_windows, source)
     VALUES ($1, 1, $2, $3::jsonb, 'department', $4, $5, $6, $7, $8, $9::jsonb, 'approve') RETURNING id`,
    [approvalId, computeContentHash(payload), JSON.stringify(payload), departmentId, period.start, period.end,
      payload.employees_count, payload.total_hours, JSON.stringify(windows)],
  );
  const versionId = Number(version.id);
  await q(
    `INSERT INTO timesheet_version_objects (version_id, objects_content_hash, payload, employees_count, total_hours, config_errors, source)
     VALUES ($1, 'old-objects-hash', $2::jsonb, $3, $4, '[]'::jsonb, 'materialize')`,
    [versionId, JSON.stringify({ employees: employees.map(objectsRow) }), employees.length, payload.total_hours],
  );
  await q(
    `INSERT INTO timesheet_version_managers (version_id, managers_content_hash, payload, employees_count, without_manager, snapshot_source, resolved_at)
     VALUES ($1, $2, $3::jsonb, $4, 0, 'materialize', '2026-11-03T10:00:00Z')`,
    [versionId, `managers-${departmentId}`, JSON.stringify({
      employees: employees.map(employee => ({
        employee_id: employee.id, full_name: employee.name, department_id: departmentId,
        department_name: departmentId === DEPT_LINIYA ? 'ЛИНИЯ' : 'ЛИНИЯ-Общестрой',
        resolution_basis: 'approval_department', resolution_status: 'single',
        managers: [{ employee_id: 900, full_name: 'Кривов', employment_status: 'active', is_archived: false, source: 'department_full_access' }],
      })),
    }), employees.length],
  );
  for (const employee of employees) {
    const hasDays = employee.days !== false;
    await q(
      `INSERT INTO timesheet_version_payroll_basis (version_id, employee_id, month, revision, basis_hash, norm_days, norm_minutes,
         workday_dates, dayoff_dates, absence_days, absence_dates, overtime_minutes, paid_minutes, quality, reason)
       VALUES ($1, $2, '2026-10-01', 1, $3, 24, 10560, $4::jsonb, '[]'::jsonb, '{}'::jsonb, NULL, '{}'::jsonb, $5::jsonb, 'materialized', 'close')`,
      [versionId, employee.id, `hash-${employee.id}-${hasDays ? 'real' : 'blank'}`,
        JSON.stringify(hasDays ? ['2026-10-05'] : []),
        hasDays ? JSON.stringify({ '2026-10-05': 540 }) : null],
    );
  }
  return { approvalId, versionId };
};

interface IVersionRow { id: string; revision: number; source: string; content_hash: string; payload: ITimesheetVersionPayload; employees_count: number; total_hours: string; membership_windows: Record<string, unknown> }

const versionsOf = (approvalId: number) => q<IVersionRow>(
  `SELECT id, revision, source, content_hash, payload, employees_count, total_hours, membership_windows
     FROM timesheet_versions WHERE approval_id = $1 ORDER BY revision`,
  [approvalId],
);

const basisOf = (versionId: string | number) => q<{ employee_id: number; basis_hash: string; workday_dates: string[]; paid_minutes: Record<string, number> | null; reason: string }>(
  `SELECT employee_id, basis_hash, workday_dates, paid_minutes, reason
     FROM timesheet_version_payroll_basis WHERE version_id = $1 ORDER BY employee_id`,
  [versionId],
);

describe.skipIf(!PG_URL)('перенос сотрудника между редакциями закрытых подач (PostgreSQL)', () => {
  let obsh = { approvalId: 0, versionId: 0 };
  let liniya = { approvalId: 0, versionId: 0 };
  const request = () => ({ fromApprovalId: obsh.approvalId, toApprovalId: liniya.approvalId, employeeIds: [MOVED] });

  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS timesheet_version_payroll_basis, timesheet_1c_exports, timesheet_version_managers,
        timesheet_version_objects, timesheet_versions, timesheet_approval_employees, timesheet_approvals,
        audit_logs, employee_assignments, employee_dismissal_events, employees, org_departments, system_settings CASCADE;
      CREATE TABLE system_settings (key text PRIMARY KEY, value text);
      CREATE TABLE org_departments (id uuid PRIMARY KEY, parent_id uuid NULL, name text);
      CREATE TABLE employees (
        id integer PRIMARY KEY, full_name text, org_department_id uuid, employment_status text NOT NULL DEFAULT 'active',
        dismissal_date date NULL, is_archived boolean NOT NULL DEFAULT false
      );
      CREATE TABLE employee_dismissal_events (
        employee_id integer, from_department_id uuid, dismissal_date date, cancelled boolean NOT NULL DEFAULT false
      );
      CREATE TABLE employee_assignments (
        id bigserial PRIMARY KEY, employee_id integer NOT NULL, org_department_id uuid,
        effective_from date NOT NULL, effective_to date NULL
      );
      CREATE TABLE timesheet_approvals (
        id bigserial PRIMARY KEY, department_id uuid NULL, manager_employee_id bigint NULL,
        start_date date NOT NULL, end_date date NOT NULL, status text NOT NULL,
        unlocked_at timestamptz NULL, version_dirty_at timestamptz NULL
      );
      CREATE TABLE timesheet_approval_employees (
        approval_id bigint NOT NULL, employee_id bigint NOT NULL, full_name text,
        PRIMARY KEY (approval_id, employee_id)
      );
      CREATE TABLE timesheet_versions (
        id bigserial PRIMARY KEY, approval_id bigint NOT NULL, revision integer NOT NULL, content_hash text NOT NULL,
        payload jsonb NOT NULL, scope_kind text NOT NULL, department_id uuid NULL, manager_employee_id bigint NULL,
        start_date date NOT NULL, end_date date NOT NULL, employees_count integer NOT NULL, total_hours numeric NOT NULL,
        membership_windows jsonb NULL, source text NOT NULL, created_by uuid NULL,
        created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (approval_id, revision)
      );
      CREATE TABLE timesheet_version_objects (
        version_id bigint PRIMARY KEY, objects_content_hash text, payload jsonb, employees_count integer,
        total_hours numeric, config_errors jsonb, source text, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE timesheet_version_managers (
        version_id bigint PRIMARY KEY, managers_content_hash text, payload jsonb, employees_count integer,
        without_manager integer, snapshot_source text, resolved_at timestamptz
      );
      CREATE TABLE timesheet_1c_exports (version_id bigint, key_id bigint, acked_at timestamptz);
      CREATE TABLE timesheet_version_payroll_basis (
        id bigserial PRIMARY KEY, version_id bigint NOT NULL, employee_id integer NOT NULL, month date NOT NULL,
        revision integer NOT NULL, basis_hash text NOT NULL, norm_days integer, norm_minutes integer,
        workday_dates jsonb, dayoff_dates jsonb, absence_days jsonb, absence_dates jsonb, overtime_minutes jsonb,
        paid_minutes jsonb, quality text, reason text, created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (version_id, employee_id, month, revision)
      );
      CREATE TABLE audit_logs (
        id bigserial PRIMARY KEY, user_id uuid NULL, action text NOT NULL, entity_type text NULL,
        entity_id text NULL, details jsonb NULL, ip_address text NULL, user_agent text NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO org_departments (id, name) VALUES
        ('${DEPT_LINIYA}', 'ЛИНИЯ'), ('${DEPT_OBSH}', 'ЛИНИЯ-Общестрой');
      INSERT INTO employees (id, full_name, org_department_id) VALUES
        (${MOVED}, 'Приставка', '${DEPT_LINIYA}'),
        (${STAY_OBSH}, 'Остаётся в Общестрое', '${DEPT_OBSH}'),
        (${STAY_LINIYA}, 'Остаётся в ЛИНИИ', '${DEPT_LINIYA}');
      INSERT INTO employee_assignments (employee_id, org_department_id, effective_from, effective_to) VALUES
        (${MOVED}, '${DEPT_OBSH}', '2026-05-22', NULL);
    `);
    obsh = await seedApproval(DEPT_OBSH, [
      { id: MOVED, name: 'Приставка', hours: 95.67 },
      { id: STAY_OBSH, name: 'Остаётся в Общестрое', hours: 100.11 },
    ]);
    liniya = await seedApproval(DEPT_LINIYA, [
      { id: MOVED, name: 'Приставка', hours: 0, days: false },
      { id: STAY_LINIYA, name: 'Остаётся в ЛИНИИ', hours: 80.5 },
    ]);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('пока назначения не исправлены — отказ, ничего не записано', async () => {
    await expect(previewEmployeeMove(request())).rejects.toBeInstanceOf(EmployeeMoveRefusedError);
    await expect(moveEmployeesBetweenApprovals(request())).rejects.toThrow(/назначения не исправлены/);
    expect((await versionsOf(obsh.approvalId)).length).toBe(1);
    expect((await versionsOf(liniya.approvalId)).length).toBe(1);
  });

  it('отчёт после правки назначений: итоги считаются, записи нет', async () => {
    await q(`UPDATE employee_assignments SET effective_to = '2026-06-30' WHERE employee_id = $1`, [MOVED]);
    await q(`INSERT INTO employee_assignments (employee_id, org_department_id, effective_from) VALUES ($1, $2, '2026-07-01')`, [MOVED, DEPT_LINIYA]);

    const plan = await previewEmployeeMove(request());
    expect(plan.moved).toEqual([{ employeeId: MOVED, fullName: 'Приставка', hours: 95.67, days: 1 }]);
    expect(plan.from).toMatchObject({ employeesBefore: 2, employeesAfter: 1, hoursBefore: 195.78, hoursAfter: 100.11, revision: 1, acks: 0 });
    expect(plan.to).toMatchObject({ employeesBefore: 2, employeesAfter: 2, hoursBefore: 80.5, hoursAfter: 176.17, revision: 1, acks: 0 });
    expect((await versionsOf(obsh.approvalId)).length).toBe(1);
  });

  it('непустая строка в цели — отказ: дни не перезаписываются и не задваиваются', async () => {
    const [latest] = await versionsOf(liniya.approvalId);
    const payload = structuredClone(latest.payload);
    const row = payload.employees.find(employee => employee.identity.employee_id === MOVED)!;
    row.days = { '2026-10-06': { status: 'work', hours: 9, corrected: false, hours_overridden: false } };
    await q('UPDATE timesheet_versions SET payload = $2::jsonb WHERE id = $1', [latest.id, JSON.stringify(payload)]);
    await expect(moveEmployeesBetweenApprovals(request())).rejects.toThrow(/уже есть дни или часы/);
    await q('UPDATE timesheet_versions SET payload = $2::jsonb WHERE id = $1', [latest.id, JSON.stringify(latest.payload)]);
    expect((await versionsOf(liniya.approvalId)).length).toBe(1);
  });

  it('открытая подача и разные периоды — отказ', async () => {
    await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [liniya.approvalId]);
    await expect(moveEmployeesBetweenApprovals(request())).rejects.toThrow(/не закрыта/);
    await q('UPDATE timesheet_approvals SET unlocked_at = NULL WHERE id = $1', [liniya.approvalId]);

    const other = await seedApproval(DEPT_LINIYA, [{ id: MOVED, name: 'Приставка', hours: 0, days: false }], { start: '2026-10-16', end: '2026-10-31' });
    await expect(moveEmployeesBetweenApprovals({ ...request(), toApprovalId: other.approvalId })).rejects.toThrow(/разные периоды/);
  });

  it('нет основы зарплаты у источника — отказ', async () => {
    const backup = await q<{ id: string }>(
      'SELECT id FROM timesheet_version_payroll_basis WHERE version_id = $1 AND employee_id = $2', [obsh.versionId, MOVED],
    );
    await q('UPDATE timesheet_version_payroll_basis SET version_id = -1 WHERE id = $1', [backup[0].id]);
    await expect(moveEmployeesBetweenApprovals(request())).rejects.toThrow(/нет основы зарплаты/);
    await q('UPDATE timesheet_version_payroll_basis SET version_id = $2 WHERE id = $1', [backup[0].id, obsh.versionId]);
  });

  it('перенос: часы, разбивка и основа в ЛИНИИ, остальные байт в байт, состав источника без него', async () => {
    const result = await moveEmployeesBetweenApprovals(request());
    expect(result).toEqual({ created: true, fromRevision: 2, toRevision: 2, movedIds: [MOVED] });

    const [oldTarget, newTarget] = await versionsOf(liniya.approvalId);
    const [oldSource, newSource] = await versionsOf(obsh.approvalId);

    // Цель: строка из источника как есть, сосед и порядок прежние.
    expect(newTarget).toMatchObject({ revision: 2, source: 'rebuild', employees_count: 2 });
    expect(Number(newTarget.total_hours)).toBe(176.17);
    expect(newTarget.content_hash).toBe(computeContentHash(newTarget.payload));
    expect(newTarget.content_hash).not.toBe(oldTarget.content_hash);
    expect(newTarget.payload.employees.map(employee => employee.identity.employee_id)).toEqual([MOVED, STAY_LINIYA]);
    expect(JSON.stringify(newTarget.payload.employees[0])).toBe(JSON.stringify(oldSource.payload.employees[0]));
    expect(JSON.stringify(newTarget.payload.employees[1])).toBe(JSON.stringify(oldTarget.payload.employees[1]));
    expect(newTarget.payload.approval.scope.department_id).toBe(DEPT_LINIYA);
    expect(newTarget.membership_windows).toEqual(oldTarget.membership_windows);

    // Источник: без него, сосед прежний.
    expect(newSource).toMatchObject({ revision: 2, source: 'rebuild', employees_count: 1 });
    expect(Number(newSource.total_hours)).toBe(100.11);
    expect(newSource.content_hash).toBe(computeContentHash(newSource.payload));
    expect(JSON.stringify(newSource.payload.employees)).toBe(JSON.stringify([oldSource.payload.employees[1]]));
    expect(Object.keys(newSource.membership_windows)).toEqual([String(STAY_OBSH)]);

    // Сумма часов двух подач не изменилась.
    expect(Number(newTarget.total_hours) + Number(newSource.total_hours)).toBeCloseTo(Number(oldTarget.total_hours) + Number(oldSource.total_hours), 2);

    const [targetObjects] = await q<{ payload: { employees: Array<{ employee_id: number; total_hours: number; objects: unknown[] }> }; total_hours: string; objects_content_hash: string }>(
      'SELECT payload, total_hours, objects_content_hash FROM timesheet_version_objects WHERE version_id = $1', [newTarget.id],
    );
    expect(targetObjects.payload.employees.map(employee => [employee.employee_id, employee.total_hours, employee.objects.length]))
      .toEqual([[MOVED, 95.67, 1], [STAY_LINIYA, 80.5, 1]]);
    expect(Number(targetObjects.total_hours)).toBe(176.17);
    expect(targetObjects.objects_content_hash).not.toBe('old-objects-hash');

    const [targetManagers] = await q<{ managers_content_hash: string; snapshot_source: string; payload: unknown }>(
      'SELECT managers_content_hash, snapshot_source, payload FROM timesheet_version_managers WHERE version_id = $1', [newTarget.id],
    );
    expect(targetManagers).toMatchObject({ managers_content_hash: `managers-${DEPT_LINIYA}`, snapshot_source: 'materialize' });

    // Основа зарплаты: у него — настоящая из источника, у соседей — их собственная.
    const targetBasis = await basisOf(newTarget.id);
    expect(targetBasis.map(row => [row.employee_id, row.basis_hash, row.reason])).toEqual([
      [STAY_LINIYA, `hash-${STAY_LINIYA}-real`, 'rebuild'],
      [MOVED, `hash-${MOVED}-real`, 'rebuild'],
    ]);
    expect(targetBasis[1]).toMatchObject({ workday_dates: ['2026-10-05'], paid_minutes: { '2026-10-05': 540 } });
    expect((await basisOf(newSource.id)).map(row => [row.employee_id, row.basis_hash])).toEqual([[STAY_OBSH, `hash-${STAY_OBSH}-real`]]);
    // Старые редакции не тронуты.
    expect((await basisOf(oldSource.id)).length).toBe(2);
    expect((await basisOf(oldTarget.id)).length).toBe(2);

    // Состав: из источника убран, в цели остался; соседи на месте.
    const roster = async (approvalId: number) => (await q<{ employee_id: string }>(
      'SELECT employee_id FROM timesheet_approval_employees WHERE approval_id = $1 ORDER BY employee_id', [approvalId],
    )).map(row => Number(row.employee_id));
    expect(await roster(obsh.approvalId)).toEqual([STAY_OBSH]);
    expect(await roster(liniya.approvalId)).toEqual([STAY_LINIYA, MOVED]);

    expect(await q(`SELECT entity_id, details FROM audit_logs WHERE action = 'TIMESHEET_VERSION_EMPLOYEES_MOVED'`)).toEqual([{
      entity_id: String(obsh.approvalId),
      details: { to_approval_id: liniya.approvalId, from_revision: 2, to_revision: 2, moved_employees: [MOVED] },
    }]);
  });

  it('замок дня теперь у подачи ЛИНИИ', async () => {
    const locks = await findApprovalLocksForEmployeeDates([{ employeeId: MOVED, workDate: '2026-10-05' }], pg.pool!);
    expect([...locks.values()].map(lock => lock.id)).toEqual([liniya.approvalId]);
  });

  it('повтор ничего не делает', async () => {
    expect(await moveEmployeesBetweenApprovals(request())).toEqual({ created: false, fromRevision: null, toRevision: null, movedIds: [] });
    expect((await versionsOf(liniya.approvalId)).length).toBe(2);
    expect((await versionsOf(obsh.approvalId)).length).toBe(2);
    expect((await previewEmployeeMove(request())).moved).toEqual([]);
  });
});
