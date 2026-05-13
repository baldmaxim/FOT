import { query, queryOne, withTransaction } from '../config/postgres.js';
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
  try {
    return await queryOne<IArchiveDepartmentRow>(
      `SELECT id, name, sigur_department_id, parent_id, is_active
         FROM org_departments
        WHERE id = $1 AND is_active = true
        LIMIT 1`,
      [id],
    );
  } catch {
    return null;
  }
}

async function loadDepartmentBySigurId(sigurDepartmentId: number): Promise<IArchiveDepartmentRow | null> {
  try {
    return await queryOne<IArchiveDepartmentRow>(
      `SELECT id, name, sigur_department_id, parent_id, is_active
         FROM org_departments
        WHERE sigur_department_id = $1 AND is_active = true
        LIMIT 1`,
      [sigurDepartmentId],
    );
  } catch {
    return null;
  }
}

async function loadDepartmentByName(name: string): Promise<IArchiveDepartmentRow | null> {
  let rows: IArchiveDepartmentRow[];
  try {
    rows = await query<IArchiveDepartmentRow>(
      `SELECT id, name, sigur_department_id, parent_id, is_active
         FROM org_departments
        WHERE name = $1 AND is_active = true
        ORDER BY parent_id ASC NULLS FIRST`,
      [name],
    );
  } catch {
    return null;
  }
  if (rows.length === 0) return null;
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

  const createdRow = await queryOne<IArchiveDepartmentRow>(
    `INSERT INTO org_departments (parent_id, name, description)
     VALUES ($1, $2, $3)
     RETURNING id, name, sigur_department_id, parent_id, is_active`,
    [null, DEFAULT_ARCHIVE_DEPARTMENT_NAME, LOCAL_ARCHIVE_DEPARTMENT_DESCRIPTION],
  );

  if (!createdRow) {
    throw new Error('Не удалось создать локальный архивный отдел');
  }

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

  await withTransaction(async (client) => {
    await client.query(
      `UPDATE employees
          SET org_department_id = $1,
              department_locked = false,
              updated_at = $2
        WHERE id = ANY($3::int[])`,
      [archiveDepartmentId, new Date().toISOString(), uniqueIds],
    );

    await client.query(
      `UPDATE employee_assignments
          SET effective_to = $1
        WHERE employee_id = ANY($2::int[])
          AND effective_to IS NULL`,
      [effectiveDate, uniqueIds],
    );
  });

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
  const rows = await query<IEmployeeArchiveRow>(
    `SELECT id, org_department_id
       FROM employees
      WHERE employment_status = 'fired'
        AND is_archived = false`,
  );

  const employeeIdsToMove = rows
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
