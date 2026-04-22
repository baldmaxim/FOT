import { supabase } from '../config/database.js';
import { invalidateDeptTreeCache } from './skud-shared.service.js';
import { settingsService } from './settings.service.js';
import { ensureLocalSigurDepartment } from './sigur-linked-employees.service.js';
import { employeeCache } from './employee-cache.service.js';
import { deactivateAllDepartmentAccessForEmployee } from './employee-department-access.service.js';
import type { ConnectionType } from './sigur.service.js';

const LOCAL_ARCHIVE_DEPARTMENT_ID_KEY = 'employees_archive_department_id';
const LOCAL_ARCHIVE_DEPARTMENT_NAME_KEY = 'employees_archive_department_name';
const LOCAL_ARCHIVE_DEPARTMENT_DESCRIPTION = 'Системный архивный отдел для уволенных сотрудников';

export const DEFAULT_ARCHIVE_DEPARTMENT_NAME = 'Уволенные';

interface IArchiveDepartmentRow {
  id: string;
  name: string;
  sigur_department_id: number | null;
  parent_id: string | null;
  is_active: boolean;
}

export interface IResolvedArchiveDepartment {
  id: string;
  name: string;
  source: 'local' | 'sigur';
  sigurDepartmentId: number | null;
}

interface IEmployeeArchiveRow {
  id: number;
  org_department_id: string | null;
}

async function loadDepartmentById(id: string): Promise<IArchiveDepartmentRow | null> {
  const { data, error } = await supabase
    .from('org_departments')
    .select('id, name, sigur_department_id, parent_id, is_active')
    .eq('id', id)
    .eq('is_active', true)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data as IArchiveDepartmentRow;
}

async function loadDepartmentBySigurId(sigurDepartmentId: number): Promise<IArchiveDepartmentRow | null> {
  const { data, error } = await supabase
    .from('org_departments')
    .select('id, name, sigur_department_id, parent_id, is_active')
    .eq('sigur_department_id', sigurDepartmentId)
    .eq('is_active', true)
    .maybeSingle();

  if (error || !data) {
    return null;
  }

  return data as IArchiveDepartmentRow;
}

async function loadDepartmentByName(name: string): Promise<IArchiveDepartmentRow | null> {
  const { data, error } = await supabase
    .from('org_departments')
    .select('id, name, sigur_department_id, parent_id, is_active')
    .eq('name', name)
    .eq('is_active', true)
    .order('parent_id', { ascending: true });

  if (error || !data || data.length === 0) {
    return null;
  }

  const rows = data as IArchiveDepartmentRow[];
  return rows.find(row => row.parent_id === null) || rows[0] || null;
}

async function persistLocalArchiveDepartment(row: IArchiveDepartmentRow, userId?: string | null): Promise<void> {
  if (!userId) {
    return;
  }

  await settingsService.setMultiple([
    {
      key: LOCAL_ARCHIVE_DEPARTMENT_ID_KEY,
      value: row.id,
      description: 'Local archive department ID for fired employees',
    },
    {
      key: LOCAL_ARCHIVE_DEPARTMENT_NAME_KEY,
      value: row.name,
      description: 'Local archive department name for fired employees',
    },
  ], userId);
}

export async function getKnownArchiveDepartment(
  connection?: ConnectionType,
): Promise<IResolvedArchiveDepartment | null> {
  const sigurSettings = await settingsService.getSigurConnectionSettings();
  if (sigurSettings.archiveDepartmentId) {
    const bySigurId = await loadDepartmentBySigurId(sigurSettings.archiveDepartmentId)
      || await (async () => {
        const localId = await ensureLocalSigurDepartment(sigurSettings.archiveDepartmentId, connection).catch(() => null);
        return localId ? loadDepartmentById(localId) : null;
      })();

    if (bySigurId) {
      return {
        id: bySigurId.id,
        name: bySigurId.name,
        source: 'sigur',
        sigurDepartmentId: bySigurId.sigur_department_id,
      };
    }
  }

  const [storedLocalId, storedLocalName] = await Promise.all([
    settingsService.get(LOCAL_ARCHIVE_DEPARTMENT_ID_KEY),
    settingsService.get(LOCAL_ARCHIVE_DEPARTMENT_NAME_KEY),
  ]);

  if (storedLocalId) {
    const byId = await loadDepartmentById(storedLocalId);
    if (byId) {
      return {
        id: byId.id,
        name: byId.name,
        source: 'local',
        sigurDepartmentId: byId.sigur_department_id,
      };
    }
  }

  const fallbackName = (storedLocalName || DEFAULT_ARCHIVE_DEPARTMENT_NAME).trim() || DEFAULT_ARCHIVE_DEPARTMENT_NAME;
  const byName = await loadDepartmentByName(fallbackName);
  if (!byName) {
    return null;
  }

  return {
    id: byName.id,
    name: byName.name,
    source: byName.sigur_department_id ? 'sigur' : 'local',
    sigurDepartmentId: byName.sigur_department_id,
  };
}

export async function ensureLocalArchiveDepartment(
  userId?: string | null,
  options: { connection?: ConnectionType } = {},
): Promise<IResolvedArchiveDepartment> {
  const existing = await getKnownArchiveDepartment(options.connection);
  if (existing) {
    const existingRow = await loadDepartmentById(existing.id);
    if (existingRow) {
      await persistLocalArchiveDepartment(existingRow, userId);
    }
    return existing;
  }

  const { data, error } = await supabase
    .from('org_departments')
    .insert({
      parent_id: null,
      name: DEFAULT_ARCHIVE_DEPARTMENT_NAME,
      description: LOCAL_ARCHIVE_DEPARTMENT_DESCRIPTION,
    })
    .select('id, name, sigur_department_id, parent_id, is_active')
    .single();

  if (error || !data) {
    throw new Error(error?.message || 'Не удалось создать локальный архивный отдел');
  }

  const createdRow = data as IArchiveDepartmentRow;
  invalidateDeptTreeCache();
  await persistLocalArchiveDepartment(createdRow, userId);

  return {
    id: createdRow.id,
    name: createdRow.name,
    source: 'local',
    sigurDepartmentId: createdRow.sigur_department_id,
  };
}

export async function isProtectedArchiveDepartment(
  departmentId: string | null | undefined,
  connection?: ConnectionType,
): Promise<boolean> {
  if (!departmentId) {
    return false;
  }

  const archiveDepartment = await getKnownArchiveDepartment(connection);
  return archiveDepartment?.id === departmentId;
}

async function moveEmployeesIntoArchiveDepartment(
  employeeIds: number[],
  archiveDepartmentId: string,
  effectiveDate: string,
): Promise<number[]> {
  const uniqueIds = Array.from(new Set(employeeIds.map(id => Number(id)).filter(id => Number.isFinite(id) && id > 0)));
  if (uniqueIds.length === 0) {
    return [];
  }

  const { error: updateEmployeesError } = await supabase
    .from('employees')
    .update({
      org_department_id: archiveDepartmentId,
      department_locked: false,
      updated_at: new Date().toISOString(),
    })
    .in('id', uniqueIds);

  if (updateEmployeesError) {
    throw new Error(updateEmployeesError.message);
  }

  await supabase
    .from('employee_assignments')
    .update({ effective_to: effectiveDate })
    .in('employee_id', uniqueIds)
    .is('effective_to', null);

  for (const id of uniqueIds) {
    try {
      await deactivateAllDepartmentAccessForEmployee(id);
    } catch (err) {
      console.warn(`[archive] deactivate access for ${id} failed:`, err);
    }
  }

  uniqueIds.forEach(id => employeeCache.invalidate(id));
  return uniqueIds;
}

export async function assignEmployeesToArchiveDepartment(
  employeeIds: number[],
  userId?: string | null,
  options: { connection?: ConnectionType; effectiveDate?: string } = {},
): Promise<{ archiveDepartmentId: string; movedEmployeeIds: number[] }> {
  const archiveDepartment = await ensureLocalArchiveDepartment(userId, { connection: options.connection });
  const movedEmployeeIds = await moveEmployeesIntoArchiveDepartment(
    employeeIds,
    archiveDepartment.id,
    options.effectiveDate || new Date().toISOString().slice(0, 10),
  );

  return {
    archiveDepartmentId: archiveDepartment.id,
    movedEmployeeIds,
  };
}

export async function reconcileFiredEmployeesArchiveDepartment(
  userId?: string | null,
  options: { connection?: ConnectionType } = {},
): Promise<{ archiveDepartmentId: string; movedEmployeeIds: number[] }> {
  const archiveDepartment = await ensureLocalArchiveDepartment(userId, { connection: options.connection });
  const { data, error } = await supabase
    .from('employees')
    .select('id, org_department_id')
    .eq('employment_status', 'fired')
    .eq('is_archived', false);

  if (error) {
    throw new Error(error.message);
  }

  const employeeIdsToMove = ((data || []) as IEmployeeArchiveRow[])
    .filter(employee => employee.org_department_id !== archiveDepartment.id)
    .map(employee => employee.id);

  const movedEmployeeIds = await moveEmployeesIntoArchiveDepartment(
    employeeIdsToMove,
    archiveDepartment.id,
    new Date().toISOString().slice(0, 10),
  );

  return {
    archiveDepartmentId: archiveDepartment.id,
    movedEmployeeIds,
  };
}
