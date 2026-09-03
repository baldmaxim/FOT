/**
 * Sigur live admin — CRUD отделов (departments) + рекурсивное удаление с переносом сотрудников.
 *
 * Извлечено из sigur-live-admin.service.ts (Волна 3 декомпозиции).
 * Содержит 5 публичных операций над departments + локальный helper
 * moveDirectDepartmentEmployees.
 *
 * Helpers (normalizeInt / invalidateSigurDirectoryCaches / getNormalizedDepartments /
 * normalizeDepartmentIds / collapseNestedDepartmentSelection /
 * collectAncestorDepartmentIds / collectSigurDepartmentDescendantIds) импортируются
 * как public exports из основного sigur-live-admin — они используются в getSigur*
 * listings и в structure-tree.
 */
import { queryOne } from '../config/postgres.js';
import { sigurService } from './sigur.service.js';
import { normalizeDepartment, resolveField } from './sigur-sync-shared.js';
import type { ConnectionType } from './sigur-base.service.js';
import {
  deactivateMirroredDepartments,
  requestDepartmentsMirrorRefresh,
  runDepartmentsMirrorRefreshNow,
} from './sigur-structure-refresh.service.js';
import {
  collapseNestedDepartmentSelection,
  collectAncestorDepartmentIds,
  collectSigurDepartmentDescendantIds,
  getNormalizedDepartments,
  invalidateSigurDirectoryCaches,
  normalizeDepartmentIds,
  normalizeInt,
  type ISigurDepartmentNode,
  type ISigurDepartmentUpsertInput,
} from './sigur-live-admin.service.js';

/** Статус зеркала для только что изменённого в Sigur отдела. */
export interface IMirrorReadyState {
  /** Локальная строка org_departments готова: отдел активен и им можно пользоваться. */
  mirrorReady: boolean;
  /** Почему не готов: timeout | runtime_guard | not_mirrored | not_assignable. */
  mirrorReason?: string;
}

/**
 * Дожидается появления отдела в зеркале и проверяет строку.
 *
 * Без этого ответ «отдел создан» приходил раньше зеркала: в org_departments
 * отдела ещё нет, добавление сотрудника падает, и со стороны это выглядит как
 * «получилось только со второй попытки».
 */
async function ensureDepartmentMirrored(
  sigurDepartmentId: number,
  connection?: ConnectionType,
): Promise<IMirrorReadyState> {
  const refresh = await runDepartmentsMirrorRefreshNow('admin_crud', connection);

  const row = await queryOne<{ id: string; is_active: boolean; is_assignable: boolean }>(
    'SELECT id, is_active, is_assignable FROM org_departments WHERE sigur_department_id = $1 LIMIT 1',
    [sigurDepartmentId],
  );

  if (row?.is_active) {
    // is_assignable=false — законное состояние (отдел вне фильтра синхронизации):
    // зеркало готово, но назначать в него нельзя. Сообщаем причину отдельно.
    return row.is_assignable
      ? { mirrorReady: true }
      : { mirrorReady: true, mirrorReason: 'not_assignable' };
  }

  const reason = refresh.ok ? 'not_mirrored' : refresh.reason ?? 'unknown';
  console.warn(`[sigur-crud] отдел ${sigurDepartmentId} не появился в зеркале: ${reason}`);
  return { mirrorReady: false, mirrorReason: reason };
}

export async function createSigurDepartment(
  input: ISigurDepartmentUpsertInput,
  connection?: ConnectionType,
): Promise<ISigurDepartmentNode & IMirrorReadyState> {
  const created = await sigurService.createDepartment({
    name: input.name.trim(),
    parentId: input.parentId ?? 0,
  }, connection);

  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();

  const departmentId = normalizeInt(resolveField(created, 'id', 'ID', 'Id'));
  if (!departmentId) {
    // Отдел в Sigur уже создан — зеркало всё равно обновляем, иначе строка
    // появится только с ближайшим плановым синком.
    requestDepartmentsMirrorRefresh('admin_crud', connection);
    throw new Error('Sigur не вернул id созданного отдела');
  }

  // Ответ отдаём только после зеркала: сразу после него в отдел можно добавлять
  // сотрудников с первой попытки.
  const mirror = await ensureDepartmentMirrored(departmentId, connection);

  const remoteDepartment = normalizeDepartment(await sigurService.getDepartmentById(departmentId, connection));
  return {
    id: remoteDepartment.id,
    parentId: remoteDepartment.parentId || null,
    name: remoteDepartment.name,
    hasChildren: false,
    employeeCount: 0,
    children: [],
    ...mirror,
  };
}

export async function updateSigurDepartment(
  departmentId: number,
  input: Partial<ISigurDepartmentUpsertInput>,
  connection?: ConnectionType,
): Promise<ISigurDepartmentNode & IMirrorReadyState> {
  const payload: Record<string, unknown> = {};
  if (typeof input.name === 'string') payload.name = input.name.trim();
  if (input.parentId !== undefined) payload.parentId = input.parentId ?? 0;

  await sigurService.updateDepartment(departmentId, payload, connection);
  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();
  const mirror = await ensureDepartmentMirrored(departmentId, connection);

  const remoteDepartment = normalizeDepartment(await sigurService.getDepartmentById(departmentId, connection));
  return {
    id: remoteDepartment.id,
    parentId: remoteDepartment.parentId || null,
    name: remoteDepartment.name,
    hasChildren: false,
    employeeCount: 0,
    children: [],
    ...mirror,
  };
}

export async function deleteSigurDepartment(
  departmentId: number,
  connection?: ConnectionType,
): Promise<void> {
  await sigurService.deleteDepartment(departmentId, connection);
  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();
  // Целевая деактивация: reconciliation в полном синке гасит удалённые отделы
  // только при успешном срезе сотрудников Sigur, а mirror_only не гасит вовсе.
  await deactivateMirroredDepartments([departmentId]);
  await runDepartmentsMirrorRefreshNow('admin_crud', connection);
}

export async function batchMoveSigurDepartments(
  departmentIds: number[],
  targetParentId: number | null,
  connection?: ConnectionType,
): Promise<{
  requested: number;
  effective: number;
  moved: number;
  failedDepartmentId: number | null;
  error: string | null;
}> {
  const departments = await getNormalizedDepartments(connection);
  const normalizedIds = normalizeDepartmentIds(departmentIds);
  const requested = departmentIds.length;

  if (normalizedIds.length === 0) {
    throw new Error('Не выбраны отделы для перемещения');
  }

  const departmentMap = new Map(departments.map(department => [department.id, department]));
  const missingIds = normalizedIds.filter(departmentId => !departmentMap.has(departmentId));
  if (missingIds.length > 0) {
    throw new Error(`Отделы не найдены: ${missingIds.join(', ')}`);
  }

  if (targetParentId != null && targetParentId > 0 && !departmentMap.has(targetParentId)) {
    throw new Error('Целевой родительский отдел не найден');
  }

  const effectiveIds = collapseNestedDepartmentSelection(normalizedIds, departments);
  const invalidTargetIds = new Set<number>();
  for (const departmentId of effectiveIds) {
    for (const id of collectSigurDepartmentDescendantIds(departmentId, departments)) {
      invalidTargetIds.add(id);
    }
  }

  if (targetParentId != null && invalidTargetIds.has(targetParentId)) {
    throw new Error('Нельзя переместить отдел внутрь самого себя или его потомка');
  }

  const targetParentValue = targetParentId ?? 0;
  const moveIds = effectiveIds.filter(departmentId => (departmentMap.get(departmentId)?.parentId || null) !== targetParentId);
  let moved = 0;
  let failedDepartmentId: number | null = null;
  let error: string | null = null;

  for (const departmentId of moveIds) {
    try {
      await sigurService.updateDepartment(departmentId, { parentId: targetParentValue }, connection);
      moved++;
    } catch (cause) {
      failedDepartmentId = departmentId;
      error = cause instanceof Error ? cause.message : 'Ошибка перемещения отдела';
      break;
    }
  }

  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();
  if (moved > 0) {
    // Ждём зеркало: иначе клиент перерисует дерево по старым parent_id.
    await runDepartmentsMirrorRefreshNow('admin_crud', connection);
  }

  return {
    requested,
    effective: effectiveIds.length,
    moved,
    failedDepartmentId,
    error,
  };
}

async function moveDirectDepartmentEmployees(
  departmentId: number,
  targetDepartmentId: number | null,
  connection?: ConnectionType,
): Promise<void> {
  const targetDepartmentValue = targetDepartmentId ?? 0;
  const limit = 1000;

  while (true) {
    const employees = await sigurService.getEmployeesPage(
      { departmentId },
      { limit, offset: 0 },
      connection,
    );
    const employeeIds = employees
      .map(employee => normalizeInt(resolveField(employee, 'id', 'ID', 'Id')))
      .filter((employeeId): employeeId is number => !!employeeId);

    if (employeeIds.length === 0) {
      return;
    }

    await Promise.allSettled(
      employeeIds.map(employeeId => sigurService.updateEmployee(employeeId, { departmentId: targetDepartmentValue }, connection)),
    );

    if (employeeIds.length < limit) {
      return;
    }
  }
}

export async function deleteSigurDepartmentRecursive(
  departmentId: number,
  connection?: ConnectionType,
): Promise<{ deleted: number; deletedIds: number[] }> {
  const departments = await getNormalizedDepartments(connection);
  const selectedDepartment = departments.find(department => department.id === departmentId) || null;
  if (!selectedDepartment) {
    const error = new Error('Отдел Sigur не найден');
    (error as Error & { status?: number }).status = 404;
    throw error;
  }

  const descendants = [...collectSigurDepartmentDescendantIds(departmentId, departments)];
  descendants.sort((left, right) => {
    const leftDepth = collectAncestorDepartmentIds(left, departments).size;
    const rightDepth = collectAncestorDepartmentIds(right, departments).size;
    return rightDepth - leftDepth;
  });

  const targetDepartmentId = selectedDepartment.parentId ?? null;

  // deletedIds — только реально удалённые: ошибки отдельных отделов глотаются,
  // и гасить в зеркале то, что осталось живым в Sigur, нельзя.
  const deletedIds: number[] = [];
  for (const currentDepartmentId of descendants) {
    await moveDirectDepartmentEmployees(currentDepartmentId, targetDepartmentId, connection);
    try {
      await sigurService.deleteDepartment(currentDepartmentId, connection);
      deletedIds.push(currentDepartmentId);
    } catch (error) {
      console.warn(`[sigur live admin] failed to delete department ${currentDepartmentId}:`, error);
    }
  }

  sigurService.invalidateEmployeeCache();
  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();
  await deactivateMirroredDepartments(deletedIds);
  await runDepartmentsMirrorRefreshNow('admin_crud', connection);

  return { deleted: deletedIds.length, deletedIds };
}
