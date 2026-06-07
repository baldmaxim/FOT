import { execute, query, withTransaction } from '../config/postgres.js';
import { correctionApprovalSettingsService } from './correction-approval-settings.service.js';

/**
 * Назначения «кто согласует работу в выходной». Ответственный
 * (responsible_employee_id) отвечает за выходные дни конкретного сотрудника
 * (target_employee_id) или всего отдела (target_department_id).
 *
 * Назначать имеет смысл только внутри whitelist-отделов
 * (correction_approval_required_department_ids) — вне whitelist выходные
 * auto_approved и в очередь не попадают. Валидируется здесь.
 *
 * Роли, которым согласование выходных НЕ адресуется (не показываются как таргеты):
 * рабочий / подрядчик / руководитель строительства.
 */

const EXCLUDED_TARGET_ROLE_CODES = ['worker', 'contractor', 'manager_obj'];

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
    '[weekend-approval-assignments] table public.weekend_approval_assignments not found; weekend routing disabled.',
  );
}

export interface IWeekendAssignmentRow {
  id: string;
  responsible_employee_id: number;
  target_department_id: string | null;
  target_employee_id: number | null;
  is_active: boolean;
}

/** Активные назначения конкретного ответственного. */
export async function listActiveByResponsible(
  responsibleEmployeeId: number,
): Promise<{ department_ids: string[]; employee_ids: number[] }> {
  if (!Number.isInteger(responsibleEmployeeId) || responsibleEmployeeId <= 0) {
    return { department_ids: [], employee_ids: [] };
  }
  try {
    const rows = await query<{ target_department_id: string | null; target_employee_id: number | null }>(
      `SELECT target_department_id, target_employee_id
         FROM weekend_approval_assignments
        WHERE responsible_employee_id = $1 AND is_active = true`,
      [responsibleEmployeeId],
    );
    const department_ids = [...new Set(rows
      .map(r => r.target_department_id)
      .filter((v): v is string => typeof v === 'string' && v.length > 0))];
    const employee_ids = [...new Set(rows
      .map(r => r.target_employee_id)
      .filter((v): v is number => Number.isInteger(v)))];
    return { department_ids, employee_ids };
  } catch (err) {
    if (isMissingTableError(err)) { warnMissingTable(); return { department_ids: [], employee_ids: [] }; }
    throw err;
  }
}

/**
 * Карта «таргет → ответственный (employee_id)» по всем активным назначениям.
 * Для подсветки «уже назначен другому» и расчёта «Свободных».
 */
export async function loadAssignmentMaps(): Promise<{
  byDepartment: Map<string, number>;
  byEmployee: Map<number, number>;
}> {
  try {
    const rows = await query<{
      responsible_employee_id: number;
      target_department_id: string | null;
      target_employee_id: number | null;
    }>(
      `SELECT responsible_employee_id, target_department_id, target_employee_id
         FROM weekend_approval_assignments
        WHERE is_active = true`,
    );
    const byDepartment = new Map<string, number>();
    const byEmployee = new Map<number, number>();
    for (const r of rows) {
      if (r.target_department_id) byDepartment.set(String(r.target_department_id), Number(r.responsible_employee_id));
      if (r.target_employee_id != null) byEmployee.set(Number(r.target_employee_id), Number(r.responsible_employee_id));
    }
    return { byDepartment, byEmployee };
  } catch (err) {
    if (isMissingTableError(err)) { warnMissingTable(); return { byDepartment: new Map(), byEmployee: new Map() }; }
    throw err;
  }
}

/**
 * Ответственный (employee_id) за выходные конкретного сотрудника:
 * приоритет — явная привязка по сотруднику, затем по его отделу. null — не назначен.
 */
export async function resolveResponsibleEmployeeForTarget(
  employeeId: number,
  departmentId: string | null,
): Promise<number | null> {
  const maps = await loadAssignmentMaps();
  return resolveFromMaps(maps, employeeId, departmentId);
}

export function resolveFromMaps(
  maps: { byDepartment: Map<string, number>; byEmployee: Map<number, number> },
  employeeId: number,
  departmentId: string | null,
): number | null {
  const byEmp = maps.byEmployee.get(Number(employeeId));
  if (byEmp != null) return byEmp;
  if (departmentId) {
    const byDept = maps.byDepartment.get(String(departmentId));
    if (byDept != null) return byDept;
  }
  return null;
}

export interface ISetTargetsResult {
  ok: true;
  conflicts: Array<{ kind: 'department' | 'employee'; id: string | number; ownerEmployeeId: number }>;
}

/**
 * Полная замена активных таргетов ответственного (diff). Удалённые — мягкая
 * деактивация; добавленные — реактивация существующей строки либо вставка.
 * Таргеты, занятые ДРУГИМ активным ответственным, пропускаются и возвращаются
 * в conflicts. Валидируется принадлежность whitelist.
 */
export async function setTargetsForResponsible(input: {
  responsibleEmployeeId: number;
  departmentIds: string[];
  employeeIds: number[];
  actorUserId: string | null;
}): Promise<ISetTargetsResult> {
  const responsibleId = Number(input.responsibleEmployeeId);
  if (!Number.isInteger(responsibleId) || responsibleId <= 0) {
    return { ok: true, conflicts: [] };
  }

  const whitelist = await correctionApprovalSettingsService.getRequiredDepartmentIds();
  const desiredDeptIds = [...new Set((input.departmentIds || []).filter(id => whitelist.has(String(id))))];

  // Сотрудники-таргеты валидируем по принадлежности whitelist-отделу.
  const desiredEmpIdsRaw = [...new Set((input.employeeIds || []).filter(id => Number.isInteger(id) && id > 0))];
  let desiredEmpIds: number[] = [];
  if (desiredEmpIdsRaw.length > 0) {
    const empRows = await query<{ id: number; org_department_id: string | null }>(
      `SELECT id, org_department_id FROM employees WHERE id = ANY($1::bigint[])`,
      [desiredEmpIdsRaw],
    );
    desiredEmpIds = empRows
      .filter(e => e.org_department_id != null && whitelist.has(String(e.org_department_id)))
      .map(e => Number(e.id));
  }

  const conflicts: ISetTargetsResult['conflicts'] = [];

  await withTransaction(async (client) => {
    const nowIso = new Date().toISOString();

    const existing = (await client.query<{
      id: string; target_department_id: string | null; target_employee_id: number | null;
    }>(
      `SELECT id, target_department_id, target_employee_id
         FROM weekend_approval_assignments
        WHERE responsible_employee_id = $1 AND is_active = true`,
      [responsibleId],
    )).rows;

    const existingDeptIds = new Set(existing.filter(r => r.target_department_id).map(r => String(r.target_department_id)));
    const existingEmpIds = new Set(existing.filter(r => r.target_employee_id != null).map(r => Number(r.target_employee_id)));
    const desiredDeptSet = new Set(desiredDeptIds);
    const desiredEmpSet = new Set(desiredEmpIds);

    // Деактивация снятых таргетов.
    for (const r of existing) {
      const stillWanted = r.target_department_id
        ? desiredDeptSet.has(String(r.target_department_id))
        : desiredEmpSet.has(Number(r.target_employee_id));
      if (!stillWanted) {
        await client.query(
          `UPDATE weekend_approval_assignments
              SET is_active = false, unassigned_at = $1, deactivated_by = $2, updated_at = $1
            WHERE id = $3`,
          [nowIso, input.actorUserId, r.id],
        );
      }
    }

    const upsertTarget = async (
      kind: 'department' | 'employee',
      deptId: string | null,
      empId: number | null,
    ): Promise<void> => {
      // Занят ли таргет другим активным ответственным?
      const ownerRow = (await client.query<{ responsible_employee_id: number }>(
        kind === 'department'
          ? `SELECT responsible_employee_id FROM weekend_approval_assignments
               WHERE target_department_id = $1 AND is_active = true LIMIT 1`
          : `SELECT responsible_employee_id FROM weekend_approval_assignments
               WHERE target_employee_id = $1 AND is_active = true LIMIT 1`,
        [kind === 'department' ? deptId : empId],
      )).rows[0];
      if (ownerRow && Number(ownerRow.responsible_employee_id) !== responsibleId) {
        conflicts.push({ kind, id: (kind === 'department' ? deptId : empId)!, ownerEmployeeId: Number(ownerRow.responsible_employee_id) });
        return;
      }
      if (ownerRow) return; // уже активен у этого же ответственного

      // Реактивация ранее деактивированной строки либо вставка.
      const reactivated = await client.query(
        kind === 'department'
          ? `UPDATE weekend_approval_assignments
                SET is_active = true, unassigned_at = NULL, deactivated_by = NULL,
                    assigned_at = $1, assigned_by = $2, updated_at = $1
              WHERE responsible_employee_id = $3 AND target_department_id = $4 AND is_active = false`
          : `UPDATE weekend_approval_assignments
                SET is_active = true, unassigned_at = NULL, deactivated_by = NULL,
                    assigned_at = $1, assigned_by = $2, updated_at = $1
              WHERE responsible_employee_id = $3 AND target_employee_id = $4 AND is_active = false`,
        [nowIso, input.actorUserId, responsibleId, kind === 'department' ? deptId : empId],
      );
      if ((reactivated.rowCount ?? 0) > 0) return;

      await client.query(
        `INSERT INTO weekend_approval_assignments
           (responsible_employee_id, target_department_id, target_employee_id,
            assigned_at, assigned_by, is_active, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, true, $4, $4)`,
        [responsibleId, deptId, empId, nowIso, input.actorUserId],
      );
    };

    for (const deptId of desiredDeptIds) {
      if (!existingDeptIds.has(deptId)) await upsertTarget('department', deptId, null);
    }
    for (const empId of desiredEmpIds) {
      if (!existingEmpIds.has(empId)) await upsertTarget('employee', null, empId);
    }
  });

  return { ok: true, conflicts };
}

export interface IEligibleEmployee {
  employee_id: number;
  full_name: string | null;
  position_name: string | null;
  department_id: string | null;
  department_name: string | null;
  role_code: string | null;
  responsible_employee_id: number | null;
}

/**
 * Сотрудники подходящих ролей, входящие в whitelist-отделы, с текущим
 * ответственным (если есть). `onlyUnassigned=true` → только «Свободные».
 */
export async function listEligibleTargetEmployees(
  onlyUnassigned = false,
): Promise<IEligibleEmployee[]> {
  const whitelist = await correctionApprovalSettingsService.getRequiredDepartmentIds();
  if (whitelist.size === 0) return [];
  const whitelistIds = [...whitelist];

  const rows = await query<{
    id: number;
    full_name: string | null;
    position_name: string | null;
    org_department_id: string | null;
    department_name: string | null;
    role_code: string | null;
  }>(
    `SELECT e.id,
            e.full_name,
            p.name AS position_name,
            e.org_department_id,
            d.name AS department_name,
            sr.code AS role_code
       FROM employees e
       JOIN org_departments d ON d.id = e.org_department_id
       LEFT JOIN positions p ON p.id::text = e.position_id::text
       LEFT JOIN user_profiles up ON up.employee_id = e.id
       LEFT JOIN system_roles sr ON sr.id = up.system_role_id
      WHERE e.org_department_id = ANY($1::uuid[])
        AND e.employment_status = 'active' AND e.is_archived = false
        AND (sr.code IS NULL OR sr.code <> ALL($2::text[]))
      ORDER BY e.full_name`,
    [whitelistIds, EXCLUDED_TARGET_ROLE_CODES],
  );

  const maps = await loadAssignmentMaps();
  const result: IEligibleEmployee[] = [];
  for (const r of rows) {
    const responsible = resolveFromMaps(maps, Number(r.id), r.org_department_id);
    if (onlyUnassigned && responsible != null) continue;
    result.push({
      employee_id: Number(r.id),
      full_name: r.full_name ?? null,
      position_name: r.position_name ?? null,
      department_id: r.org_department_id ?? null,
      department_name: r.department_name ?? null,
      role_code: r.role_code ?? null,
      responsible_employee_id: responsible,
    });
  }
  return result;
}

/** Есть ли у сотрудника хотя бы одно активное назначение «ответственный за выходные». */
export async function isActiveWeekendResponsible(employeeId: number): Promise<boolean> {
  if (!Number.isInteger(employeeId) || employeeId <= 0) return false;
  try {
    const rows = await query<{ one: number }>(
      `SELECT 1 AS one FROM weekend_approval_assignments
        WHERE responsible_employee_id = $1 AND is_active = true LIMIT 1`,
      [employeeId],
    );
    return rows.length > 0;
  } catch (err) {
    if (isMissingTableError(err)) { warnMissingTable(); return false; }
    throw err;
  }
}

/** Деактивировать все назначения ответственного (например, при снятии роли). */
export async function deactivateAllForResponsible(
  responsibleEmployeeId: number,
  actorUserId: string | null,
): Promise<number> {
  const nowIso = new Date().toISOString();
  try {
    return await execute(
      `UPDATE weekend_approval_assignments
          SET is_active = false, unassigned_at = $1, deactivated_by = $2, updated_at = $1
        WHERE responsible_employee_id = $3 AND is_active = true`,
      [nowIso, actorUserId, responsibleEmployeeId],
    );
  } catch (err) {
    if (isMissingTableError(err)) { warnMissingTable(); return 0; }
    throw err;
  }
}
