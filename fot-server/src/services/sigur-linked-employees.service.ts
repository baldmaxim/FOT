import { queryOne, execute } from '../config/postgres.js';
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
  const namedRoot = await queryOne<{ id: string }>(
    "SELECT id FROM org_departments WHERE name = 'Объект' LIMIT 1",
  );

  if (namedRoot?.id) return namedRoot.id;

  const anyRoot = await queryOne<{ id: string }>(
    'SELECT id FROM org_departments WHERE parent_id IS NULL LIMIT 1',
  );

  return anyRoot?.id || null;
}

async function getLinkedEmployeeRow(employeeId: number): Promise<ILinkedEmployeeRow | null> {
  const data = await queryOne<ILinkedEmployeeRow>(
    `SELECT ${LINKED_EMPLOYEE_COLUMNS} FROM employees WHERE id = $1 LIMIT 1`,
    [employeeId],
  );
  return data;
}

export async function ensureLocalSigurDepartment(
  sigurDepartmentId: number | null | undefined,
  connection?: ConnectionType,
): Promise<string | null> {
  if (!sigurDepartmentId || !Number.isFinite(sigurDepartmentId)) return null;

  const existing = await queryOne<{ id: string; name: string | null }>(
    'SELECT id, name FROM org_departments WHERE sigur_department_id = $1 LIMIT 1',
    [sigurDepartmentId],
  );

  if (existing?.id) return existing.id;

  const remoteDepartment = normalizeDepartment(
    await sigurService.getDepartmentById(sigurDepartmentId, connection),
  );

  const parentId = remoteDepartment.parentId && remoteDepartment.parentId > 0
    ? await ensureLocalSigurDepartment(remoteDepartment.parentId, connection)
    : await getRootDepartmentId();

  const created = await queryOne<{ id: string }>(
    `INSERT INTO org_departments (name, parent_id, sigur_department_id)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [
      remoteDepartment.name || `Sigur отдел ${sigurDepartmentId}`,
      parentId,
      sigurDepartmentId,
    ],
  );
  if (!created) throw new Error('Не удалось создать локальный отдел');

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
    const bySigurId = await queryOne<{ id: string; name: string | null }>(
      'SELECT id, name FROM positions WHERE sigur_position_id = $1 LIMIT 1',
      [sigurPositionId],
    );
    if (bySigurId?.id) return bySigurId.id;
  }

  if (normalizedPositionName) {
    const byName = await queryOne<{ id: string; name: string | null; sigur_position_id: number | null }>(
      'SELECT id, name, sigur_position_id FROM positions WHERE name ILIKE $1 LIMIT 1',
      [normalizedPositionName],
    );

    if (byName?.id) {
      if (sigurPositionId && !byName.sigur_position_id) {
        await execute(
          'UPDATE positions SET sigur_position_id = $1 WHERE id = $2',
          [sigurPositionId, byName.id],
        );
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

  const created = await queryOne<{ id: string }>(
    `INSERT INTO positions (name, sigur_position_id, is_active, sort_order)
     VALUES ($1, $2, true, 0)
     RETURNING id`,
    [resolvedName, sigurPositionId || null],
  );
  if (!created) throw new Error('Не удалось создать должность');

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

  // Динамический UPDATE по ключам updateData
  const updateKeys = Object.keys(updateData);
  if (updateKeys.length > 0) {
    const setParts: string[] = [];
    const params: unknown[] = [];
    for (const key of updateKeys) {
      params.push(updateData[key]);
      setParts.push(`${key} = $${params.length}`);
    }
    params.push(employeeId);
    await execute(
      `UPDATE employees SET ${setParts.join(', ')} WHERE id = $${params.length}`,
      params,
    );
  }

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
  userId: string | null,
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

interface ICardBindingSnapshot {
  cardId: number;
  startDate: string | null;
  expirationDate: string | null;
  format: string | null;
}

export interface ICardConflict {
  cardId: number;
  boundToEmployeeId: number | null;
  reason: 'bound_to_other' | 'missing_dates';
}

const normalizeCardInt = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
};

const readCardId = (raw: Record<string, unknown>): number | null =>
  normalizeCardInt(resolveField(raw, 'cardId', 'card_id', 'cardID', 'cardid', 'id', 'ID', 'Id'));

const toCardBindingSnapshot = (raw: Record<string, unknown>): ICardBindingSnapshot | null => {
  const cardId = readCardId(raw);
  if (!cardId) return null;
  return {
    cardId,
    startDate: String(resolveField<string>(raw, 'startDate', 'start_date', 'validFrom', 'startAt') || '').trim() || null,
    expirationDate: String(
      resolveField<string>(raw, 'expirationDate', 'expiration_date', 'expiresAt', 'expiryDate', 'validTo') || '',
    ).trim() || null,
    format: String(resolveField<string>(raw, 'format', 'Format', 'cardFormat') || '').trim() || null,
  };
};

// employeeId владельца привязки карты (учёт holder-обёртки, как в sigur-live-cards).
const readCardBindingEmployeeId = (raw: Record<string, unknown>): number | null => {
  const direct = normalizeCardInt(resolveField(raw, 'employeeId', 'employee_id'));
  if (direct) return direct;
  const holder = raw.holder;
  if (holder && typeof holder === 'object') {
    const holderObj = holder as Record<string, unknown>;
    const type = typeof holderObj.type === 'string' ? holderObj.type.toUpperCase() : '';
    if (!type || type === 'EMP' || type === 'EMPLOYEE') {
      const holderId = normalizeCardInt(resolveField(holderObj, 'holderId', 'holder_id', 'id'));
      if (holderId) return holderId;
    }
  }
  return null;
};

export async function replaceEmployeeAccessPointBindings(
  employeeId: number,
  accessPointIds: number[],
  connection?: ConnectionType,
): Promise<{
  addedIds: number[];
  removedIds: number[];
  bindings: Array<{ accessPointId: number; accessPointName: string | null }>;
  restoredCardIds: number[];
  cardConflicts: ICardConflict[];
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

  // Sigur 1.6.3.14: POST /bindings/employees-accesspoints как побочный эффект сбрасывает
  // привязку карты сотрудника. Снимаем снапшот карт ДО мутации и восстанавливаем пропавшие
  // ПОСЛЕ — точными датами/форматом. Логика стоит на общем чокпоинте, поэтому покрывает
  // ВСЕ пути сохранения точек (админский, контрагентский, прямой sigur.controller).
  const cardsBefore = (await sigurService.getCardBindings({ employeeId }, connection) as Record<string, unknown>[])
    .map(toCardBindingSnapshot)
    .filter((card): card is ICardBindingSnapshot => !!card);

  if (removedIds.length > 0) {
    await sigurService.deleteEmployeeAccessPointBindings([employeeId], removedIds, connection);
  }

  if (addedIds.length > 0) {
    await sigurService.createEmployeeAccessPointBindings([employeeId], addedIds, connection);
  }

  const restoredCardIds: number[] = [];
  const cardConflicts: ICardConflict[] = [];

  if (cardsBefore.length > 0) {
    const cardsAfterRaw = await sigurService.getCardBindings({ employeeId }, connection) as Record<string, unknown>[];
    const cardIdsAfter = new Set(
      cardsAfterRaw.map(readCardId).filter((id): id is number => !!id),
    );
    const lostCards = cardsBefore.filter(card => !cardIdsAfter.has(card.cardId));

    for (const card of lostCards) {
      // Защита от гонки/чужой привязки: карта могла за это время уехать к другому сотруднику.
      const cardOwners = await sigurService.getCardBindings({ cardId: card.cardId }, connection) as Record<string, unknown>[];
      const owner = cardOwners.map(readCardBindingEmployeeId).find((id): id is number => !!id) ?? null;
      if (owner && owner !== employeeId) {
        console.error(
          `[access-points] карта ${card.cardId} после правки точек оказалась у сотрудника ${owner}; не восстанавливаем (целевой ${employeeId})`,
        );
        cardConflicts.push({ cardId: card.cardId, boundToEmployeeId: owner, reason: 'bound_to_other' });
        continue;
      }
      if (!card.startDate || !card.expirationDate) {
        console.error(
          `[access-points] карта ${card.cardId} слетела у ${employeeId}, но в снапшоте нет дат — авто-восстановление пропущено`,
        );
        cardConflicts.push({ cardId: card.cardId, boundToEmployeeId: null, reason: 'missing_dates' });
        continue;
      }
      await sigurService.createEmployeeCardBinding(
        employeeId,
        card.cardId,
        card.startDate,
        card.expirationDate,
        connection,
        card.format ?? undefined,
      );
      restoredCardIds.push(card.cardId);
      console.warn(
        `[access-points] восстановлена привязка карты ${card.cardId} сотруднику ${employeeId} после правки точек доступа`,
      );
    }

    if (restoredCardIds.length > 0) {
      sigurService.invalidateCardListCache();
      // Ленивый импорт: исключает статический цикл sigur-linked-employees ↔ sigur-live-admin.
      const { invalidateSigurDirectoryCaches } = await import('./sigur-live-admin.service.js');
      invalidateSigurDirectoryCaches();
    }
  }

  invalidateEmployeeAccessPointBindingsCache(employeeId);
  const bindings = await getEmployeeAccessPointBindings(employeeId, connection, true);

  return {
    addedIds,
    removedIds,
    bindings,
    restoredCardIds,
    cardConflicts,
  };
}
