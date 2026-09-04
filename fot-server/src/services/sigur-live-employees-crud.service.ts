/**
 * Sigur live admin — CRUD сотрудников и массовый перенос между отделами.
 *
 * Извлечено из sigur-live-admin.service.ts (Волна 3 декомпозиции).
 * Содержит 6 публичных операций над employees + 2 локальных helpers.
 *
 * Helpers normalizeInt / invalidateSigurDirectoryCaches импортируются как
 * public exports из основного sigur-live-admin (используются и в Profile/
 * CardStatuses/Departments которые остаются там).
 */
import { sigurService } from './sigur.service.js';
import { resolveField } from './sigur-sync-shared.js';
import { invalidateEmployeeAccessPointBindingsCache } from './sigur-linked-employees.service.js';
import type { ConnectionType } from './sigur-base.service.js';
import {
  getSigurEmployeeProfile,
  invalidateSigurDirectoryCaches,
  normalizeInt,
  type ISigurEmployeeProfile,
  type ISigurEmployeeUpsertInput,
} from './sigur-live-admin.service.js';

function buildSigurEmployeePayload(input: ISigurEmployeeUpsertInput): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  if (typeof input.name === 'string') payload.name = input.name.trim();
  if (input.departmentId !== undefined) payload.departmentId = input.departmentId;
  if (input.positionId !== undefined) payload.positionId = input.positionId;
  if (input.tabId !== undefined) payload.tabId = input.tabId || null;
  if (input.description !== undefined) payload.description = input.description || null;
  return payload;
}

async function syncSigurEmployeeBlockedState(
  sigurEmployeeId: number,
  blocked: boolean | null | undefined,
  currentBlocked: boolean | null,
  connection?: ConnectionType,
): Promise<void> {
  if (blocked == null || currentBlocked === blocked) {
    return;
  }

  if (blocked) {
    await sigurService.blockEmployee(sigurEmployeeId, connection);
  } else {
    await sigurService.unblockEmployee(sigurEmployeeId, connection);
  }
}

export async function createSigurEmployee(
  input: ISigurEmployeeUpsertInput,
  connection?: ConnectionType,
): Promise<ISigurEmployeeProfile> {
  const created = await sigurService.createEmployee(buildSigurEmployeePayload(input), connection);
  const sigurEmployeeId = normalizeInt(resolveField(created, 'id', 'ID', 'Id'));
  if (!sigurEmployeeId) {
    throw new Error('Sigur не вернул id созданного сотрудника');
  }

  await syncSigurEmployeeBlockedState(sigurEmployeeId, input.blocked, false, connection);
  sigurService.invalidateEmployeeCache();
  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();

  return getSigurEmployeeProfile(sigurEmployeeId, {}, connection);
}

export async function updateSigurEmployee(
  sigurEmployeeId: number,
  input: ISigurEmployeeUpsertInput,
  connection?: ConnectionType,
): Promise<ISigurEmployeeProfile> {
  const currentProfile = await getSigurEmployeeProfile(sigurEmployeeId, {}, connection);
  const payload = buildSigurEmployeePayload(input);

  if (Object.keys(payload).length > 0) {
    await sigurService.updateEmployee(sigurEmployeeId, payload, connection);
  }

  await syncSigurEmployeeBlockedState(
    sigurEmployeeId,
    input.blocked,
    currentProfile.profile.blocked,
    connection,
  );

  sigurService.invalidateEmployeeCache();
  sigurService.invalidateDepartmentCache();
  invalidateEmployeeAccessPointBindingsCache(sigurEmployeeId);
  invalidateSigurDirectoryCaches();

  return getSigurEmployeeProfile(sigurEmployeeId, {}, connection);
}

export async function moveSigurEmployee(
  sigurEmployeeId: number,
  departmentId: number,
  connection?: ConnectionType,
): Promise<ISigurEmployeeProfile> {
  return updateSigurEmployee(
    sigurEmployeeId,
    { departmentId },
    connection,
  );
}

export async function batchMoveSigurEmployees(
  employeeIds: number[],
  departmentId: number,
  connection?: ConnectionType,
): Promise<{ requested: number; moved: number; failedIds: number[] }> {
  const normalizedEmployeeIds = Array.from(new Set(
    employeeIds.filter(employeeId => Number.isFinite(employeeId) && employeeId > 0),
  ));

  const results = await Promise.allSettled(
    normalizedEmployeeIds.map(employeeId => sigurService.updateEmployee(employeeId, { departmentId }, connection)),
  );

  sigurService.invalidateEmployeeCache();
  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();

  return {
    requested: normalizedEmployeeIds.length,
    moved: results.filter(result => result.status === 'fulfilled').length,
    failedIds: results.flatMap((result, index) => (result.status === 'rejected' ? [normalizedEmployeeIds[index]] : [])),
  };
}

export type BatchMoveProgressEvent =
  | { type: 'start'; total: number }
  | {
      type: 'progress';
      processed: number;
      total: number;
      succeeded: number;
      failed: number;
      lastEmployeeId: number;
      ok: boolean;
    }
  | { type: 'done'; requested: number; moved: number; failedIds: number[] };

export async function batchMoveSigurEmployeesStreaming(
  employeeIds: number[],
  departmentId: number,
  connection: ConnectionType | undefined,
  onProgress: (event: BatchMoveProgressEvent) => void,
): Promise<{ requested: number; moved: number; failedIds: number[] }> {
  const normalizedEmployeeIds = Array.from(new Set(
    employeeIds.filter(employeeId => Number.isFinite(employeeId) && employeeId > 0),
  ));

  const total = normalizedEmployeeIds.length;
  onProgress({ type: 'start', total });

  let processed = 0;
  let succeeded = 0;
  let failed = 0;
  const failedIds: number[] = [];

  await Promise.allSettled(
    normalizedEmployeeIds.map(async employeeId => {
      let ok = false;
      try {
        await sigurService.updateEmployee(employeeId, { departmentId }, connection);
        succeeded += 1;
        ok = true;
      } catch (error) {
        failed += 1;
        failedIds.push(employeeId);
        throw error;
      } finally {
        processed += 1;
        onProgress({
          type: 'progress',
          processed,
          total,
          succeeded,
          failed,
          lastEmployeeId: employeeId,
          ok,
        });
      }
    }),
  );

  sigurService.invalidateEmployeeCache();
  sigurService.invalidateDepartmentCache();
  invalidateSigurDirectoryCaches();

  return {
    requested: total,
    moved: succeeded,
    failedIds,
  };
}

export async function deleteSigurEmployee(
  sigurEmployeeId: number,
  connection?: ConnectionType,
): Promise<void> {
  await sigurService.deleteEmployee(sigurEmployeeId, connection);
  sigurService.invalidateEmployeeCache();
  sigurService.invalidateDepartmentCache();
  invalidateEmployeeAccessPointBindingsCache(sigurEmployeeId);
  invalidateSigurDirectoryCaches();
}
