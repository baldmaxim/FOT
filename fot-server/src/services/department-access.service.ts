import { execute, query } from '../config/postgres.js';

export interface IUserManagedDepartmentSeed {
  user_id: string;
  primary_department_id?: string | null;
  employee_id?: number | null;
}

export interface IUserManagedDepartments {
  primary_department_id: string | null;
  managed_department_ids: string[];
}

let missingEmployeeDepartmentAccessTableWarned = false;

function isMissingTableError(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  return code === '42P01';
}

function warnMissingEmployeeDepartmentAccessTable(): void {
  if (missingEmployeeDepartmentAccessTableWarned) return;
  missingEmployeeDepartmentAccessTableWarned = true;
  console.warn(
    '[department-access] table public.employee_department_access not found; employee-level explicit access is disabled.',
  );
}

function uniqueDepartmentIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.trim().length > 0))];
}

async function listEmployeeAccessDepartmentIds(
  employeeId: number,
  options: { excludeSource?: string } = {},
): Promise<string[]> {
  try {
    const params: unknown[] = [employeeId];
    let sql = 'SELECT department_id FROM employee_department_access WHERE employee_id = $1 AND is_active = true';
    if (options.excludeSource) {
      params.push(options.excludeSource);
      sql += ` AND source <> $${params.length}`;
    }

    const rows = await query<{ department_id: string | null }>(sql, params);
    return uniqueDepartmentIds(rows.map(row => row.department_id));
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingEmployeeDepartmentAccessTable();
      return [];
    }
    throw err;
  }
}

const IN_FILTER_THRESHOLD = 300;

interface ILoadEmployeeAccessOptions {
  /** Исключить из выборки строки с данным source (например 'sigur_sync' — членство). */
  excludeSource?: string;
}

export async function loadEmployeeAccessMap(
  employeeIds: number[],
  options: ILoadEmployeeAccessOptions = {},
): Promise<Map<number, string[]>> {
  const unique = [...new Set(employeeIds.filter((v): v is number => Number.isInteger(v)))];
  const result = new Map<number, string[]>(unique.map(id => [id, []]));
  if (unique.length === 0) return result;

  const useInFilter = unique.length <= IN_FILTER_THRESHOLD;

  try {
    const params: unknown[] = [];
    let sql = 'SELECT employee_id, department_id FROM employee_department_access WHERE is_active = true';
    if (options.excludeSource) {
      params.push(options.excludeSource);
      sql += ` AND source <> $${params.length}`;
    }
    if (useInFilter) {
      params.push(unique);
      sql += ` AND employee_id = ANY($${params.length}::int[])`;
    }

    const rows = await query<{ employee_id: number; department_id: string | null }>(sql, params);

    for (const row of rows) {
      const employeeId = row.employee_id;
      const departmentId = row.department_id;
      if (!departmentId || !result.has(employeeId)) continue;
      result.set(employeeId, uniqueDepartmentIds([...(result.get(employeeId) || []), departmentId]));
    }

    return result;
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingEmployeeDepartmentAccessTable();
      return result;
    }
    throw err;
  }
}

/**
 * Карта «руководительских» назначений: только ручные строки (manual_admin_ui,
 * excel_admin_ui, manager_excel_admin_ui). Membership-строки от Sigur
 * (source='sigur_sync') в выдачу не попадают — для HR-представлений и
 * экрана «Назначения сотрудников».
 */
export async function loadEmployeeManagerAssignmentMap(
  employeeIds: number[],
): Promise<Map<number, string[]>> {
  return loadEmployeeAccessMap(employeeIds, { excludeSource: 'sigur_sync' });
}

export async function loadExplicitDepartmentMap(
  seeds: Array<{ user_id: string; employee_id?: number | null }>,
  options: ILoadEmployeeAccessOptions = {},
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();
  const employeeIds = seeds
    .map(seed => seed.employee_id)
    .filter((id): id is number => Number.isInteger(id));
  const employeeAccessMap = await loadEmployeeAccessMap(employeeIds, options);

  for (const seed of seeds) {
    const departmentIds = seed.employee_id != null
      ? (employeeAccessMap.get(seed.employee_id) || [])
      : [];
    result.set(seed.user_id, uniqueDepartmentIds(departmentIds));
  }

  return result;
}

/** HR-аналог loadExplicitDepartmentMap: исключает членство (sigur_sync). */
export async function loadExplicitManagerAssignmentMap(
  seeds: Array<{ user_id: string; employee_id?: number | null }>,
): Promise<Map<string, string[]>> {
  return loadExplicitDepartmentMap(seeds, { excludeSource: 'sigur_sync' });
}

export async function listUserIdsAssignedToDepartment(departmentId: string): Promise<string[]> {
  if (!departmentId) return [];

  let accessRows: Array<{ employee_id: number | null }>;
  try {
    // Только руководительские назначения. Membership-строки (source='sigur_sync' —
    // «сотрудник числится в отделе») исключаем: рядовые члены отдела не должны
    // получать напоминания о подаче табеля.
    accessRows = await query<{ employee_id: number | null }>(
      "SELECT employee_id FROM employee_department_access WHERE department_id = $1 AND is_active = true AND source <> 'sigur_sync'",
      [departmentId],
    );
  } catch (err) {
    if (isMissingTableError(err)) {
      warnMissingEmployeeDepartmentAccessTable();
      return [];
    }
    throw err;
  }

  const employeeIds = [...new Set(
    accessRows
      .map(row => row.employee_id)
      .filter((id): id is number => Number.isInteger(id)),
  )];

  if (employeeIds.length === 0) return [];

  const profiles = await query<{ id: string | null }>(
    'SELECT id FROM user_profiles WHERE employee_id = ANY($1::int[]) AND is_approved = true',
    [employeeIds],
  );

  return [...new Set(
    profiles
      .map(row => row.id)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )];
}

/**
 * Возвращает руководительские назначения сотрудника. Membership-строки
 * (`source='sigur_sync'` — личный отдел из Sigur) исключаются: они означают
 * «человек работает в этом отделе», а не «человек им управляет». Если у
 * руководителя нет ручных назначений (manual_admin_ui / excel_admin_ui /
 * manager_excel_admin_ui) — функция вернёт пустой массив, и scope будет пуст.
 */
export async function listExplicitDepartmentIdsForUser(
  _userId: string,
  employeeId?: number | null,
): Promise<string[]> {
  if (employeeId == null) return [];
  return listEmployeeAccessDepartmentIds(employeeId, { excludeSource: 'sigur_sync' });
}

export async function listManagedDepartmentIdsForUser(
  userId: string,
  _primaryDepartmentId?: string | null,
  employeeId?: number | null,
): Promise<string[]> {
  const explicit = await listExplicitDepartmentIdsForUser(userId, employeeId);
  return uniqueDepartmentIds(explicit);
}

/**
 * Прямые назначения «начальник участка → отдельный сотрудник».
 * Хранятся в user_employee_access (миграция 090). В отличие от
 * employee_department_access, здесь ключ (user_id, employee_id) —
 * семантика «этот юзер видит/выгружает табель конкретного сотрудника».
 */
export async function listAssignedEmployeeIdsForUser(userId: string): Promise<number[]> {
  if (!userId) return [];
  try {
    const rows = await query<{ employee_id: number | string | null }>(
      'SELECT employee_id FROM user_employee_access WHERE user_id = $1::uuid AND is_active = true',
      [userId],
    );
    return [...new Set(
      rows
        .map(row => (row.employee_id == null ? NaN : Number(row.employee_id)))
        .filter((id): id is number => Number.isFinite(id)),
    )];
  } catch (err) {
    if (isMissingTableError(err)) return [];
    throw err;
  }
}

export async function loadAssignedEmployeeMap(
  userIds: string[],
): Promise<Map<string, number[]>> {
  const unique = [...new Set(userIds.filter(v => typeof v === 'string' && v.length > 0))];
  const result = new Map<string, number[]>(unique.map(id => [id, []]));
  if (unique.length === 0) return result;
  try {
    const rows = await query<{ user_id: string; employee_id: number | string | null }>(
      'SELECT user_id, employee_id FROM user_employee_access WHERE is_active = true AND user_id = ANY($1::uuid[])',
      [unique],
    );
    for (const row of rows) {
      const id = row.employee_id == null ? NaN : Number(row.employee_id);
      if (!Number.isFinite(id)) continue;
      const list = result.get(row.user_id);
      if (!list) continue;
      if (!list.includes(id)) list.push(id);
    }
    return result;
  } catch (err) {
    if (isMissingTableError(err)) return result;
    throw err;
  }
}

export async function replaceUserEmployeeAccess(params: {
  userId: string;
  employeeIds: number[];
  actorUserId: string;
}): Promise<number[]> {
  const nextEmployeeIds = [...new Set(
    params.employeeIds.filter((id): id is number => Number.isInteger(id) && id > 0),
  )];

  const existingRows = await query<{ employee_id: number | string; is_active: boolean }>(
    'SELECT employee_id, is_active FROM user_employee_access WHERE user_id = $1::uuid',
    [params.userId],
  );

  const nextSet = new Set(nextEmployeeIds);
  const activeIds = existingRows
    .filter(row => row.is_active)
    .map(row => Number(row.employee_id))
    .filter((id): id is number => Number.isFinite(id));
  const idsToDeactivate = activeIds.filter(id => !nextSet.has(id));

  const now = new Date().toISOString();

  if (nextEmployeeIds.length > 0) {
    await execute(
      `INSERT INTO user_employee_access
         (user_id, employee_id, is_active, created_by, updated_at)
       SELECT $1::uuid, emp_id, true, $2::uuid, $3::timestamptz
         FROM unnest($4::bigint[]) AS emp_id
       ON CONFLICT (user_id, employee_id)
       DO UPDATE SET
         is_active = true,
         created_by = COALESCE(user_employee_access.created_by, EXCLUDED.created_by),
         updated_at = EXCLUDED.updated_at`,
      [params.userId, params.actorUserId, now, nextEmployeeIds],
    );
  }

  if (idsToDeactivate.length > 0) {
    await execute(
      `UPDATE user_employee_access
          SET is_active = false, updated_at = $1::timestamptz
        WHERE user_id = $2::uuid
          AND employee_id = ANY($3::bigint[])`,
      [now, params.userId, idsToDeactivate],
    );
  }

  return nextEmployeeIds;
}

export async function loadManagedDepartmentMap(
  seeds: IUserManagedDepartmentSeed[],
): Promise<Map<string, IUserManagedDepartments>> {
  const result = new Map<string, IUserManagedDepartments>(
    seeds.map(seed => [
      seed.user_id,
      {
        primary_department_id: seed.primary_department_id ?? null,
        managed_department_ids: [],
      },
    ]),
  );

  // Membership-строки (sigur_sync) исключаем: «руководитель управляет
  // отделом» ≠ «сотрудник числится в отделе». Иначе любой работник
  // получил бы свой собственный отдел в списке управляемых.
  const explicitMap = await loadExplicitDepartmentMap(seeds, { excludeSource: 'sigur_sync' });
  for (const seed of seeds) {
    const current = result.get(seed.user_id);
    if (!current) continue;
    current.managed_department_ids = uniqueDepartmentIds(explicitMap.get(seed.user_id) || []);
  }

  return result;
}
