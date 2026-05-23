import type { PoolClient } from 'pg';
import { query } from '../config/postgres.js';

export interface IApprovalEmployeeSnapshot {
  employee_id: number;
  full_name: string;
}

/**
 * Пересобирает снимок состава для approval_id: принимает явный список employeeIds,
 * подтягивает full_name из employees, перезаписывает строки в timesheet_approval_employees.
 * Выполняется внутри транзакции (client). Контроллер сам решает, как составить список —
 * для полной подачи это все сотрудники отдела на период, для персональной — только
 * direct reports руководителя.
 */
export async function snapshotApprovalEmployees(
  client: PoolClient,
  approvalId: number,
  employeeIds: number[],
): Promise<number> {
  await client.query('DELETE FROM timesheet_approval_employees WHERE approval_id = $1', [approvalId]);

  if (employeeIds.length === 0) return 0;

  const rows = await client.query<{ id: number; full_name: string }>(
    'SELECT id, full_name FROM employees WHERE id = ANY($1::bigint[])',
    [employeeIds],
  );
  if (rows.rows.length === 0) return 0;

  const ids = rows.rows.map(r => r.id);
  const names = rows.rows.map(r => r.full_name ?? '');

  await client.query(
    `INSERT INTO timesheet_approval_employees (approval_id, employee_id, full_name)
       SELECT $1, emp_id, emp_name
       FROM unnest($2::bigint[], $3::text[]) AS t(emp_id, emp_name)
       ON CONFLICT (approval_id, employee_id) DO UPDATE SET full_name = EXCLUDED.full_name`,
    [approvalId, ids, names],
  );

  return ids.length;
}

/** Читает снимок состава approval_id, отсортированный по ФИО. */
export async function listApprovalEmployees(approvalId: number): Promise<IApprovalEmployeeSnapshot[]> {
  return query<IApprovalEmployeeSnapshot>(
    `SELECT employee_id, full_name
       FROM timesheet_approval_employees
       WHERE approval_id = $1
       ORDER BY full_name ASC, employee_id ASC`,
    [approvalId],
  );
}
