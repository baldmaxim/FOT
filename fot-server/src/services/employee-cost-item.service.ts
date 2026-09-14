/**
 * «Статья затрат» сотрудника («Управление кадрами» и Excel-выгрузка) — производная режима
 * табелирования (resolveExportModes):
 *   current_activity → «Текущая деятельность»;
 *   object           → название закреплённого объекта;
 *   skud             → «СКУД (объект1, объект2)» — объекты с часами за период снимка.
 *
 * Режим живой (текущие настройки), список объектов — из того же источника, что столбец
 * «Объект» (loadMainObjects: опубликованный снимок или расчёт на лету).
 */
import { query } from '../config/postgres.js';
import {
  CURRENT_ACTIVITY_ADDRESS,
  DEFAULT_EXPORT_MODE,
  resolveExportModes,
  type TimesheetExportMode,
} from './timesheet-export-mode.service.js';

export const COST_ITEM_SKUD = 'СКУД';
export const COST_ITEM_OBJECT_FALLBACK = 'Объект';

export interface ICostItemInput {
  mode: TimesheetExportMode;
  /** Название закреплённого объекта (только для mode = object). */
  pinnedObjectName: string | null;
  /** Объекты с часами, от большего к меньшему (только для mode = skud). */
  skudObjectNames: readonly string[];
}

export function buildCostItemLabel({ mode, pinnedObjectName, skudObjectNames }: ICostItemInput): string {
  if (mode === 'current_activity') return CURRENT_ACTIVITY_ADDRESS;
  if (mode === 'object') return pinnedObjectName?.trim() || COST_ITEM_OBJECT_FALLBACK;
  return skudObjectNames.length > 0 ? `${COST_ITEM_SKUD} (${skudObjectNames.join(', ')})` : COST_ITEM_SKUD;
}

/** Статья затрат для КАЖДОГО переданного id — даже без часов и без снимка. */
export async function loadCostItems(
  employeeIds: readonly number[],
  objectNamesByEmployee: ReadonlyMap<number, readonly string[]>,
): Promise<Map<number, string>> {
  const ids = [...new Set(employeeIds.filter(id => Number.isInteger(id) && id > 0))];
  const result = new Map<number, string>();
  if (ids.length === 0) return result;

  const modes = await resolveExportModes(ids);

  const pinnedIds = new Set<string>();
  for (const resolved of modes.values()) {
    if (resolved.mode === 'object' && resolved.pinnedObjectId) pinnedIds.add(resolved.pinnedObjectId);
  }
  const objectNameById = new Map<string, string>();
  if (pinnedIds.size > 0) {
    const rows = await query<{ id: string; name: string }>(
      'SELECT id::text AS id, name FROM skud_objects WHERE id = ANY($1::uuid[])',
      [[...pinnedIds]],
    );
    for (const row of rows) objectNameById.set(row.id, row.name);
  }

  for (const id of ids) {
    const resolved = modes.get(id) ?? DEFAULT_EXPORT_MODE;
    result.set(id, buildCostItemLabel({
      mode: resolved.mode,
      pinnedObjectName: resolved.pinnedObjectId ? objectNameById.get(resolved.pinnedObjectId) ?? null : null,
      skudObjectNames: objectNamesByEmployee.get(id) ?? [],
    }));
  }
  return result;
}
