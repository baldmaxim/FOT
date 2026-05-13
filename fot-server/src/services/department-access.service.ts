import { query } from '../config/postgres.js';

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
    accessRows = await query<{ employee_id: number | null }>(
      'SELECT employee_id FROM employee_department_access WHERE department_id = $1 AND is_active = true',
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
