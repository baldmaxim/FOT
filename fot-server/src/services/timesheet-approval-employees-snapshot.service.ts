import type { PoolClient } from 'pg';
import { query, type DbExecutor } from '../config/postgres.js';
import { listDirectReportIdsInPeriod } from './employee-direct-reports.service.js';
import { splitDirectReportsByCoverage } from './direct-report-coverage.service.js';

export interface IApprovalEmployeeSnapshot {
  employee_id: number;
  full_name: string;
}

/**
 * Канонический состав персональной подачи руководителя за период.
 *
 * Единственный алгоритм для обоих путей: прямой `personal: true` в submit и
 * авто-persona после подачи отдела (ensureManagerSelfApprovalForRange). Раньше их
 * было два и они расходились дедупликацией — снимок зависел от того, каким путём
 * подача создана.
 *
 * Состав = сам руководитель + прямые подчинённые ЗА ПЕРИОД, минус:
 *  - те, у кого весь период есть действующий руководитель отдела (их ведёт отдел);
 *    частично покрытые остаются — их покрытые дни отсекает resolveDayOwnership,
 *    иначе при переводе внутри полупериода дни остались бы без владельца;
 *  - те, кто уже попал в ПЕРЕСЕКАЮЩУЮСЯ подачу отдела (наследование скоупа: подача
 *    родительского отдела забирает и потомков, покрытие такое наследование не знает).
 *
 * Сам руководитель правилу покрытия не подчиняется: его собственную строку ведёт
 * персональная подача, иначе руководитель, сидящий в отделе с руководителем, терял
 * бы себя.
 *
 * Пересечение диапазонов (а не точное совпадение дат) зеркалит EXCLUDE-констрейнты
 * миграции 122 и сам submit.
 */
export async function resolvePersonalSubmissionComposition(
  managerEmployeeId: number,
  startDate: string,
  endDate: string,
): Promise<{ employeeIds: number[]; affectedDepartmentIds: string[]; hasDirectReports: boolean }> {
  const subordinateIds = await listDirectReportIdsInPeriod(managerEmployeeId, startDate, endDate);
  const hasDirectReports = subordinateIds.length > 0;

  const split = await splitDirectReportsByCoverage(subordinateIds, startDate, endDate);
  const candidateIds = [...new Set([
    managerEmployeeId,
    ...split.owned,
    ...split.partiallyCovered,
  ])];

  // Eligibility — та же, что у состава подачи отдела: уволенный внутри периода
  // выгружается за отработанную часть, а не пропадает.
  const rows = await query<{ id: number; org_department_id: string | null }>(
    `SELECT id, org_department_id
       FROM employees
      WHERE id = ANY($1::int[])
        AND is_archived = false
        AND (employment_status = 'active'
             OR (employment_status = 'fired'
                 AND dismissal_date IS NOT NULL
                 AND dismissal_date >= $2::date))
        AND NOT (excluded_from_timesheet = true
                 AND (excluded_from_timesheet_date IS NULL
                      OR excluded_from_timesheet_date <= $2::date))`,
    [candidateIds, startDate],
  );

  const ids = new Set(rows.map(r => Number(r.id)).filter(id => Number.isInteger(id) && id > 0));
  if (ids.size === 0) return { employeeIds: [], affectedDepartmentIds: [], hasDirectReports };

  const coveredRows = await query<{ employee_id: number }>(
    `SELECT DISTINCT s.employee_id
       FROM timesheet_approval_employees s
       JOIN timesheet_approvals a ON a.id = s.approval_id
      WHERE a.manager_employee_id IS NULL
        AND a.status IN ('submitted','approved','returned')
        AND daterange(a.start_date, a.end_date, '[]') && daterange($1::date, $2::date, '[]')
        AND s.employee_id = ANY($3::int[])`,
    [startDate, endDate, [...ids]],
  );
  // Вычитаем и самого руководителя: если он уже поехал в подаче своего отдела,
  // persona-подача из одной его строки не нужна — пустой состав означает «подачи нет».
  for (const row of coveredRows) ids.delete(Number(row.employee_id));

  const employeeIds = [...ids].sort((a, b) => a - b);
  const affectedDepartmentIds = [...new Set(
    rows
      .filter(r => ids.has(Number(r.id)))
      .map(r => r.org_department_id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )];

  return { employeeIds, affectedDepartmentIds, hasDirectReports };
}

/**
 * Состав персональной подачи как плоский список id — обёртка для мест, где отделы
 * не нужны (авто-persona после подачи отдела).
 */
export async function resolveManagerPersonalSnapshotIds(
  managerEmployeeId: number,
  startDate: string,
  endDate: string,
): Promise<number[]> {
  const { employeeIds } = await resolvePersonalSubmissionComposition(
    managerEmployeeId, startDate, endDate,
  );
  return employeeIds;
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

/**
 * Читает снимок состава approval_id, отсортированный по ФИО.
 *
 * exec — клиент транзакции: при материализации официальной версии табеля состав
 * обязан читаться тем же соединением, что и остальной расчёт, иначе снимок и часы
 * могут прийти из разных состояний БД.
 */
export async function listApprovalEmployees(
  approvalId: number,
  exec?: DbExecutor,
): Promise<IApprovalEmployeeSnapshot[]> {
  const sql = `SELECT employee_id, full_name
       FROM timesheet_approval_employees
       WHERE approval_id = $1
       ORDER BY full_name ASC, employee_id ASC`;
  if (exec) return (await exec.query<IApprovalEmployeeSnapshot>(sql, [approvalId])).rows;
  return query<IApprovalEmployeeSnapshot>(sql, [approvalId]);
}
