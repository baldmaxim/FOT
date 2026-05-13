import { execute, query, queryOne } from '../config/postgres.js';

export interface IDirectReportRow {
  id: string;
  subordinate_employee_id: number;
  manager_employee_id: number;
  assigned_at: string;
  assigned_by: string | null;
  unassigned_at: string | null;
  is_active: boolean;
  note: string | null;
}

export interface IDirectReportWithEmployee extends IDirectReportRow {
  subordinate?: {
    id: number;
    full_name: string | null;
    org_department_id: string | null;
    position_id: number | null;
  } | null;
  manager?: {
    id: number;
    full_name: string | null;
    org_department_id: string | null;
    position_id: number | null;
  } | null;
}

let missingTableWarned = false;

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  return code === '42P01';
}

function warnMissingTable(): void {
  if (missingTableWarned) return;
  missingTableWarned = true;
  console.warn(
    '[employee-direct-reports] table public.employee_direct_reports not found; direct supervisor links are disabled.',
  );
}

/**
 * Активные подчинённые (employee_id) для конкретного руководителя.
 */
export async function listDirectSubordinates(managerEmployeeId: number): Promise<number[]> {
  if (!Number.isInteger(managerEmployeeId) || managerEmployeeId <= 0) return [];
  try {
    const rows = await query<{ subordinate_employee_id: number | null }>(
      `SELECT subordinate_employee_id
         FROM employee_direct_reports
        WHERE manager_employee_id = $1 AND is_active = true`,
      [managerEmployeeId],
    );

    return [...new Set(
      rows
        .map(row => row.subordinate_employee_id)
        .filter((id): id is number => Number.isInteger(id)),
    )];
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return [];
    }
    throw err;
  }
}

/**
 * Активный руководитель для подчинённого (или null, если не назначен).
 * Используется в UI для проверки эксклюзивности перед назначением.
 */
export async function getActiveDirectManagerFor(
  subordinateEmployeeId: number,
): Promise<number | null> {
  if (!Number.isInteger(subordinateEmployeeId) || subordinateEmployeeId <= 0) return null;
  try {
    const row = await queryOne<{ manager_employee_id: number | null }>(
      `SELECT manager_employee_id
         FROM employee_direct_reports
        WHERE subordinate_employee_id = $1 AND is_active = true
        LIMIT 1`,
      [subordinateEmployeeId],
    );
    return row?.manager_employee_id ?? null;
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return null;
    }
    throw err;
  }
}

/**
 * Список назначений с раскрытыми employee-полями.
 * Если managerEmployeeId не передан — возвращает все активные связи (для админ-панели).
 */
export async function listDirectReports(
  options: { managerEmployeeId?: number; includeInactive?: boolean } = {},
): Promise<IDirectReportWithEmployee[]> {
  let rows: IDirectReportRow[];
  try {
    const params: unknown[] = [];
    const whereParts: string[] = [];
    if (options.managerEmployeeId != null) {
      params.push(options.managerEmployeeId);
      whereParts.push(`manager_employee_id = $${params.length}`);
    }
    if (!options.includeInactive) {
      whereParts.push('is_active = true');
    }
    const whereSql = whereParts.length > 0 ? `WHERE ${whereParts.join(' AND ')}` : '';
    rows = await query<IDirectReportRow>(
      `SELECT id, subordinate_employee_id, manager_employee_id, assigned_at,
              assigned_by, unassigned_at, is_active, note
         FROM employee_direct_reports
         ${whereSql}
        ORDER BY assigned_at DESC`,
      params,
    );
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return [];
    }
    throw err;
  }

  if (rows.length === 0) return [];

  const employeeIds = [...new Set(rows.flatMap(r => [r.subordinate_employee_id, r.manager_employee_id]))];
  const employees = await query<{
    id: number;
    full_name: string | null;
    org_department_id: string | null;
    position_id: number | null;
  }>(
    `SELECT id, full_name, org_department_id, position_id
       FROM employees
      WHERE id = ANY($1::int[])`,
    [employeeIds],
  );

  const employeeMap = new Map<number, { id: number; full_name: string | null; org_department_id: string | null; position_id: number | null }>(
    employees.map(e => [
      e.id,
      {
        id: e.id,
        full_name: e.full_name ?? null,
        org_department_id: e.org_department_id ?? null,
        position_id: e.position_id ?? null,
      },
    ]),
  );

  return rows.map(row => ({
    ...row,
    subordinate: employeeMap.get(row.subordinate_employee_id) ?? null,
    manager: employeeMap.get(row.manager_employee_id) ?? null,
  }));
}

export interface IAssignDirectReportInput {
  managerEmployeeId: number;
  subordinateEmployeeId: number;
  assignedBy?: string | null;
  note?: string | null;
}

export type AssignDirectReportResult =
  | { ok: true; row: IDirectReportRow }
  | { ok: false; reason: 'already_assigned'; existingManagerEmployeeId: number }
  | { ok: false; reason: 'self_report' }
  | { ok: false; reason: 'employee_not_found' };

export async function assignDirectReport(
  input: IAssignDirectReportInput,
): Promise<AssignDirectReportResult> {
  const managerId = Number(input.managerEmployeeId);
  const subId = Number(input.subordinateEmployeeId);
  if (!Number.isInteger(managerId) || !Number.isInteger(subId) || managerId <= 0 || subId <= 0) {
    return { ok: false, reason: 'employee_not_found' };
  }
  if (managerId === subId) {
    return { ok: false, reason: 'self_report' };
  }

  const employees = await query<{ id: number }>(
    'SELECT id FROM employees WHERE id = ANY($1::int[])',
    [[managerId, subId]],
  );
  if (employees.length < 2) {
    return { ok: false, reason: 'employee_not_found' };
  }

  const existingManager = await getActiveDirectManagerFor(subId);
  if (existingManager != null && existingManager !== managerId) {
    return { ok: false, reason: 'already_assigned', existingManagerEmployeeId: existingManager };
  }
  if (existingManager === managerId) {
    const existingRow = await queryOne<IDirectReportRow>(
      `SELECT id, subordinate_employee_id, manager_employee_id, assigned_at,
              assigned_by, unassigned_at, is_active, note
         FROM employee_direct_reports
        WHERE subordinate_employee_id = $1 AND manager_employee_id = $2 AND is_active = true
        LIMIT 1`,
      [subId, managerId],
    );
    if (existingRow) return { ok: true, row: existingRow };
  }

  const now = new Date().toISOString();
  try {
    const inserted = await queryOne<IDirectReportRow>(
      `INSERT INTO employee_direct_reports
         (subordinate_employee_id, manager_employee_id, assigned_at, assigned_by,
          is_active, note, created_at, updated_at)
       VALUES ($1, $2, $3, $4, true, $5, $3, $3)
       RETURNING id, subordinate_employee_id, manager_employee_id, assigned_at,
                 assigned_by, unassigned_at, is_active, note`,
      [subId, managerId, now, input.assignedBy ?? null, input.note ?? null],
    );

    if (!inserted) {
      throw new Error('Insert returned no row');
    }
    return { ok: true, row: inserted };
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === '23505') {
      const refreshedManager = await getActiveDirectManagerFor(subId);
      return {
        ok: false,
        reason: 'already_assigned',
        existingManagerEmployeeId: refreshedManager ?? -1,
      };
    }
    throw err;
  }
}

export async function unassignDirectReportById(rowId: string): Promise<boolean> {
  if (!rowId) return false;
  const now = new Date().toISOString();
  try {
    const affected = await execute(
      `UPDATE employee_direct_reports
          SET is_active = false, unassigned_at = $1, updated_at = $1
        WHERE id = $2 AND is_active = true`,
      [now, rowId],
    );
    return affected > 0;
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return false;
    }
    throw err;
  }
}

export async function unassignDirectReportByEmployees(
  managerEmployeeId: number,
  subordinateEmployeeId: number,
): Promise<boolean> {
  if (!Number.isInteger(managerEmployeeId) || !Number.isInteger(subordinateEmployeeId)) return false;
  const now = new Date().toISOString();
  try {
    const affected = await execute(
      `UPDATE employee_direct_reports
          SET is_active = false, unassigned_at = $1, updated_at = $1
        WHERE manager_employee_id = $2
          AND subordinate_employee_id = $3
          AND is_active = true`,
      [now, managerEmployeeId, subordinateEmployeeId],
    );
    return affected > 0;
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingTable();
      return false;
    }
    throw err;
  }
}
