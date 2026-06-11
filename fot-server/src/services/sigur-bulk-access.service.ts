/**
 * Массовое ДОБАВЛЕНИЕ точек доступа выбранным сотрудникам Sigur (страница SIGUR).
 *
 * Семантика только merge: к текущим точкам сотрудника добавляются выбранные,
 * ничего не снимается. Запись в Sigur идёт через card-safe
 * replaceEmployeeAccessPointBindings (карта сотрудника не слетает).
 *
 * Дополнительно: если Sigur-сотрудник связан с активным contractor_passes
 * (по sigur_employee_id), синхронизируем contractor_passes.access_point_names
 * итоговым набором точек из Sigur и пишем событие в audit_logs
 * (action=CONTRACTOR_PASS_ACCESS_POINTS_ADDED) — оно видно в истории пропуска
 * на вкладке «Подрядчики → Мониторинг».
 */
import { query, execute } from '../config/postgres.js';
import { auditService } from './audit.service.js';
import {
  getEmployeeAccessPointBindings,
  replaceEmployeeAccessPointBindings,
  type ICardConflict,
} from './sigur-linked-employees.service.js';
import type { ConnectionType } from './sigur-base.service.js';

/** Параллельность обработки сотрудников. HTTP к Sigur дополнительно троттлится
 *  глобальным семафором SIGUR_MAX_CONCURRENCY. */
const BULK_CONCURRENCY = 5;

export type BulkAccessPointsProgressEvent =
  | { type: 'start'; total: number }
  | {
      type: 'progress';
      processed: number;
      total: number;
      employeeId: number;
      ok: boolean;
      addedIds: number[];
      restoredCardIds: number[];
      cardConflicts: ICardConflict[];
      syncedPasses: number;
    };

export interface BulkAccessPointsResult {
  requested: number;
  updated: number;
  syncedPasses: number;
  failedIds: number[];
  warnings: string[];
}

interface ILinkedPassRow {
  id: string;
  sigur_employee_id: string | number;
  pass_number: string;
  org_department_id: string;
}

/** Обработать элементы с ограниченной параллельностью. */
async function runWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workerCount = Math.max(1, Math.min(limit, items.length));
  const workers = Array.from({ length: workerCount }, async () => {
    for (let i = cursor++; i < items.length; i = cursor++) {
      await fn(items[i]);
    }
  });
  await Promise.all(workers);
}

export async function bulkAddEmployeeAccessPointsStreaming(
  employeeIds: number[],
  accessPointIds: number[],
  connection: ConnectionType | undefined,
  actorUserId: string | null,
  onProgress: (event: BulkAccessPointsProgressEvent) => void,
): Promise<BulkAccessPointsResult> {
  const normalizedEmployeeIds = Array.from(new Set(
    employeeIds.filter(id => Number.isFinite(id) && id > 0),
  ));
  const normalizedPointIds = Array.from(new Set(
    accessPointIds.filter(id => Number.isFinite(id) && id > 0),
  ));

  const total = normalizedEmployeeIds.length;
  onProgress({ type: 'start', total });

  // Связанные активные пропуска подрядчиков — одним батч-запросом.
  const linkedPassesByEmployee = new Map<number, ILinkedPassRow[]>();
  if (normalizedEmployeeIds.length > 0) {
    const rows = await query<ILinkedPassRow>(
      `SELECT id, sigur_employee_id, pass_number, org_department_id
         FROM contractor_passes
        WHERE sigur_employee_id = ANY($1::bigint[])
          AND (status = 'applied' OR is_active = true)`,
      [normalizedEmployeeIds],
    );
    for (const row of rows) {
      const key = Number(row.sigur_employee_id);
      const list = linkedPassesByEmployee.get(key) || [];
      list.push(row);
      linkedPassesByEmployee.set(key, list);
    }
  }

  let processed = 0;
  let updated = 0;
  let syncedPasses = 0;
  const failedIds: number[] = [];
  const warnings: string[] = [];

  await runWithConcurrency(normalizedEmployeeIds, BULK_CONCURRENCY, async employeeId => {
    let ok = false;
    let addedIds: number[] = [];
    let restoredCardIds: number[] = [];
    let cardConflicts: ICardConflict[] = [];
    let syncedForEmployee = 0;
    try {
      // merge: текущие ∪ выбранные.
      const current = await getEmployeeAccessPointBindings(employeeId, connection);
      const mergedSet = new Set<number>(current.map(b => b.accessPointId));
      normalizedPointIds.forEach(id => mergedSet.add(id));

      const result = await replaceEmployeeAccessPointBindings(
        employeeId,
        [...mergedSet],
        connection,
      );
      addedIds = result.addedIds;
      restoredCardIds = result.restoredCardIds;
      cardConflicts = result.cardConflicts;
      updated += 1;
      ok = true;

      // Синхронизация подрядных пропусков — только если реально что-то добавили.
      if (addedIds.length > 0) {
        const finalNames = result.bindings
          .map(b => b.accessPointName)
          .filter((name): name is string => !!name);
        const addedSet = new Set(addedIds);
        const addedNames = result.bindings
          .filter(b => addedSet.has(b.accessPointId))
          .map(b => b.accessPointName)
          .filter((name): name is string => !!name);

        const passes = linkedPassesByEmployee.get(employeeId) || [];
        for (const pass of passes) {
          await execute(
            `UPDATE contractor_passes
                SET access_point_names = $1::text[], updated_at = now()
              WHERE id = $2::uuid`,
            [finalNames, pass.id],
          );
          await auditService.log({
            user_id: actorUserId,
            action: 'CONTRACTOR_PASS_ACCESS_POINTS_ADDED',
            entity_type: 'contractor_pass',
            entity_id: pass.id,
            details: {
              added_names: addedNames,
              total_names: finalNames,
              sigur_employee_id: employeeId,
              pass_number: pass.pass_number,
              org_department_id: pass.org_department_id,
              source: 'sigur_bulk',
            },
          });
          syncedForEmployee += 1;
        }
        syncedPasses += syncedForEmployee;
      }
    } catch (error) {
      failedIds.push(employeeId);
      warnings.push(
        `Сотрудник ${employeeId}: ${error instanceof Error ? error.message : 'ошибка добавления точек'}`,
      );
    } finally {
      processed += 1;
      onProgress({
        type: 'progress',
        processed,
        total,
        employeeId,
        ok,
        addedIds,
        restoredCardIds,
        cardConflicts,
        syncedPasses: syncedForEmployee,
      });
    }
  });

  return { requested: total, updated, syncedPasses, failedIds, warnings };
}
