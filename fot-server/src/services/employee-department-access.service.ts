import { execute, queryOne } from '../config/postgres.js';

export type EmployeeDepartmentAccessSource =
  | 'manual_admin_ui'
  | 'sigur_sync'
  | 'portal_lifecycle';

const TECHNICAL_SOURCES: EmployeeDepartmentAccessSource[] = ['sigur_sync', 'portal_lifecycle'];

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  return code === '42P01';
}

export async function upsertTechnicalDepartmentAccess(
  employeeId: number,
  currentDepartmentId: string,
  previousDepartmentId: string | null,
  source: 'sigur_sync' | 'portal_lifecycle' = 'sigur_sync',
): Promise<void> {
  if (!employeeId || !currentDepartmentId) return;
  const now = new Date().toISOString();

  try {
    if (previousDepartmentId && previousDepartmentId !== currentDepartmentId) {
      await execute(
        `UPDATE employee_department_access
            SET is_active = false, updated_at = $1
          WHERE employee_id = $2
            AND department_id = $3
            AND source = ANY($4::text[])`,
        [now, employeeId, previousDepartmentId, TECHNICAL_SOURCES],
      );
    }

    const existing = await queryOne<{ source: string; is_active: boolean }>(
      `SELECT source, is_active
         FROM employee_department_access
        WHERE employee_id = $1 AND department_id = $2`,
      [employeeId, currentDepartmentId],
    );

    if (existing) {
      if (!existing.is_active) {
        await execute(
          `UPDATE employee_department_access
              SET is_active = true, updated_at = $1
            WHERE employee_id = $2 AND department_id = $3`,
          [now, employeeId, currentDepartmentId],
        );
      }
      return;
    }

    await execute(
      `INSERT INTO employee_department_access
         (employee_id, department_id, source, is_active, created_at, updated_at)
       VALUES ($1, $2, $3, true, $4, $4)`,
      [employeeId, currentDepartmentId, source, now],
    );
  } catch (err) {
    if (isMissingTableError(err)) {
      return;
    }
    throw err;
  }
}

export async function deactivateAllDepartmentAccessForEmployee(
  employeeId: number,
): Promise<void> {
  if (!employeeId) return;
  const now = new Date().toISOString();
  try {
    await execute(
      `UPDATE employee_department_access
          SET is_active = false, updated_at = $1
        WHERE employee_id = $2 AND is_active = true`,
      [now, employeeId],
    );
  } catch (err) {
    if (isMissingTableError(err)) {
      return;
    }
    throw err;
  }
}

export async function batchUpsertTechnicalDepartmentAccess(
  items: Array<{ employeeId: number; currentDepartmentId: string; previousDepartmentId: string | null }>,
  source: 'sigur_sync' | 'portal_lifecycle' = 'sigur_sync',
): Promise<void> {
  for (const item of items) {
    await upsertTechnicalDepartmentAccess(
      item.employeeId,
      item.currentDepartmentId,
      item.previousDepartmentId,
      source,
    );
  }
}
