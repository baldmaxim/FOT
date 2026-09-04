/**
 * Слияние отдела-дубля Sigur в целевой отдел.
 *
 * Зачем отдельный сервис, а не штатный `POST /employees/:id/move-department`:
 *  - штатный перевод при выключенной «заморозке истории» закрывает открытое
 *    назначение и создаёт новое сегодняшней датой — для дубля это фиктивный
 *    перевод, который дробит текущий период табеля;
 *  - его ранний `noop` (отдел уже целевой) срабатывает до починки технических
 *    привязок, поэтому повтор после частичного сбоя ничего не долечивает.
 *
 * Здесь операция идемпотентна по фактическому состоянию: каждый шаг — UPDATE со
 * строгим `WHERE ... = source`, поэтому повторный запуск даёт нули по счётчикам.
 * Пишем ровно в три места: `employees.org_department_id`, ОТКРЫТЫЕ
 * `employee_assignments` и `employee_department_access`. Табели, версии, составы
 * подач и закрытая история назначений не трогаются вообще.
 */
import type { PoolClient } from 'pg';
import { sigurService, type ConnectionType } from './sigur.service.js';
import { normalizeEmployee } from './sigur-sync-shared.js';

/** Таблицы, привязанные к employee_id: отдел в них не хранится, но считаем их до/после. */
export const MERGE_INVENTORY_TABLES = [
  'skud_events',
  'skud_daily_summary',
  'attendance_adjustments',
  'employee_schedule_assignments',
  'employee_assignments',
  'employee_department_access',
  'documents',
  'leave_requests',
  'payslips',
  'payments',
  'salary_history',
  'employee_object_assignment',
  'patent_payment_receipts',
] as const;

export interface IMergeEmployeeRow {
  id: number;
  full_name: string | null;
  sigur_employee_id: number | null;
  employment_status: string | null;
  dismissal_date: string | null;
  dismissal_apply_started_at: string | null;
  is_archived: boolean;
  open_assignments: number;
}

export interface IMergeCandidate {
  employeeId: number;
  fullName: string;
  sigurEmployeeId: number | null;
}

export interface IMergePlan {
  candidates: IMergeCandidate[];
  problems: string[];
}

export interface IMergeCounters {
  employeesUpdated: number;
  assignmentsUpdated: number;
  accessGranted: number;
  accessReactivated: number;
  accessRevoked: number;
}

export interface IMergeSnapshotEmployee {
  employeeId: number;
  fullName: string;
  sigurEmployeeId: number | null;
  orgDepartmentId: string | null;
  openAssignmentIds: string[];
}

export interface IMergeSnapshotAccess {
  id: string;
  employeeId: number;
  departmentId: string;
  isActive: boolean;
}

/**
 * Проверка кандидатов на перенос. Чистая функция — тестируется без БД.
 *
 * Отклоняем проблемные строки поимённо: частичный перенос оставляет дубль
 * непустым, а такой отдел нельзя ни удалить в Sigur, ни погасить в зеркале,
 * поэтому вызывающий обязан остановиться на любой проблеме.
 */
export function planEmployeeMerge(rows: IMergeEmployeeRow[]): IMergePlan {
  const problems: string[] = [];
  const candidates: IMergeCandidate[] = [];

  for (const row of rows) {
    const name = (row.full_name || '').trim() || `id=${row.id}`;

    if (row.is_archived) {
      problems.push(`${name}: карточка в архиве — перенос через слияние не выполняем`);
      continue;
    }
    if (row.employment_status !== 'active') {
      problems.push(`${name}: статус «${row.employment_status ?? 'null'}», а не active`);
      continue;
    }
    if (row.dismissal_date || row.dismissal_apply_started_at) {
      problems.push(`${name}: запланировано увольнение — сначала закройте сценарий увольнения`);
      continue;
    }
    if (row.open_assignments !== 1) {
      problems.push(`${name}: открытых назначений ${row.open_assignments}, ожидается ровно одно`);
      continue;
    }
    if (!row.sigur_employee_id) {
      problems.push(`${name}: нет sigur_employee_id — карточку в Sigur не перевести`);
      continue;
    }

    candidates.push({
      employeeId: row.id,
      fullName: name,
      sigurEmployeeId: row.sigur_employee_id,
    });
  }

  return { candidates, problems };
}

/** Кандидаты на перенос: сотрудники отдела-источника. */
export async function loadMergeCandidates(
  client: PoolClient,
  sourceDepartmentId: string,
): Promise<IMergeEmployeeRow[]> {
  const { rows } = await client.query<Omit<IMergeEmployeeRow, 'open_assignments'> & { open_assignments: string }>(
    `SELECT e.id, e.full_name, e.sigur_employee_id, e.employment_status,
            e.dismissal_date, e.dismissal_apply_started_at, e.is_archived,
            (SELECT count(*) FROM employee_assignments a
              WHERE a.employee_id = e.id AND a.effective_to IS NULL)::text AS open_assignments
       FROM employees e
      WHERE e.org_department_id = $1
      ORDER BY e.id`,
    [sourceDepartmentId],
  );
  return rows.map(row => ({ ...row, open_assignments: Number(row.open_assignments) }));
}

/**
 * Перенос в Sigur: карточка меняет departmentId, только если она ещё не в цели.
 * После записи перечитываем карточку — молчаливое «ок» без фактической смены
 * отдела вернуло бы синк на следующем тике.
 */
export async function moveEmployeesInSigur(
  candidates: IMergeCandidate[],
  targetSigurDepartmentId: number,
  connection?: ConnectionType,
): Promise<{ moved: number; skipped: number }> {
  let moved = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    if (!candidate.sigurEmployeeId) continue;

    const before = normalizeEmployee(
      await sigurService.getEmployeeById(candidate.sigurEmployeeId, connection) as Record<string, unknown>,
    );
    if (before.departmentId === targetSigurDepartmentId) {
      skipped++;
      continue;
    }

    await sigurService.updateEmployee(
      candidate.sigurEmployeeId,
      { departmentId: targetSigurDepartmentId },
      connection,
    );

    const after = normalizeEmployee(
      await sigurService.getEmployeeById(candidate.sigurEmployeeId, connection) as Record<string, unknown>,
    );
    if (after.departmentId !== targetSigurDepartmentId) {
      throw new Error(
        `${candidate.fullName}: Sigur не применил перевод — departmentId=${after.departmentId ?? 'null'}`,
      );
    }
    moved++;
  }

  return { moved, skipped };
}

/**
 * Перенос в FOT. Вызывается ТОЛЬКО внутри транзакции вызывающего.
 *
 * Порядок важен: доступ на целевом отделе заводим до гашения доступов к
 * источнику — иначе между шагами возникает состояние «нет ни там, ни там».
 */
export async function mergeDepartmentEmployeesTx(
  client: PoolClient,
  params: { sourceDepartmentId: string; targetDepartmentId: string; employeeIds: number[] },
): Promise<IMergeCounters> {
  const { sourceDepartmentId, targetDepartmentId, employeeIds } = params;

  if (sourceDepartmentId === targetDepartmentId) {
    throw new Error('Отдел-источник совпадает с целевым');
  }

  // FOR UPDATE: параллельный синк сотрудников не перепишет отдел между шагами.
  await client.query('SELECT id FROM employees WHERE id = ANY($1::bigint[]) FOR UPDATE', [employeeIds]);

  const employeesUpdated = await client.query(
    `UPDATE employees SET org_department_id = $1
      WHERE id = ANY($2::bigint[]) AND org_department_id = $3`,
    [targetDepartmentId, employeeIds, sourceDepartmentId],
  );

  // Только открытое назначение: effective_from и change_reason сохраняются,
  // новых строк истории не появляется — для дубля перевода не было.
  const assignmentsUpdated = await client.query(
    `UPDATE employee_assignments SET org_department_id = $1
      WHERE employee_id = ANY($2::bigint[])
        AND effective_to IS NULL
        AND org_department_id = $3`,
    [targetDepartmentId, employeeIds, sourceDepartmentId],
  );

  const accessGranted = await client.query(
    `INSERT INTO employee_department_access
       (employee_id, department_id, source, is_active, created_at, updated_at)
     SELECT e.id, $1, 'portal_lifecycle', true, now(), now()
       FROM unnest($2::bigint[]) AS e(id)
      WHERE NOT EXISTS (
        SELECT 1 FROM employee_department_access a
         WHERE a.employee_id = e.id AND a.department_id = $1)`,
    [targetDepartmentId, employeeIds],
  );

  const accessReactivated = await client.query(
    `UPDATE employee_department_access SET is_active = true, updated_at = now()
      WHERE employee_id = ANY($1::bigint[]) AND department_id = $2 AND is_active = false`,
    [employeeIds, targetDepartmentId],
  );

  // Гасим ВСЕ активные привязки к источнику, включая manual_admin_ui: отдел
  // скрывается, привязка к нему больше ничего не даёт.
  const accessRevoked = await client.query(
    `UPDATE employee_department_access SET is_active = false, updated_at = now()
      WHERE department_id = $1 AND is_active`,
    [sourceDepartmentId],
  );

  return {
    employeesUpdated: employeesUpdated.rowCount ?? 0,
    assignmentsUpdated: assignmentsUpdated.rowCount ?? 0,
    accessGranted: accessGranted.rowCount ?? 0,
    accessReactivated: accessReactivated.rowCount ?? 0,
    accessRevoked: accessRevoked.rowCount ?? 0,
  };
}

/**
 * Возврат к состоянию из снимка. Строку пропускаем, если её текущее значение уже
 * не то, что выставила операция: значит её меняли после — молча затирать нельзя.
 */
export async function rollbackDepartmentMergeTx(
  client: PoolClient,
  snapshot: {
    targetDepartmentId: string;
    employees: IMergeSnapshotEmployee[];
    access: IMergeSnapshotAccess[];
  },
): Promise<{ employeesRestored: number; assignmentsRestored: number; accessRestored: number; skipped: string[] }> {
  const skipped: string[] = [];
  let employeesRestored = 0;
  let assignmentsRestored = 0;
  let accessRestored = 0;

  for (const employee of snapshot.employees) {
    if (!employee.orgDepartmentId) {
      skipped.push(`${employee.fullName}: в снимке нет исходного отдела`);
      continue;
    }

    const restored = await client.query(
      `UPDATE employees SET org_department_id = $1
        WHERE id = $2 AND org_department_id = $3`,
      [employee.orgDepartmentId, employee.employeeId, snapshot.targetDepartmentId],
    );
    if ((restored.rowCount ?? 0) === 0) {
      skipped.push(`${employee.fullName}: отдел уже не совпадает с целевым — пропуск`);
    }
    employeesRestored += restored.rowCount ?? 0;

    if (employee.openAssignmentIds.length > 0) {
      const assignments = await client.query(
        `UPDATE employee_assignments SET org_department_id = $1
          WHERE id = ANY($2::uuid[]) AND org_department_id = $3`,
        [employee.orgDepartmentId, employee.openAssignmentIds, snapshot.targetDepartmentId],
      );
      assignmentsRestored += assignments.rowCount ?? 0;
    }
  }

  for (const access of snapshot.access) {
    const restored = await client.query(
      `UPDATE employee_department_access SET is_active = $1, updated_at = now()
        WHERE id = $2 AND is_active IS DISTINCT FROM $1`,
      [access.isActive, access.id],
    );
    accessRestored += restored.rowCount ?? 0;
  }

  return { employeesRestored, assignmentsRestored, accessRestored, skipped };
}
