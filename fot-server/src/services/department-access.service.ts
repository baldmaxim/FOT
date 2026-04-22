import { supabase } from '../config/database.js';

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

function isMissingTableError(error: unknown, tableName: string): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  const message = 'message' in error ? String((error as { message?: unknown }).message || '') : '';
  return code === 'PGRST205'
    || message.includes(`Could not find the table 'public.${tableName}'`);
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

async function listEmployeeAccessDepartmentIds(employeeId: number): Promise<string[]> {
  const { data, error } = await supabase
    .from('employee_department_access')
    .select('department_id')
    .eq('employee_id', employeeId)
    .eq('is_active', true);

  if (error) {
    if (isMissingTableError(error, 'employee_department_access')) {
      warnMissingEmployeeDepartmentAccessTable();
      return [];
    }
    throw error;
  }

  return uniqueDepartmentIds((data || []).map(row => row.department_id as string | null));
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
  let query = supabase
    .from('employee_department_access')
    .select('employee_id, department_id')
    .eq('is_active', true);
  if (options.excludeSource) {
    query = query.neq('source', options.excludeSource);
  }

  const { data, error } = useInFilter
    ? await query.in('employee_id', unique)
    : await query;

  if (error) {
    if (isMissingTableError(error, 'employee_department_access')) {
      warnMissingEmployeeDepartmentAccessTable();
      return result;
    }
    throw error;
  }

  for (const row of data || []) {
    const employeeId = row.employee_id as number;
    const departmentId = row.department_id as string | null;
    if (!departmentId || !result.has(employeeId)) continue;
    result.set(employeeId, uniqueDepartmentIds([...(result.get(employeeId) || []), departmentId]));
  }

  return result;
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

  const { data: accessRows, error: accessError } = await supabase
    .from('employee_department_access')
    .select('employee_id')
    .eq('department_id', departmentId)
    .eq('is_active', true);

  if (accessError) {
    if (isMissingTableError(accessError, 'employee_department_access')) {
      warnMissingEmployeeDepartmentAccessTable();
      return [];
    }
    throw accessError;
  }

  const employeeIds = [...new Set(
    (accessRows || [])
      .map(row => row.employee_id as number | null)
      .filter((id): id is number => Number.isInteger(id)),
  )];

  if (employeeIds.length === 0) return [];

  const { data: profiles, error: profileError } = await supabase
    .from('user_profiles')
    .select('id')
    .in('employee_id', employeeIds)
    .eq('is_approved', true);

  if (profileError) {
    throw profileError;
  }

  return [...new Set(
    (profiles || [])
      .map(row => row.id as string | null)
      .filter((id): id is string => typeof id === 'string' && id.length > 0),
  )];
}

export async function listExplicitDepartmentIdsForUser(
  _userId: string,
  employeeId?: number | null,
): Promise<string[]> {
  if (employeeId == null) return [];
  return listEmployeeAccessDepartmentIds(employeeId);
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

  const explicitMap = await loadExplicitDepartmentMap(seeds);
  for (const seed of seeds) {
    const current = result.get(seed.user_id);
    if (!current) continue;
    current.managed_department_ids = uniqueDepartmentIds(explicitMap.get(seed.user_id) || []);
  }

  return result;
}
