import type { PoolClient } from 'pg';
import { query } from '../config/postgres.js';
import { listDirectSubordinates } from './employee-direct-reports.service.js';

export interface IApprovalEmployeeSnapshot {
  employee_id: number;
  full_name: string;
}

/**
 * Состав персональной подачи руководителя за период: он сам + его активные прямые
 * подчинённые (employee_direct_reports), за вычетом тех, кто уже покрыт
 * submitted/approved/returned подачей отдела (manager_employee_id IS NULL) за этот же
 * период. Дедуп снимает двойной показ сотрудника в dept-карточке и persona-карточке HR.
 *
 * Возвращает отсортированный массив employee_id (может быть пустым).
 */
export async function resolveManagerPersonalSnapshotIds(
  managerEmployeeId: number,
  startDate: string,
  endDate: string,
): Promise<number[]> {
  const subordinateIds = await listDirectSubordinates(managerEmployeeId);
  const candidateIds = [...new Set([managerEmployeeId, ...subordinateIds])];

  const activeRows = await query<{ id: number }>(
    `SELECT id FROM employees
       WHERE id = ANY($1::int[])
         AND (is_archived IS NULL OR is_archived = false)
         AND (employment_status IS NULL OR employment_status = 'active')`,
    [candidateIds],
  );
  const ids = new Set(activeRows.map(r => Number(r.id)).filter(id => Number.isInteger(id) && id > 0));
  if (ids.size === 0) return [];

  const coveredRows = await query<{ employee_id: number }>(
    `SELECT DISTINCT s.employee_id
       FROM timesheet_approval_employees s
       JOIN timesheet_approvals a ON a.id = s.approval_id
      WHERE a.start_date = $1 AND a.end_date = $2
        AND a.manager_employee_id IS NULL
        AND a.status IN ('submitted','approved','returned')
        AND s.employee_id = ANY($3::int[])`,
    [startDate, endDate, [...ids]],
  );
  for (const r of coveredRows) ids.delete(Number(r.employee_id));

  return [...ids].sort((a, b) => a - b);
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
