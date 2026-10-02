import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';

// Уволенный не виден в месяце увольнения (с 01.09.2026) на настоящем PostgreSQL: граница
// дат в SQL, видимый ростер подачи и разовая пересборка утверждённых подач без уволенных —
// новая revision, где остальные сотрудники байт в байт. Запускается только при
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

import { firedEligibleSql, firedHiddenSql } from './timesheet-fired-cutoff.service.js';
import { listVisibleApprovalEmployees } from './timesheet-approval-employees-snapshot.service.js';
import { computeContentHash, type ITimesheetVersionPayload } from './timesheet-version.service.js';
import { listFiredRebuildCandidates, rebuildApprovalWithoutFired } from './timesheet-version-fired-rebuild.service.js';

const DEPT = '00000000-0000-0000-0000-00000000aa01';

const q = async <T extends import('pg').QueryResultRow>(sql: string, params?: unknown[]) =>
  (await pg.pool!.query<T>(sql, params)).rows;

const employeeRow = (id: number, name: string, hours: number) => ({
  identity: { employee_id: id, sigur_employee_id: 1000 + id, tab_number: `0${id}`, full_name: name },
  position: 'Монтажник',
  total_hours: hours,
  zero_activity: false,
  days: { '2026-09-02': { status: 'work', hours, corrected: false, hours_overridden: false } },
  object_rows: [],
});
const objectsRow = (id: number, name: string, hours: number) => ({
  employee_id: id, full_name: name, mode: 'skud', total_hours: hours,
  objects: [{ object_id: null, object_key: 'o', object_name: 'ЖК Дом 56', object_address: 'адрес', total_hours: hours, days: { '2026-09-02': hours } }],
});
const managersRow = (id: number, name: string, withManager: boolean) => ({
  employee_id: id, full_name: name, department_id: DEPT, department_name: 'бр.Тестов',
  resolution_basis: 'approval_department', resolution_status: withManager ? 'single' : 'not_configured',
  managers: withManager ? [{ employee_id: 900, full_name: 'Бригадир', employment_status: 'active', is_archived: false, source: 'department_full_access' }] : [],
});

/** Подача с одной редакцией: payload, объекты и руководители по списку сотрудников. */
const seedApproval = async (
  period: { start: string; end: string; status?: string },
  employees: Array<{ id: number; name: string; hours: number }>,
): Promise<number> => {
  const [approval] = await q<{ id: string }>(
    `INSERT INTO timesheet_approvals (department_id, start_date, end_date, status)
     VALUES ($1, $2, $3, $4) RETURNING id`,
    [DEPT, period.start, period.end, period.status ?? 'approved'],
  );
  const approvalId = Number(approval.id);
  for (const employee of employees) {
    await q('INSERT INTO timesheet_approval_employees (approval_id, employee_id, full_name) VALUES ($1, $2, $3)',
      [approvalId, employee.id, employee.name]);
  }
  const payload = {
    approval: {
      id: approvalId,
      scope: { kind: 'department', department_id: DEPT, department_name: 'бр.Тестов', manager_employee_id: null },
      start_date: period.start, end_date: period.end, status: 'approved',
    },
    employees_count: employees.length,
    total_hours: employees.reduce((sum, employee) => sum + employee.hours, 0),
    employees: employees.map(employee => employeeRow(employee.id, employee.name, employee.hours)),
  } as unknown as ITimesheetVersionPayload;
  const windows = Object.fromEntries(employees.map(employee => [String(employee.id), {
    joined_date: null, transferred_out_date: null, joined_via_transfer: false,
  }]));
  const [version] = await q<{ id: string }>(
    `INSERT INTO timesheet_versions (approval_id, revision, content_hash, payload, scope_kind, department_id,
       start_date, end_date, employees_count, total_hours, membership_windows, source)
     VALUES ($1, 1, $2, $3::jsonb, 'department', $4, $5, $6, $7, $8, $9::jsonb, 'approve') RETURNING id`,
    [approvalId, computeContentHash(payload), JSON.stringify(payload), DEPT, period.start, period.end,
      payload.employees_count, payload.total_hours, JSON.stringify(windows)],
  );
  const versionId = Number(version.id);
  await q(
    `INSERT INTO timesheet_version_objects (version_id, objects_content_hash, payload, employees_count, total_hours, config_errors, source)
     VALUES ($1, 'old-objects-hash', $2::jsonb, $3, $4, $5::jsonb, 'materialize')`,
    [versionId, JSON.stringify({ employees: employees.map(employee => objectsRow(employee.id, employee.name, employee.hours)) }),
      employees.length, payload.total_hours,
      JSON.stringify(employees.slice(1, 2).map(employee => ({ employee_id: employee.id, code: 'PINNED_OBJECT_MISSING', message: 'нет объекта' })))],
  );
  await q(
    `INSERT INTO timesheet_version_managers (version_id, managers_content_hash, payload, employees_count, without_manager, snapshot_source, resolved_at)
     VALUES ($1, 'old-managers-hash', $2::jsonb, $3, $4, 'materialize', '2026-09-18T10:00:00Z')`,
    [versionId, JSON.stringify({ employees: employees.map((employee, index) => managersRow(employee.id, employee.name, index !== 1)) }),
      employees.length, employees.length > 1 ? 1 : 0],
  );
  return approvalId;
};

describe.skipIf(!PG_URL)('уволенный не виден в месяце увольнения (PostgreSQL)', () => {
  let approvalA = 0;
  let approvalB = 0;

  beforeAll(async () => {
    await pg.pool!.query(`
      DROP TABLE IF EXISTS timesheet_version_managers, timesheet_version_objects, timesheet_versions,
        timesheet_approval_employees, timesheet_approvals, audit_logs, employees CASCADE;
      CREATE TABLE employees (
        id integer PRIMARY KEY, full_name text, employment_status text NOT NULL DEFAULT 'active',
        dismissal_date date NULL, is_archived boolean NOT NULL DEFAULT false
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
      CREATE TABLE audit_logs (
        id bigserial PRIMARY KEY, user_id uuid NULL, action text NOT NULL, entity_type text NULL,
        entity_id text NULL, details jsonb NULL, ip_address text NULL, user_agent text NULL,
        created_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO employees (id, full_name, employment_status, dismissal_date) VALUES
        (1, 'Иванов', 'active', NULL),
        (2, 'Петров', 'fired', '2026-09-22'),
        (3, 'Сидоров', 'fired', '2026-10-02'),
        (4, 'Козлов', 'fired', '2026-09-05'),
        (5, 'Лебедев', 'active', '2026-09-10'),
        (6, 'Орлов', 'fired', NULL);
    `);
    approvalA = await seedApproval({ start: '2026-09-01', end: '2026-09-15' }, [
      { id: 1, name: 'Иванов', hours: 11 },
      { id: 2, name: 'Петров', hours: 10.5 },
      { id: 3, name: 'Сидоров', hours: 9 },
    ]);
    approvalB = await seedApproval({ start: '2026-09-16', end: '2026-09-30' }, [{ id: 4, name: 'Козлов', hours: 8 }]);
    // Август 1С уже приняла — там уволенные в сентябре свои; поданная, но не утверждённая — не трогаем.
    await seedApproval({ start: '2026-08-16', end: '2026-08-31' }, [{ id: 2, name: 'Петров', hours: 7 }]);
    await seedApproval({ start: '2026-09-01', end: '2026-09-15', status: 'submitted' }, [{ id: 2, name: 'Петров', hours: 7 }]);
  });

  afterAll(async () => {
    await pg.pool?.end();
  });

  it('состав периода: с сентября уволенный в месяце скрыт, уволенный позже — виден; август — как было', async () => {
    const eligible = async (start: string) => (await q<{ id: number }>(
      `SELECT id FROM employees WHERE ${firedEligibleSql(null, '$1')} ORDER BY id`, [start],
    )).map(row => row.id);
    expect(await eligible('2026-09-01')).toEqual([1, 3, 5]);
    expect(await eligible('2026-09-16')).toEqual([1, 3, 5]);
    expect(await eligible('2026-10-01')).toEqual([1, 5]);
    expect(await eligible('2026-08-16')).toEqual([1, 2, 3, 4, 5]);

    const hidden = async (start: string) => (await q<{ id: number }>(
      `SELECT e.id FROM employees e WHERE ${firedHiddenSql('e', '$1')} ORDER BY e.id`, [start],
    )).map(row => row.id);
    expect(await hidden('2026-09-01')).toEqual([2, 4]);
    expect(await hidden('2026-08-16')).toEqual([]);
  });

  it('видимый ростер подачи — без уволенных в месяце периода', async () => {
    const visible = await listVisibleApprovalEmployees({ id: approvalA, start_date: '2026-09-01' });
    expect(visible.map(row => Number(row.employee_id))).toEqual([1, 3]);
  });

  it('кандидаты: утверждённые подачи сентября с уволенными; август и неутверждённые — нет', async () => {
    const candidates = await listFiredRebuildCandidates('2026-09-01');
    expect(candidates.map(candidate => [candidate.approvalId, candidate.fired.map(row => row.employeeId)])).toEqual([
      [approvalA, [2]],
      [approvalB, [4]],
    ]);
    expect(candidates[0].fired[0]).toMatchObject({ fullName: 'Петров', hours: 10.5 });
    expect(await listFiredRebuildCandidates('2026-08-01')).toEqual([]);
  });

  it('пересборка: новая revision без уволенного, остальные байт в байт, итоги и хэши пересчитаны; повтор — no-op', async () => {
    const result = await rebuildApprovalWithoutFired(approvalA);
    expect(result).toEqual({ created: true, revision: 2, removedIds: [2] });

    const versions = await q<{
      id: string; revision: number; source: string; content_hash: string; payload: ITimesheetVersionPayload;
      employees_count: number; total_hours: string; membership_windows: Record<string, unknown>;
    }>(`SELECT id, revision, source, content_hash, payload, employees_count, total_hours, membership_windows
          FROM timesheet_versions WHERE approval_id = $1 ORDER BY revision`, [approvalA]);
    const [oldVersion, newVersion] = versions;
    expect(newVersion).toMatchObject({ revision: 2, source: 'rebuild', employees_count: 2 });
    expect(Number(newVersion.total_hours)).toBe(20);
    expect(newVersion.content_hash).toBe(computeContentHash(newVersion.payload));
    expect(newVersion.content_hash).not.toBe(oldVersion.content_hash);
    expect(newVersion.payload.employees.map(employee => employee.identity.employee_id)).toEqual([1, 3]);
    expect(JSON.stringify(newVersion.payload.employees))
      .toBe(JSON.stringify(oldVersion.payload.employees.filter(employee => employee.identity.employee_id !== 2)));
    expect(Object.keys(newVersion.membership_windows).sort()).toEqual(['1', '3']);

    const [objects] = await q<{ payload: { employees: Array<{ employee_id: number }> }; config_errors: unknown[]; employees_count: number; total_hours: string; objects_content_hash: string }>(
      'SELECT payload, config_errors, employees_count, total_hours, objects_content_hash FROM timesheet_version_objects WHERE version_id = $1',
      [newVersion.id],
    );
    expect(objects.payload.employees.map(employee => employee.employee_id)).toEqual([1, 3]);
    expect(objects.config_errors).toEqual([]);
    expect(objects).toMatchObject({ employees_count: 2 });
    expect(Number(objects.total_hours)).toBe(20);
    expect(objects.objects_content_hash).not.toBe('old-objects-hash');

    const [managers] = await q<{ payload: { employees: Array<{ employee_id: number }> }; employees_count: number; without_manager: number; snapshot_source: string; managers_content_hash: string }>(
      'SELECT payload, employees_count, without_manager, snapshot_source, managers_content_hash FROM timesheet_version_managers WHERE version_id = $1',
      [newVersion.id],
    );
    expect(managers.payload.employees.map(employee => employee.employee_id)).toEqual([1, 3]);
    expect(managers).toMatchObject({ employees_count: 2, without_manager: 0, snapshot_source: 'materialize' });
    expect(managers.managers_content_hash).not.toBe('old-managers-hash');

    expect(await q(`SELECT entity_id, details->'removed_employees' AS removed FROM audit_logs
                     WHERE action = 'TIMESHEET_VERSION_FIRED_REMOVED'`))
      .toEqual([{ entity_id: String(approvalA), removed: [2] }]);

    expect(await rebuildApprovalWithoutFired(approvalA)).toEqual({ created: false, revision: null, removedIds: [] });
    expect((await listFiredRebuildCandidates('2026-09-01')).map(candidate => candidate.approvalId)).toEqual([approvalB]);
  });

  it('уволены все — пустая редакция; открытая подача не трогается', async () => {
    await q('UPDATE timesheet_approvals SET unlocked_at = now() WHERE id = $1', [approvalB]);
    expect(await rebuildApprovalWithoutFired(approvalB)).toEqual({ created: false, revision: null, removedIds: [] });
    await q('UPDATE timesheet_approvals SET unlocked_at = NULL WHERE id = $1', [approvalB]);

    expect(await rebuildApprovalWithoutFired(approvalB)).toEqual({ created: true, revision: 2, removedIds: [4] });
    const [latest] = await q<{ payload: ITimesheetVersionPayload; employees_count: number }>(
      'SELECT payload, employees_count FROM timesheet_versions WHERE approval_id = $1 AND revision = 2', [approvalB],
    );
    expect(latest.employees_count).toBe(0);
    expect(latest.payload.employees).toEqual([]);
  });
});
