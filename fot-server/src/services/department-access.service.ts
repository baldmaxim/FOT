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

let missingUserDepartmentAccessTableWarned = false;
let missingEmployeeDepartmentAccessTableWarned = false;

function isMissingTableError(error: unknown, tableName: string): boolean {
  if (!error || typeof error !== 'object') return false;

  const code = 'code' in error ? String((error as { code?: unknown }).code || '') : '';
  const message = 'message' in error ? String((error as { message?: unknown }).message || '') : '';

  return code === 'PGRST205'
    || message.includes(`Could not find the table 'public.${tableName}'`);
}

function warnMissingUserDepartmentAccessTable(): void {
  if (missingUserDepartmentAccessTableWarned) return;
  missingUserDepartmentAccessTableWarned = true;
  console.warn(
    '[department-access] table public.user_department_access not found; user-level explicit access is disabled until docs/migrations/031_manager_department_access.sql is applied.',
  );
}

function warnMissingEmployeeDepartmentAccessTable(): void {
  if (missingEmployeeDepartmentAccessTableWarned) return;
  missingEmployeeDepartmentAccessTableWarned = true;
  console.warn(
    '[department-access] table public.employee_department_access not found; employee-level explicit access is disabled until docs/migrations/032_employee_department_access.sql is applied.',
  );
}

function uniqueDepartmentIds(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === 'string' && value.trim().length > 0))];
}

async function listUserAccessDepartmentIds(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('user_department_access')
    .select('department_id')
    .eq('user_id', userId)
    .eq('is_active', true);

  if (error) {
    if (isMissingTableError(error, 'user_department_access')) {
      warnMissingUserDepartmentAccessTable();
      return [];
    }
    throw error;
  }

  return uniqueDepartmentIds((data || []).map(row => row.department_id as string | null));
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

async function loadUserAccessMap(userIds: string[]): Promise<Map<string, string[]>> {
  const uniqueUserIds = [...new Set(userIds.filter(Boolean))];
  const result = new Map<string, string[]>(
    uniqueUserIds.map(userId => [userId, []]),
  );

  if (uniqueUserIds.length === 0) {
    return result;
  }

  const { data, error } = await supabase
    .from('user_department_access')
    .select('user_id, department_id')
    .in('user_id', uniqueUserIds)
    .eq('is_active', true);

  if (error) {
    if (isMissingTableError(error, 'user_department_access')) {
      warnMissingUserDepartmentAccessTable();
      return result;
    }
    throw error;
  }

  for (const row of data || []) {
    const userId = row.user_id as string;
    const departmentId = row.department_id as string | null;
    if (!departmentId || !result.has(userId)) continue;

    result.set(userId, uniqueDepartmentIds([
      ...(result.get(userId) || []),
      departmentId,
    ]));
  }

  return result;
}

export async function loadEmployeeAccessMap(employeeIds: number[]): Promise<Map<number, string[]>> {
  const uniqueEmployeeIds = [...new Set(employeeIds.filter((value): value is number => Number.isInteger(value)))];
  const result = new Map<number, string[]>(
    uniqueEmployeeIds.map(employeeId => [employeeId, []]),
  );

  if (uniqueEmployeeIds.length === 0) {
    return result;
  }

  const { data, error } = await supabase
    .from('employee_department_access')
    .select('employee_id, department_id')
    .in('employee_id', uniqueEmployeeIds)
    .eq('is_active', true);

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

    result.set(employeeId, uniqueDepartmentIds([
      ...(result.get(employeeId) || []),
      departmentId,
    ]));
  }

  return result;
}

export async function loadExplicitDepartmentMap(
  seeds: Array<{ user_id: string; employee_id?: number | null }>,
): Promise<Map<string, string[]>> {
  const result = new Map<string, string[]>();

  const userAccessMap = await loadUserAccessMap(seeds.map(seed => seed.user_id));
  const employeeAccessMap = await loadEmployeeAccessMap(
    seeds
      .map(seed => seed.employee_id)
      .filter((employeeId): employeeId is number => Number.isInteger(employeeId)),
  );

  for (const seed of seeds) {
    const userDepartmentIds = userAccessMap.get(seed.user_id) || [];
    const employeeDepartmentIds = seed.employee_id != null
      ? (employeeAccessMap.get(seed.employee_id) || [])
      : [];

    result.set(seed.user_id, uniqueDepartmentIds([
      ...userDepartmentIds,
      ...employeeDepartmentIds,
    ]));
  }

  return result;
}

export async function listExplicitDepartmentIdsForUser(
  userId: string,
  employeeId?: number | null,
): Promise<string[]> {
  const [userDepartmentIds, employeeDepartmentIds] = await Promise.all([
    listUserAccessDepartmentIds(userId),
    employeeId != null ? listEmployeeAccessDepartmentIds(employeeId) : Promise.resolve([]),
  ]);

  return uniqueDepartmentIds([
    ...userDepartmentIds,
    ...employeeDepartmentIds,
  ]);
}

export async function listManagedDepartmentIdsForUser(
  userId: string,
  primaryDepartmentId?: string | null,
  employeeId?: number | null,
): Promise<string[]> {
  const explicitDepartmentIds = await listExplicitDepartmentIdsForUser(userId, employeeId);
  return uniqueDepartmentIds([primaryDepartmentId ?? null, ...explicitDepartmentIds]);
}

export async function loadManagedDepartmentMap(
  seeds: IUserManagedDepartmentSeed[],
): Promise<Map<string, IUserManagedDepartments>> {
  const result = new Map<string, IUserManagedDepartments>(
    seeds.map(seed => [
      seed.user_id,
      {
        primary_department_id: seed.primary_department_id ?? null,
        managed_department_ids: uniqueDepartmentIds([seed.primary_department_id ?? null]),
      },
    ]),
  );

  const explicitMap = await loadExplicitDepartmentMap(seeds);
  for (const seed of seeds) {
    const current = result.get(seed.user_id);
    if (!current) continue;

    current.managed_department_ids = uniqueDepartmentIds([
      current.primary_department_id,
      ...(explicitMap.get(seed.user_id) || []),
    ]);
  }

  return result;
}
