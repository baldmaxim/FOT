/**
 * Ручное назначение «объектов входа» (skud_objects) сущностям для скоупа табельщицы:
 *   - department_object_assignment — отдел/бригада → объект (члены наследуют);
 *   - employee_object_assignment   — сотрудник → объект (переопределение для мультиобъектных);
 *   - timekeeper_object_access     — табельщица → объекты.
 *
 * Развязано с employee_skud_object_access (/skud-presence) и 1С-выгрузкой —
 * читается только скоупом табельщицы (timekeeper-scope.service.ts).
 */
import { execute, query } from '../config/postgres.js';

const nowIso = (): string => new Date().toISOString();

const normalizeObjectIds = (objectIds: string[]): string[] => [...new Set(
  objectIds.filter((id): id is string => typeof id === 'string' && id.trim().length > 0).map(id => id.trim()),
)];

// ---- Department → object -----------------------------------------------------

export async function listDepartmentObjectAssignments(): Promise<Array<{ org_department_id: string; skud_object_id: string }>> {
  return query<{ org_department_id: string; skud_object_id: string }>(
    `SELECT org_department_id, skud_object_id
       FROM department_object_assignment WHERE is_active = true`,
  );
}

export async function listObjectIdsForDepartment(departmentId: string): Promise<string[]> {
  const rows = await query<{ skud_object_id: string }>(
    `SELECT skud_object_id FROM department_object_assignment
      WHERE org_department_id = $1::uuid AND is_active = true`,
    [departmentId],
  );
  return [...new Set(rows.map(r => r.skud_object_id))];
}

export async function replaceDepartmentObjectAssignment(params: {
  departmentId: string;
  objectIds: string[];
  actorUserId: string;
}): Promise<string[]> {
  const next = normalizeObjectIds(params.objectIds);
  const existing = await query<{ skud_object_id: string; is_active: boolean }>(
    'SELECT skud_object_id, is_active FROM department_object_assignment WHERE org_department_id = $1::uuid',
    [params.departmentId],
  );
  const nextSet = new Set(next);
  const toDeactivate = existing.filter(r => r.is_active).map(r => r.skud_object_id).filter(id => !nextSet.has(id));
  const now = nowIso();

  if (next.length > 0) {
    await execute(
      `INSERT INTO department_object_assignment (org_department_id, skud_object_id, is_active, created_by, updated_at)
       SELECT $1::uuid, obj_id, true, $2::uuid, $3::timestamptz FROM unnest($4::uuid[]) AS obj_id
       ON CONFLICT (org_department_id, skud_object_id)
       DO UPDATE SET is_active = true,
         created_by = COALESCE(department_object_assignment.created_by, EXCLUDED.created_by),
         updated_at = EXCLUDED.updated_at`,
      [params.departmentId, params.actorUserId, now, next],
    );
  }
  if (toDeactivate.length > 0) {
    await execute(
      `UPDATE department_object_assignment SET is_active = false, updated_at = $1::timestamptz
        WHERE org_department_id = $2::uuid AND skud_object_id = ANY($3::uuid[])`,
      [now, params.departmentId, toDeactivate],
    );
  }
  return next;
}

// ---- Employee → object -------------------------------------------------------

export async function listEmployeeObjectAssignments(): Promise<Array<{ employee_id: number; skud_object_id: string }>> {
  const rows = await query<{ employee_id: number | string; skud_object_id: string }>(
    `SELECT employee_id, skud_object_id FROM employee_object_assignment WHERE is_active = true`,
  );
  return rows.map(r => ({ employee_id: Number(r.employee_id), skud_object_id: r.skud_object_id }));
}

export async function listObjectIdsForEmployeeAssignment(employeeId: number): Promise<string[]> {
  const rows = await query<{ skud_object_id: string }>(
    `SELECT skud_object_id FROM employee_object_assignment
      WHERE employee_id = $1::bigint AND is_active = true`,
    [employeeId],
  );
  return [...new Set(rows.map(r => r.skud_object_id))];
}

export async function replaceEmployeeObjectAssignment(params: {
  employeeId: number;
  objectIds: string[];
  actorUserId: string;
}): Promise<string[]> {
  const next = normalizeObjectIds(params.objectIds);
  const existing = await query<{ skud_object_id: string; is_active: boolean }>(
    'SELECT skud_object_id, is_active FROM employee_object_assignment WHERE employee_id = $1::bigint',
    [params.employeeId],
  );
  const nextSet = new Set(next);
  const toDeactivate = existing.filter(r => r.is_active).map(r => r.skud_object_id).filter(id => !nextSet.has(id));
  const now = nowIso();

  if (next.length > 0) {
    await execute(
      `INSERT INTO employee_object_assignment (employee_id, skud_object_id, is_active, created_by, updated_at)
       SELECT $1::bigint, obj_id, true, $2::uuid, $3::timestamptz FROM unnest($4::uuid[]) AS obj_id
       ON CONFLICT (employee_id, skud_object_id)
       DO UPDATE SET is_active = true,
         created_by = COALESCE(employee_object_assignment.created_by, EXCLUDED.created_by),
         updated_at = EXCLUDED.updated_at`,
      [params.employeeId, params.actorUserId, now, next],
    );
  }
  if (toDeactivate.length > 0) {
    await execute(
      `UPDATE employee_object_assignment SET is_active = false, updated_at = $1::timestamptz
        WHERE employee_id = $2::bigint AND skud_object_id = ANY($3::uuid[])`,
      [now, params.employeeId, toDeactivate],
    );
  }
  return next;
}

// ---- Timekeeper → objects ----------------------------------------------------

export async function listTimekeeperObjectAccess(timekeeperUserId: string): Promise<string[]> {
  const rows = await query<{ skud_object_id: string }>(
    `SELECT skud_object_id FROM timekeeper_object_access
      WHERE timekeeper_user_id = $1::uuid AND is_active = true`,
    [timekeeperUserId],
  );
  return [...new Set(rows.map(r => r.skud_object_id))];
}

export async function replaceTimekeeperObjectAccess(params: {
  timekeeperUserId: string;
  objectIds: string[];
  actorUserId: string;
}): Promise<string[]> {
  const next = normalizeObjectIds(params.objectIds);
  const existing = await query<{ skud_object_id: string; is_active: boolean }>(
    'SELECT skud_object_id, is_active FROM timekeeper_object_access WHERE timekeeper_user_id = $1::uuid',
    [params.timekeeperUserId],
  );
  const nextSet = new Set(next);
  const toDeactivate = existing.filter(r => r.is_active).map(r => r.skud_object_id).filter(id => !nextSet.has(id));
  const now = nowIso();

  if (next.length > 0) {
    await execute(
      `INSERT INTO timekeeper_object_access (timekeeper_user_id, skud_object_id, is_active, created_by, updated_at)
       SELECT $1::uuid, obj_id, true, $2::uuid, $3::timestamptz FROM unnest($4::uuid[]) AS obj_id
       ON CONFLICT (timekeeper_user_id, skud_object_id)
       DO UPDATE SET is_active = true,
         created_by = COALESCE(timekeeper_object_access.created_by, EXCLUDED.created_by),
         updated_at = EXCLUDED.updated_at`,
      [params.timekeeperUserId, params.actorUserId, now, next],
    );
  }
  if (toDeactivate.length > 0) {
    await execute(
      `UPDATE timekeeper_object_access SET is_active = false, updated_at = $1::timestamptz
        WHERE timekeeper_user_id = $2::uuid AND skud_object_id = ANY($3::uuid[])`,
      [now, params.timekeeperUserId, toDeactivate],
    );
  }
  return next;
}

// ---- Timekeeper → folders (org_departments) ----------------------------------
// Папки сужают скоуп табельщицы: видимые участки/бригады = присутствие на объектах
// ∩ поддерево выбранных папок (см. timekeeper-scope.service.ts).

export async function listTimekeeperFolderAccess(timekeeperUserId: string): Promise<string[]> {
  const rows = await query<{ department_id: string }>(
    `SELECT department_id FROM timekeeper_folder_access
      WHERE timekeeper_user_id = $1::uuid AND is_active = true`,
    [timekeeperUserId],
  );
  return [...new Set(rows.map(r => r.department_id))];
}

export async function replaceTimekeeperFolderAccess(params: {
  timekeeperUserId: string;
  departmentIds: string[];
  actorUserId: string;
}): Promise<string[]> {
  const next = normalizeObjectIds(params.departmentIds);
  const existing = await query<{ department_id: string; is_active: boolean }>(
    'SELECT department_id, is_active FROM timekeeper_folder_access WHERE timekeeper_user_id = $1::uuid',
    [params.timekeeperUserId],
  );
  const nextSet = new Set(next);
  const toDeactivate = existing.filter(r => r.is_active).map(r => r.department_id).filter(id => !nextSet.has(id));
  const now = nowIso();

  if (next.length > 0) {
    await execute(
      `INSERT INTO timekeeper_folder_access (timekeeper_user_id, department_id, is_active, created_by, updated_at)
       SELECT $1::uuid, dep_id, true, $2::uuid, $3::timestamptz FROM unnest($4::uuid[]) AS dep_id
       ON CONFLICT (timekeeper_user_id, department_id)
       DO UPDATE SET is_active = true,
         created_by = COALESCE(timekeeper_folder_access.created_by, EXCLUDED.created_by),
         updated_at = EXCLUDED.updated_at`,
      [params.timekeeperUserId, params.actorUserId, now, next],
    );
  }
  if (toDeactivate.length > 0) {
    await execute(
      `UPDATE timekeeper_folder_access SET is_active = false, updated_at = $1::timestamptz
        WHERE timekeeper_user_id = $2::uuid AND department_id = ANY($3::uuid[])`,
      [now, params.timekeeperUserId, toDeactivate],
    );
  }
  return next;
}
