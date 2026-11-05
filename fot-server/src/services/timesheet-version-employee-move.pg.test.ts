import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Перенос сотрудников между редакциями закрытых подач на настоящем PostgreSQL: часы, разбивка
// и основа зарплаты переезжают как есть, остальные — байт в байт, все пары — одна транзакция.
// Запускается только при FOT_TEST_PG_URL — ПУСТАЯ тестовая БД (таблицы-заглушки пересоздаются).

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

const PERIOD = { start: '2026-10-01', end: '2026-10-15' };

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

interface ISeedEmployee { id: number; name: string; hours: number; days?: boolean }
interface IDepts { liniya: string; obsh: string }

let deptCounter = 0;

/** Свои отделы на сценарий: иначе подачи сценариев делили бы замки и владение днём. */
const newDepts = async (): Promise<IDepts> => {
  deptCounter += 1;
  const suffix = String(deptCounter).padStart(4, '0');
  const depts = {
    liniya: `00000000-0000-0000-0000-00000000${suffix}`,
    obsh: `00000000-0000-0000-0000-00000001${suffix}`,
  };
  await q('INSERT INTO org_departments (id, name) VALUES ($1, $2), ($3, $4)',
    [depts.liniya, `ЛИНИЯ ${suffix}`, depts.obsh, `Общестрой ${suffix}`]);
  return depts;
};

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

const seedVersion = async (
  approvalId: number,
  departmentId: string,
  revision: number,
  employees: ISeedEmployee[],
  period = PERIOD,
  withBasis = true,
): Promise<number> => {
  const payload = {
    approval: {
      id: approvalId,
      scope: { kind: 'department', department_id: departmentId, department_name: `отдел ${departmentId.slice(-5)}`, manager_employee_id: null },
      start_date: period.start, end_date: period.end, status: 'approved',
    },
    employees_count: employees.length,
    total_hours: Math.round(employees.reduce((sum, employee) => sum + employee.hours, 0) * 100) / 100,
    employees: employees.map(employeeRow),
  } as unknown as ITimesheetVersionPayload;
  const windows = Object.fromEntries(employees.map(employee => [String(employee.id), {
    joined_date: null, transferred_out_date: null, joined_via_transfer: false,
  }]));
  const [version] = await q<{ id: string }>(
    `INSERT INTO timesheet_versions (approval_id, revision, content_hash, payload, scope_kind, department_id,
       start_date, end_date, employees_count, total_hours, membership_windows, source)
     VALUES ($1, $2, $3, $4::jsonb, 'department', $5, $6, $7, $8, $9, $10::jsonb, 'approve') RETURNING id`,
    [approvalId, revision, computeContentHash(payload), JSON.stringify(payload), departmentId, period.start, period.end,
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
        department_name: 'отдел', resolution_basis: 'approval_department', resolution_status: 'single',
        managers: [{ employee_id: 900, full_name: 'Кривов', employment_status: 'active', is_archived: false, source: 'department_full_access' }],
      })),
    }), employees.length],
  );
  if (withBasis) {
    for (const employee of employees) {
      const hasDays = employee.days !== false;
      await q(
        `INSERT INTO timesheet_version_payroll_basis (version_id, employee_id, month, revision, basis_hash, norm_days, norm_minutes,
           workday_dates, dayoff_dates, absence_days, absence_dates, overtime_minutes, paid_minutes, quality, reason)
         VALUES ($1, $2, '2026-10-01', 1, $3, 24, 10560, $4::jsonb, '[]'::jsonb, '{}'::jsonb, NULL, '{}'::jsonb, $5::jsonb, 'materialized', 'close')`,
        [versionId, employee.id, `hash-${employee.id}-${hasDays ? `real-${revision}` : 'blank'}`,
          JSON.stringify(hasDays ? ['2026-10-05'] : []),
          hasDays ? JSON.stringify({ '2026-10-05': 540 }) : null],
      );
    }
  }
  return versionId;
};

/** Подача отдела с одной редакцией: payload, объекты, руководители, основа зарплаты. */
const seedApproval = async (
  departmentId: string,
  employees: ISeedEmployee[],
  period = PERIOD,
): Promise<{ approvalId: number; versionId: number }> => {
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
  return { approvalId, versionId: await seedVersion(approvalId, departmentId, 1, employees, period) };
};

/** Назначения уже исправлены: сотрудник в ЛИНИИ весь период. */
const assignToLiniya = async (employeeIds: number[], depts: IDepts): Promise<void> => {
  for (const id of employeeIds) {
    await q(`INSERT INTO employee_assignments (employee_id, org_department_id, effective_from) VALUES ($1, $2, '2026-07-01')`, [id, depts.liniya]);
  }
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

const rosterOf = async (approvalId: number) => (await q<{ employee_id: string }>(
  'SELECT employee_id FROM timesheet_approval_employees WHERE approval_id = $1 ORDER BY employee_id', [approvalId],
)).map(row => Number(row.employee_id));

describe.skipIf(!PG_URL)('перенос сотрудника между редакциями закрытых подач (PostgreSQL)', () => {
  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS timesheet_version_payroll_basis, timesheet_1c_exports, timesheet_version_managers,
        timesheet_version_objects, timesheet_versions, timesheet_approval_employees, timesheet_approvals,
        audit_logs, audit_logs_off, employee_assignments, employee_dismissal_events, employees, org_departments, system_settings CASCADE;
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
    `);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  describe('основной сценарий', () => {
    const MOVED = 6550;
    const STAY_OBSH = 11;
    const STAY_LINIYA = 12;
    let depts: IDepts;
    let obsh = { approvalId: 0, versionId: 0 };
    let liniya = { approvalId: 0, versionId: 0 };
    const request = () => ({ fromApprovalId: obsh.approvalId, toApprovalId: liniya.approvalId, employeeIds: [MOVED] });

    beforeAll(async () => {
      depts = await newDepts();
      await q(`INSERT INTO employee_assignments (employee_id, org_department_id, effective_from) VALUES ($1, $2, '2026-05-22')`, [MOVED, depts.obsh]);
      obsh = await seedApproval(depts.obsh, [
        { id: MOVED, name: 'Приставка', hours: 95.67 },
        { id: STAY_OBSH, name: 'Остаётся в Общестрое', hours: 100.11 },
      ]);
      liniya = await seedApproval(depts.liniya, [
        { id: MOVED, name: 'Приставка', hours: 0, days: false },
        { id: STAY_LINIYA, name: 'Остаётся в ЛИНИИ', hours: 80.5 },
      ]);
    });

    it('пока назначения не исправлены — отказ, ничего не записано', async () => {
      await expect(previewEmployeeMove(request())).rejects.toBeInstanceOf(EmployeeMoveRefusedError);
      await expect(moveEmployeesBetweenApprovals([request()])).rejects.toThrow(/назначения не исправлены/);
      expect((await versionsOf(obsh.approvalId)).length).toBe(1);
      expect((await versionsOf(liniya.approvalId)).length).toBe(1);
    });

    it('отчёт после правки назначений: итоги считаются, записи нет', async () => {
      await q(`UPDATE employee_assignments SET effective_to = '2026-06-30' WHERE employee_id = $1`, [MOVED]);
      await assignToLiniya([MOVED], depts);

      const plan = await previewEmployeeMove(request());
      expect(plan.state).toBe('move');
      expect(plan.employees).toEqual([{ employeeId: MOVED, fullName: 'Приставка', hours: 95.67, days: 1 }]);
      expect(plan.from).toMatchObject({ employeesBefore: 2, employeesAfter: 1, hoursBefore: 195.78, hoursAfter: 100.11, revision: 1, versionId: obsh.versionId });
      expect(plan.to).toMatchObject({ employeesBefore: 2, employeesAfter: 2, hoursBefore: 80.5, hoursAfter: 176.17, revision: 1, versionId: liniya.versionId });
      expect((await versionsOf(obsh.approvalId)).length).toBe(1);
    });

    it('непустая строка в цели — отказ: дни не перезаписываются и не задваиваются', async () => {
      const [latest] = await versionsOf(liniya.approvalId);
      const payload = structuredClone(latest.payload);
      const row = payload.employees.find(employee => employee.identity.employee_id === MOVED)!;
      row.days = { '2026-10-06': { status: 'work', hours: 9, corrected: false, hours_overridden: false } };
      await q('UPDATE timesheet_versions SET payload = $2::jsonb WHERE id = $1', [latest.id, JSON.stringify(payload)]);
      await expect(moveEmployeesBetweenApprovals([request()])).rejects.toThrow(/уже есть дни или часы/);
      await q('UPDATE timesheet_versions SET payload = $2::jsonb WHERE id = $1', [latest.id, JSON.stringify(latest.payload)]);
      expect((await versionsOf(liniya.approvalId)).length).toBe(1);
    });

    it('открытая подача — источник или цель — отказ', async () => {
      for (const approvalId of [obsh.approvalId, liniya.approvalId]) {
        await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [approvalId]);
        await expect(moveEmployeesBetweenApprovals([request()])).rejects.toThrow(/не закрыта/);
        await q('UPDATE timesheet_approvals SET unlocked_at = NULL WHERE id = $1', [approvalId]);

        await q(`UPDATE timesheet_approvals SET status = 'returned' WHERE id = $1`, [approvalId]);
        await expect(moveEmployeesBetweenApprovals([request()])).rejects.toThrow(/не закрыта/);
        await q(`UPDATE timesheet_approvals SET status = 'approved' WHERE id = $1`, [approvalId]);
      }
    });

    it('разные периоды — отказ', async () => {
      const other = await seedApproval(depts.liniya, [{ id: MOVED, name: 'Приставка', hours: 0, days: false }], { start: '2026-10-16', end: '2026-10-31' });
      await expect(moveEmployeesBetweenApprovals([{ ...request(), toApprovalId: other.approvalId }])).rejects.toThrow(/разные периоды/);
    });

    it('подтверждение 1С — отказ внутри переноса', async () => {
      await q('INSERT INTO timesheet_1c_exports (version_id, key_id, acked_at) VALUES ($1, 1, now())', [liniya.versionId]);
      await expect(moveEmployeesBetweenApprovals([request()])).rejects.toThrow(/1С уже подтверждала/);
      await q('DELETE FROM timesheet_1c_exports');
    });

    it('нет основы зарплаты у источника — отказ', async () => {
      const backup = await q<{ id: string }>(
        'SELECT id FROM timesheet_version_payroll_basis WHERE version_id = $1 AND employee_id = $2', [obsh.versionId, MOVED],
      );
      await q('UPDATE timesheet_version_payroll_basis SET version_id = -1 WHERE id = $1', [backup[0].id]);
      await expect(moveEmployeesBetweenApprovals([request()])).rejects.toThrow(/нет основы зарплаты/);
      await q('UPDATE timesheet_version_payroll_basis SET version_id = $2 WHERE id = $1', [backup[0].id, obsh.versionId]);
    });

    it('ошибка записи аудита откатывает весь перенос', async () => {
      await q('ALTER TABLE audit_logs RENAME TO audit_logs_off');
      try {
        await expect(moveEmployeesBetweenApprovals([request()])).rejects.toThrow(/audit_logs/);
      } finally {
        await q('ALTER TABLE audit_logs_off RENAME TO audit_logs');
      }
      expect((await versionsOf(obsh.approvalId)).length).toBe(1);
      expect((await versionsOf(liniya.approvalId)).length).toBe(1);
      expect(await rosterOf(obsh.approvalId)).toEqual([STAY_OBSH, MOVED]);
    });

    it('перенос: часы, разбивка и основа в ЛИНИИ, остальные байт в байт, состав источника без него, аудит с версиями', async () => {
      const result = await moveEmployeesBetweenApprovals([request()]);
      expect(result.pairs).toEqual([{
        fromApprovalId: obsh.approvalId, toApprovalId: liniya.approvalId, fromRevision: 2, toRevision: 2, movedIds: [MOVED],
      }]);

      const [oldTarget, newTarget] = await versionsOf(liniya.approvalId);
      const [oldSource, newSource] = await versionsOf(obsh.approvalId);

      expect(newTarget).toMatchObject({ revision: 2, source: 'rebuild', employees_count: 2 });
      expect(Number(newTarget.total_hours)).toBe(176.17);
      expect(newTarget.content_hash).toBe(computeContentHash(newTarget.payload));
      expect(newTarget.content_hash).not.toBe(oldTarget.content_hash);
      expect(newTarget.payload.employees.map(employee => employee.identity.employee_id)).toEqual([MOVED, STAY_LINIYA]);
      expect(JSON.stringify(newTarget.payload.employees[0])).toBe(JSON.stringify(oldSource.payload.employees[0]));
      expect(JSON.stringify(newTarget.payload.employees[1])).toBe(JSON.stringify(oldTarget.payload.employees[1]));
      expect(newTarget.payload.approval.scope.department_id).toBe(depts.liniya);
      expect(newTarget.membership_windows).toEqual(oldTarget.membership_windows);

      expect(newSource).toMatchObject({ revision: 2, source: 'rebuild', employees_count: 1 });
      expect(Number(newSource.total_hours)).toBe(100.11);
      expect(newSource.content_hash).toBe(computeContentHash(newSource.payload));
      expect(JSON.stringify(newSource.payload.employees)).toBe(JSON.stringify([oldSource.payload.employees[1]]));
      expect(Object.keys(newSource.membership_windows)).toEqual([String(STAY_OBSH)]);

      expect(Number(newTarget.total_hours) + Number(newSource.total_hours)).toBeCloseTo(Number(oldTarget.total_hours) + Number(oldSource.total_hours), 2);

      const [targetObjects] = await q<{ payload: { employees: Array<{ employee_id: number; total_hours: number; objects: unknown[] }> }; total_hours: string; objects_content_hash: string }>(
        'SELECT payload, total_hours, objects_content_hash FROM timesheet_version_objects WHERE version_id = $1', [newTarget.id],
      );
      expect(targetObjects.payload.employees.map(employee => [employee.employee_id, employee.total_hours, employee.objects.length]))
        .toEqual([[MOVED, 95.67, 1], [STAY_LINIYA, 80.5, 1]]);
      expect(Number(targetObjects.total_hours)).toBe(176.17);
      expect(targetObjects.objects_content_hash).not.toBe('old-objects-hash');

      const [targetManagers] = await q<{ managers_content_hash: string; snapshot_source: string }>(
        'SELECT managers_content_hash, snapshot_source FROM timesheet_version_managers WHERE version_id = $1', [newTarget.id],
      );
      expect(targetManagers).toMatchObject({ managers_content_hash: `managers-${depts.liniya}`, snapshot_source: 'materialize' });

      const targetBasis = await basisOf(newTarget.id);
      expect(targetBasis.map(row => [row.employee_id, row.basis_hash, row.reason])).toEqual([
        [STAY_LINIYA, `hash-${STAY_LINIYA}-real-1`, 'rebuild'],
        [MOVED, `hash-${MOVED}-real-1`, 'rebuild'],
      ]);
      expect(targetBasis[1]).toMatchObject({ workday_dates: ['2026-10-05'], paid_minutes: { '2026-10-05': 540 } });
      expect((await basisOf(newSource.id)).map(row => [row.employee_id, row.basis_hash])).toEqual([[STAY_OBSH, `hash-${STAY_OBSH}-real-1`]]);
      expect((await basisOf(oldSource.id)).length).toBe(2);
      expect((await basisOf(oldTarget.id)).length).toBe(2);

      expect(await rosterOf(obsh.approvalId)).toEqual([STAY_OBSH]);
      expect(await rosterOf(liniya.approvalId)).toEqual([STAY_LINIYA, MOVED]);

      const audit = await q<{ entity_id: string; details: Record<string, unknown> }>(
        `SELECT entity_id, details FROM audit_logs WHERE action = 'TIMESHEET_VERSION_EMPLOYEES_MOVED' AND entity_id = $1`,
        [String(obsh.approvalId)],
      );
      expect(audit).toEqual([{
        entity_id: String(obsh.approvalId),
        details: {
          run_id: result.runId,
          from_approval_id: obsh.approvalId,
          to_approval_id: liniya.approvalId,
          from_version_before: Number(oldSource.id),
          from_version_after: Number(newSource.id),
          from_revision: 2,
          to_version_before: Number(oldTarget.id),
          to_version_after: Number(newTarget.id),
          to_revision: 2,
          moved_employees: [MOVED],
        },
      }]);
    });

    it('замок дня теперь у подачи ЛИНИИ', async () => {
      const locks = await findApprovalLocksForEmployeeDates([{ employeeId: MOVED, workDate: '2026-10-05' }], pg.pool!);
      expect([...locks.values()].map(lock => lock.id)).toEqual([liniya.approvalId]);
    });

    it('повтор ничего не делает и говорит «уже перенесены»', async () => {
      expect((await moveEmployeesBetweenApprovals([request()])).pairs).toEqual([]);
      expect((await versionsOf(liniya.approvalId)).length).toBe(2);
      expect((await versionsOf(obsh.approvalId)).length).toBe(2);
      const plan = await previewEmployeeMove(request());
      expect(plan.state).toBe('already_moved');
      expect(plan.employees).toEqual([{ employeeId: MOVED, fullName: 'Приставка', hours: 95.67, days: 1 }]);
    });
  });

  it('законная редакция 2 остаётся: скрипт создаёт третью из последней, а не из первой', async () => {
    const depts = await newDepts();
    const id = 7100;
    await assignToLiniya([id], depts);
    const obsh = await seedApproval(depts.obsh, [{ id, name: 'Стеняев', hours: 102.88 }, { id: 7101, name: 'Сосед', hours: 50 }]);
    const liniya = await seedApproval(depts.liniya, [{ id, name: 'Стеняев', hours: 0, days: false }, { id: 7102, name: 'Сосед', hours: 60 }]);
    // Кадры вернули и закрыли обе подачи: у Стеняева стало на 10 ч больше.
    const obshRev2 = await seedVersion(obsh.approvalId, depts.obsh, 2, [{ id, name: 'Стеняев', hours: 112.88 }, { id: 7101, name: 'Сосед', hours: 50 }]);
    const liniyaRev2 = await seedVersion(liniya.approvalId, depts.liniya, 2, [{ id, name: 'Стеняев', hours: 0, days: false }, { id: 7102, name: 'Сосед', hours: 70 }]);

    const result = await moveEmployeesBetweenApprovals([{ fromApprovalId: obsh.approvalId, toApprovalId: liniya.approvalId, employeeIds: [id] }]);
    expect(result.pairs[0]).toMatchObject({ fromRevision: 3, toRevision: 3 });

    const targetVersions = await versionsOf(liniya.approvalId);
    const sourceVersions = await versionsOf(obsh.approvalId);
    expect(targetVersions.map(version => version.revision)).toEqual([1, 2, 3]);
    expect(sourceVersions.map(version => version.revision)).toEqual([1, 2, 3]);
    expect(Number(targetVersions[1].id)).toBe(liniyaRev2);
    expect(Number(sourceVersions[1].id)).toBe(obshRev2);
    // Редакция 2 как была: и строка в цели пустая, и часы в источнике на месте.
    expect(targetVersions[1].payload.employees[0].total_hours).toBe(0);
    expect(sourceVersions[1].payload.employees[0].total_hours).toBe(112.88);
    // Третья собрана из второй: 112,88, а не 102,88 из первой, сосед цели — 70, а не 60.
    expect(targetVersions[2].payload.employees.map(employee => employee.total_hours)).toEqual([112.88, 70]);
    expect(Number(targetVersions[2].total_hours)).toBe(182.88);
    expect(sourceVersions[2].payload.employees.map(employee => employee.identity.employee_id)).toEqual([7101]);
    expect((await basisOf(targetVersions[2].id)).find(row => row.employee_id === id)?.basis_hash).toBe(`hash-${id}-real-2`);
  });

  it('отказ во второй паре откатывает и первую', async () => {
    const depts = await newDepts();
    const [a, b] = [7200, 7201];
    await assignToLiniya([a, b], depts);
    const pair1 = {
      from: await seedApproval(depts.obsh, [{ id: a, name: 'Первый', hours: 10 }]),
      to: await seedApproval(depts.liniya, [{ id: a, name: 'Первый', hours: 0, days: false }]),
    };
    const pair2 = {
      from: await seedApproval(depts.obsh, [{ id: b, name: 'Второй', hours: 20 }], { start: '2026-10-16', end: '2026-10-31' }),
      to: await seedApproval(depts.liniya, [{ id: b, name: 'Второй', hours: 5 }], { start: '2026-10-16', end: '2026-10-31' }),
    };
    const requests = [
      { fromApprovalId: pair1.from.approvalId, toApprovalId: pair1.to.approvalId, employeeIds: [a] },
      { fromApprovalId: pair2.from.approvalId, toApprovalId: pair2.to.approvalId, employeeIds: [b] },
    ];
    await expect(moveEmployeesBetweenApprovals(requests)).rejects.toThrow(/уже есть дни или часы/);
    for (const approvalId of [pair1.from.approvalId, pair1.to.approvalId, pair2.from.approvalId, pair2.to.approvalId]) {
      expect((await versionsOf(approvalId)).length).toBe(1);
    }
    expect(await rosterOf(pair1.from.approvalId)).toEqual([a]);
  });

  it('один из двух сотрудников в источнике — отказ, а не частичный перенос', async () => {
    const depts = await newDepts();
    const [a, b] = [7300, 7301];
    await assignToLiniya([a, b], depts);
    const from = await seedApproval(depts.obsh, [{ id: a, name: 'Первый', hours: 10 }]);
    const to = await seedApproval(depts.liniya, [{ id: a, name: 'Первый', hours: 0, days: false }, { id: b, name: 'Второй', hours: 20 }]);
    const request = { fromApprovalId: from.approvalId, toApprovalId: to.approvalId, employeeIds: [a, b] };
    await expect(previewEmployeeMove(request)).rejects.toThrow(/часть сотрудников/);
    await expect(moveEmployeesBetweenApprovals([request])).rejects.toThrow(/часть сотрудников/);
    expect((await versionsOf(from.approvalId)).length).toBe(1);
  });

  it('есть в редакции источника, но нет в его составе — отказ', async () => {
    const depts = await newDepts();
    const id = 7400;
    await assignToLiniya([id], depts);
    const from = await seedApproval(depts.obsh, [{ id, name: 'Первый', hours: 10 }]);
    const to = await seedApproval(depts.liniya, [{ id, name: 'Первый', hours: 0, days: false }]);
    await q('DELETE FROM timesheet_approval_employees WHERE approval_id = $1', [from.approvalId]);
    await expect(previewEmployeeMove({ fromApprovalId: from.approvalId, toApprovalId: to.approvalId, employeeIds: [id] }))
      .rejects.toThrow(/только в одном из снимков/);
  });

  it('источник пуст, цель корректна — «уже перенесены», без новых редакций', async () => {
    const depts = await newDepts();
    const id = 7500;
    await assignToLiniya([id], depts);
    const from = await seedApproval(depts.obsh, [{ id: 7501, name: 'Сосед', hours: 10 }]);
    const to = await seedApproval(depts.liniya, [{ id, name: 'Пересобран кадрами', hours: 30 }]);
    const request = { fromApprovalId: from.approvalId, toApprovalId: to.approvalId, employeeIds: [id] };
    const plan = await previewEmployeeMove(request);
    expect(plan.state).toBe('already_moved');
    expect(plan.to).toMatchObject({ hoursBefore: 30, hoursAfter: 30 });
    expect((await moveEmployeesBetweenApprovals([request])).pairs).toEqual([]);
    expect((await versionsOf(to.approvalId)).length).toBe(1);
  });

  it('источник пуст, в цели пустая строка или её нет — отказ: часы потеряны', async () => {
    const depts = await newDepts();
    const id = 7600;
    await assignToLiniya([id], depts);
    const from = await seedApproval(depts.obsh, [{ id: 7601, name: 'Сосед', hours: 10 }]);
    const empty = await seedApproval(depts.liniya, [{ id, name: 'Пусто', hours: 0, days: false }]);
    await expect(moveEmployeesBetweenApprovals([{ fromApprovalId: from.approvalId, toApprovalId: empty.approvalId, employeeIds: [id] }]))
      .rejects.toThrow(/нет его дней/);
    const missing = await seedApproval(depts.liniya, [{ id: 7602, name: 'Другой', hours: 5 }]);
    await expect(moveEmployeesBetweenApprovals([{ fromApprovalId: from.approvalId, toApprovalId: missing.approvalId, employeeIds: [id] }]))
      .rejects.toThrow(/нет его дней/);
  });
});
