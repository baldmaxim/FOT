/**
 * Пересчёт объекта табелирования по часам сразу, не дожидаясь ночи: после снятия «Офиса»
 * в окне «Режим табелирования» (миграция 291) объект возвращается к тому, что посчитала бы
 * ночь. Правило и период — ночные: planAutoChanges, с 1-го числа по вчера. Ручной выбор,
 * личный «Офис» и отделы с «Офисом» не трогаются; нет часов (в том числе 1-го числа) —
 * объект прежний.
 *
 * Транзакция и лок режимов (TIMESHEET_MODE_LOCK_KEY) — у вызывающего; строки сотрудников
 * берутся FOR UPDATE по порядку id. applied_date не двигается.
 */
import type { PoolClient } from 'pg';
import { moscowTodayIso } from '../utils/date.utils.js';
import {
  applyChanges,
  auditChanges,
  loadOwnActiveEmployees,
  planAutoChanges,
  yesterdayMsk,
} from './employee-timesheet-object-auto.service.js';
import { loadSkudObjects, loadTimesheetObjectHours } from './employee-timesheet-object.service.js';
import { currentMonthStartMsk } from './timesheet-export-mode.service.js';

/** Возвращает id сотрудников, у которых объект изменился. */
export async function recomputeTimesheetObjectsNow(
  client: PoolClient,
  employeeIds: readonly number[],
  context: { contractorIds: string[]; now: Date; userId: string | null; reason: string },
): Promise<number[]> {
  const ids = [...new Set(employeeIds)].sort((a, b) => a - b);
  if (ids.length === 0) return [];

  const rows = await loadOwnActiveEmployees(client, context.contractorIds, ids);
  if (rows.length === 0) return [];
  const period = { start: currentMonthStartMsk(context.now), end: yesterdayMsk(context.now) };
  const tops = await loadTimesheetObjectHours(
    rows.map(row => row.id),
    period,
    { todayStr: moscowTodayIso(context.now), exec: client, objectsById: await loadSkudObjects(client) },
  );
  const changes = planAutoChanges(rows, tops, false);
  const appliedIds = await applyChanges(client, changes, false);
  await auditChanges(client, changes, appliedIds, {
    period, all: false, reason: context.reason, userId: context.userId,
  });
  return appliedIds;
}
