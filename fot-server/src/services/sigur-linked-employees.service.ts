import { supabase } from '../config/database.js';
import { parseFIO } from '../utils/fio.utils.js';
import { employeeCache } from './employee-cache.service.js';
import { invalidateStructureCache } from './employee-mapper.service.js';
import { settingsService } from './settings.service.js';
import { sigurService } from './sigur.service.js';
import { createCache } from '../utils/cache.js';
import {
  normalizeDepartment,
  normalizeEmployee,
  resolveField,
} from './sigur-sync-shared.js';
import type { ConnectionType } from './sigur-base.service.js';

interface ILinkedEmployeeRow {
  id: number;
  sigur_employee_id: number | null;
  org_department_id: string | null;
  position_id: string | null;
  tab_number: string | null;
  full_name: string | null;
  last_name: string | null;
  first_name: string | null;
  middle_name: string | null;
  employment_status: 'active' | 'fired';
  department_locked: boolean;
  name_locked: boolean;
}

interface IAccessPointBinding {
  employeeId: number;
  accessPointId: number;
}

const EMPLOYEE_ACCESS_POINT_BINDINGS_CACHE_TTL_MS = 5 * 60 * 1000;
const employeeAccessPointBindingsCache = createCache<{ bindings: Array<{ accessPointId: number; accessPointName: string | null }> }>({
  max: 1000,
  ttlMs: EMPLOYEE_ACCESS_POINT_BINDINGS_CACHE_TTL_MS,
});
const employeeAccessPointBindingsInFlight = new Map<string, Promise<Array<{ accessPointId: number; accessPointName: string | null }>>>();

const LINKED_EMPLOYEE_COLUMNS = [
  'id',
  'sigur_employee_id',
  'org_department_id',
  'position_id',
  'tab_number',
  'full_name',
  'last_name',
  'first_name',
  'middle_name',
  'employment_status',
  'department_locked',
  'name_locked',
].join(', ');

const normalizeName = (value: string | null | undefined): string => (value || '').trim().toLowerCase();
const buildEmployeeAccessPointBindingsCacheKey = (
  employeeId: number,
  connection?: ConnectionType,
): string => `${employeeId}:${connection || 'default'}`;

async function getRootDepartmentId(): Promise<string | null> {
  const { data: namedRoot } = await supabase
    .from('org_departments')
    .select('id')
    .eq('name', 'Объект')
    .limit(1)
    .maybeSingle();

  if (namedRoot?.id) return namedRoot.id;

  const { data: anyRoot } = await supabase
    .from('org_departments')
    .select('id')
    .is('parent_id', null)
    .limit(1)
    .maybeSingle();

  return anyRoot?.id || null;
}

async function getLinkedEmployeeRow(employeeId: number): Promise<ILinkedEmployeeRow | null> {
  const { data, error } = await supabase
    .from('employees')
    .select(LINKED_EMPLOYEE_COLUMNS)
    .eq('id', employeeId)
    .maybeSingle();

  if (error) throw error;
  return (data as ILinkedEmployeeRow | null) ?? null;
}

export async function ensureLocalSigurDepartment(
  sigurDepartmentId: number | null | undefined,
  connection?: ConnectionType,
): Promise<string | null> {
  if (!sigurDepartmentId || !Number.isFinite(sigurDepartmentId)) return null;

  const { data: existing, error: existingError } = await supabase
    .from('org_departments')
    .select('id, name')
    .eq('sigur_department_id', sigurDepartmentId)
    .maybeSingle();

  if (existingError) throw existingError;
  if (existing?.id) return existing.id;

  const remoteDepartment = normalizeDepartment(
    await sigurService.getDepartmentById(sigurDepartmentId, connection),
  );

  const parentId = remoteDepartment.parentId && remoteDepartment.parentId > 0
    ? await ensureLocalSigurDepartment(remoteDepartment.parentId, connection)
    : await getRootDepartmentId();

  const { data: created, error: insertError } = await supabase
    .from('org_departments')
    .insert({
      name: remoteDepartment.name || `Sigur отдел ${sigurDepartmentId}`,
      parent_id: parentId,
      sigur_department_id: sigurDepartmentId,
    })
    .select('id')
    .single();

  if (insertError) throw insertError;

  invalidateStructureCache();
  return created.id;
}

export async function ensureLocalSigurPosition(
  sigurPositionId: number | null | undefined,
  positionName: string | null | undefined,
  connection?: ConnectionType,
): Promise<string | null> {
  const normalizedPositionName = (positionName || '').trim();

  if (sigurPositionId && Number.isFinite(sigurPositionId)) {
    const { data: bySigurId, error: bySigurIdError } = await supabase
      .from('positions')
      .select('id, name')
      .eq('sigur_position_id', sigurPositionId)
      .maybeSingle();

    if (bySigurIdError) throw bySigurIdError;
    if (bySigurId?.id) return bySigurId.id;
  }

  if (normalizedPositionName) {
    const { data: byNameRows, error: byNameError } = await supabase
      .from('positions')
      .select('id, name, sigur_position_id')
      .ilike('name', normalizedPositionName)
      .limit(1);

    if (byNameError) throw byNameError;

    const byName = byNameRows?.[0];
    if (byName?.id) {
      if (sigurPositionId && !byName.sigur_position_id) {
        await supabase
          .from('positions')
          .update({ sigur_position_id: sigurPositionId })
          .eq('id', byName.id);
      }
      return byName.id;
    }
  }

  let resolvedName = normalizedPositionName;
  if (!resolvedName && sigurPositionId) {
    const positions = await sigurService.getPositions(connection);
    const remotePosition = (positions || []).find(position => resolveField<number>(position, 'id', 'ID', 'Id') === sigurPositionId);
    resolvedName = (resolveField<string>(remotePosition || {}, 'name', 'Name', 'title') || '').trim();
  }

  if (!resolvedName) return null;

  const { data: created, error: insertError } = await supabase
    .from('positions')
    .insert({
      name: resolvedName,
      sigur_position_id: sigurPositionId || null,
      is_active: true,
      sort_order: 0,
    })
    .select('id')
    .single();

  if (insertError) throw insertError;

  invalidateStructureCache();
  return created.id;
}

export async function syncLinkedEmployeeFromSigur(
  employeeId: number,
  connection?: ConnectionType,
  options: { clearDepartmentLock?: boolean } = {},
): Promise<{
  fullName: string;
  orgDepartmentId: string | null;
  positionId: string | null;
  tabNumber: string | null;
  sigurEmployeeId: number;
}> {
  const employee = await getLinkedEmployeeRow(employeeId);
  if (!employee?.sigur_employee_id) {
    throw new Error('Сотрудник не связан с Sigur');
  }

  const remoteEmployee = normalizeEmployee(
    await sigurService.getEmployeeById(employee.sigur_employee_id, connection),
  );

  const remoteFullName = (remoteEmployee.name || employee.full_name || '').trim();
  const tabNumber = remoteEmployee.tabId ? remoteEmployee.tabId.trim() : null;
  const orgDepartmentId = await ensureLocalSigurDepartment(remoteEmployee.departmentId || null, connection);
  const positionId = await ensureLocalSigurPosition(remoteEmployee.positionId || null, remoteEmployee.position || '', connection);

  const updateData: Record<string, unknown> = {
    org_department_id: orgDepartmentId,
    position_id: positionId,
    tab_number: tabNumber,
    updated_at: new Date().toISOString(),
  };

  if (!employee.name_locked) {
    const fio = parseFIO(remoteFullName);
    updateData.full_name = remoteFullName;
    updateData.last_name = fio.lastName || null;
    updateData.first_name = fio.firstName || null;
    updateData.middle_name = fio.middleName || null;
  }

  const fullName = employee.name_locked ? (employee.full_name || remoteFullName) : remoteFullName;

  if (options.clearDepartmentLock !== false) {
    updateData.department_locked = false;
  }

  const { error: updateError } = await supabase
    .from('employees')
    .update(updateData)
    .eq('id', employeeId);

  if (updateError) throw updateError;

  employeeCache.invalidate(employeeId);

  return {
    fullName,
    orgDepartmentId,
    positionId,
    tabNumber,
    sigurEmployeeId: employee.sigur_employee_id,
  };
}

export async function ensureSigurPosition(
  positionName: string,
  connection?: ConnectionType,
): Promise<{ sigurPositionId: number; localPositionId: string | null; name: string }> {
  const normalizedName = positionName.trim();
  if (!normalizedName) throw new Error('Название должности обязательно');

  const positions = await sigurService.getPositions(connection);
  const existingPosition = (positions || []).find(position => (
    normalizeName(resolveField<string>(position, 'name', 'Name', 'title')) === normalizeName(normalizedName)
  ));

  let sigurPositionId = resolveField<number>(existingPosition || {}, 'id', 'ID', 'Id') || null;

  if (!sigurPositionId) {
    const created = await sigurService.createPosition({ name: normalizedName }, connection);
    sigurPositionId = resolveField<number>(created, 'id', 'ID', 'Id') || null;
  }

  if (!sigurPositionId) {
    throw new Error('Не удалось создать или найти должность в Sigur');
  }

  const localPositionId = await ensureLocalSigurPosition(sigurPositionId, normalizedName, connection);
  return { sigurPositionId, localPositionId, name: normalizedName };
}

export async function ensureArchiveSigurDepartment(
  userId: string,
  connection?: ConnectionType,
): Promise<{ sigurDepartmentId: number; localDepartmentId: string | null; name: string }> {
  const settings = await settingsService.getSigurConnectionSettings();
  let sigurDepartmentId = settings.archiveDepartmentId;
  let name = settings.archiveDepartmentName || 'Уволенные';

  if (sigurDepartmentId) {
    try {
      const remoteDepartment = normalizeDepartment(
        await sigurService.getDepartmentById(sigurDepartmentId, connection),
      );
      name = remoteDepartment.name || name;
    } catch {
      sigurDepartmentId = null;
    }
  }

  if (!sigurDepartmentId) {
    const created = await sigurService.createDepartment({
      name,
      parentId: 0,
    }, connection);
    sigurDepartmentId = resolveField<number>(created, 'id', 'ID', 'Id') || null;
    name = (resolveField<string>(created, 'name', 'Name', 'title') || name).trim();

    if (!sigurDepartmentId) {
      throw new Error('Не удалось создать архивный отдел в Sigur');
    }
  }

  const localDepartmentId = await ensureLocalSigurDepartment(sigurDepartmentId, connection);

  await settingsService.setSigurConnectionSettings({
    archiveDepartmentId: sigurDepartmentId,
    archiveDepartmentName: name,
  }, userId);

  return {
    sigurDepartmentId,
    localDepartmentId,
    name,
  };
}

function normalizeBinding(raw: Record<string, unknown>): IAccessPointBinding | null {
  const employeeId = resolveField<number>(raw, 'employeeId', 'employee_id');
  const accessPointId = resolveField<number>(
    raw,
    'accessPointId',
    'accesspointId',
    'access_point_id',
    'accessPointID',
  );

  if (!employeeId || !accessPointId) return null;
  return { employeeId, accessPointId };
}

export async function getEmployeeAccessPointBindings(
  employeeId: number,
  connection?: ConnectionType,
  refresh = false,
): Promise<Array<{ accessPointId: number; accessPointName: string | null }>> {
  const cacheKey = buildEmployeeAccessPointBindingsCacheKey(employeeId, connection);

  if (!refresh) {
    const cached = employeeAccessPointBindingsCache.get(cacheKey);
    if (cached) {
      return cached.bindings;
    }
  }

  const inFlight = employeeAccessPointBindingsInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const loadPromise = Promise.all([
    sigurService.getEmployeeAccessPointBindings({ employeeId }, connection),
    sigurService.getAccessPointMapCached(connection),
  ])
    .then(([bindings, accessPointMap]) => bindings
      .map(binding => normalizeBinding(binding))
      .filter((binding): binding is IAccessPointBinding => !!binding && binding.employeeId === employeeId)
      .map(binding => ({
        accessPointId: binding.accessPointId,
        accessPointName: accessPointMap.get(binding.accessPointId) || null,
      }))
      .sort((left, right) => {
        const byName = (left.accessPointName || '').localeCompare(right.accessPointName || '', 'ru');
        return byName !== 0 ? byName : left.accessPointId - right.accessPointId;
      }))
    .then(bindings => {
      employeeAccessPointBindingsCache.set(cacheKey, { bindings });
      return bindings;
    })
    .finally(() => {
      employeeAccessPointBindingsInFlight.delete(cacheKey);
    });

  employeeAccessPointBindingsInFlight.set(cacheKey, loadPromise);
  return loadPromise;
}

export function invalidateEmployeeAccessPointBindingsCache(employeeId: number): void {
  for (const connectionKey of ['default', 'internal', 'external']) {
    const key = `${employeeId}:${connectionKey}`;
    employeeAccessPointBindingsCache.delete(key);
    employeeAccessPointBindingsInFlight.delete(key);
  }
}

export async function replaceEmployeeAccessPointBindings(
  employeeId: number,
  accessPointIds: number[],
  connection?: ConnectionType,
): Promise<{
  addedIds: number[];
  removedIds: number[];
  bindings: Array<{ accessPointId: number; accessPointName: string | null }>;
}> {
  // refresh=true: читаем актуальное состояние Sigur, не из 5-мин кэша. Иначе при устаревшем
  // кэше POST add может уйти на уже существующую привязку (Sigur → 400 invalid.request),
  // либо POST delete — на уже удалённую.
  invalidateEmployeeAccessPointBindingsCache(employeeId);
  const currentBindings = await getEmployeeAccessPointBindings(employeeId, connection, true);
  const currentIds = new Set(currentBindings.map(binding => binding.accessPointId));
  const nextIds = new Set(accessPointIds.filter(id => Number.isFinite(id)));

  const addedIds = [...nextIds].filter(id => !currentIds.has(id)).sort((a, b) => a - b);
  const removedIds = [...currentIds].filter(id => !nextIds.has(id)).sort((a, b) => a - b);

  if (removedIds.length > 0) {
    await sigurService.deleteEmployeeAccessPointBindings([employeeId], removedIds, connection);
  }

  if (addedIds.length > 0) {
    await sigurService.createEmployeeAccessPointBindings([employeeId], addedIds, connection);
  }

  invalidateEmployeeAccessPointBindingsCache(employeeId);
  const bindings = await getEmployeeAccessPointBindings(employeeId, connection, true);

  return {
    addedIds,
    removedIds,
    bindings,
  };
}
