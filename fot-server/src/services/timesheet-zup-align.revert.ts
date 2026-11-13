/**
 * Откат прогона «табель ФОТ = табель 1С (ЗУП)» по резервной копии — всё или ничего, под теми же advisory-локами.
 *
 * День откатывается, только если в нём ровно ЗУП-строка из копии и её никто не трогал (те же id, updated_at,
 * статус, часы, автор) и к ней не приложили новых файлов. Иначе — отказ всего отката: человек уже правил день.
 * Возвращаются снятые строки с исходными id (json_populate_recordset — все колонки как были) и их вложения;
 * удаляются ЗУП-строки и перенесённые на них ссылки. Закрытые подачи — снова на пересборку.
 * История аудита и редакций остаётся; редакцию, уже забранную 1С, отозвать нельзя.
 */
import type { PoolClient } from 'pg';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { listClosedApprovalIdsForPairs, lockTimesheetMonthsOnClient } from './timesheet-lock.service.js';
import { markVersionDirtyForOperatorRebuild } from './timesheet-version-maintenance.js';
import type { IZupActor } from './timesheet-zup-align.apply.js';
import { zupPairKey } from './timesheet-zup-align.snapshot.js';
import type { IZupBackup, JsonRow } from './timesheet-zup-align.types.js';

export interface IZupRevertReport {
  days: number;
  restoredRows: number;
  restoredLinks: number;
  removedMovedLinks: number;
  approvalIds: number[];
}

/** ЗУП-строку после записи правил человек или к ней приложили файл — откат не делаем. */
export class ZupRevertConflictError extends Error {
  constructor(readonly days: Array<{ employee_id: number; date: string; reason: string }>) {
    super(`Откат невозможен: ${days.length} дн. изменены после записи`);
    this.name = 'ZupRevertConflictError';
  }
}

const SAME_FIELDS = ['id', 'source_type', 'source_id', 'status', 'hours_override', 'reason', 'created_by', 'updated_by',
  'approval_status', 'updated_at'] as const;

const sameZupRow = (current: JsonRow, saved: JsonRow): boolean => SAME_FIELDS.every((field) => {
  const a = current[field];
  const b = saved[field];
  if (field === 'hours_override') return (a == null ? null : Number(a)) === (b == null ? null : Number(b));
  return String(a ?? '') === String(b ?? '');
});

export const parseZupBackup = (raw: unknown): IZupBackup => {
  const backup = raw as IZupBackup;
  if (backup?.kind !== 'zup-timesheet-align-backup' || !Array.isArray(backup.days)) {
    throw new Error('Файл не похож на резервную копию выравнивания ЗУП');
  }
  return backup;
};

export const revertZupBackup = async (
  client: PoolClient,
  backup: IZupBackup,
  actor: IZupActor,
): Promise<IZupRevertReport> => {
  const pairs = backup.days.map(day => ({ employeeId: day.employee_id, workDate: day.date }));
  await lockTimesheetMonthsOnClient(client, pairs);

  const current = await client.query<{ row: JsonRow }>(
    `SELECT row_to_json(a) AS row
       FROM unnest($1::int[], $2::date[]) AS p(employee_id, work_date)
       JOIN attendance_adjustments a ON a.employee_id = p.employee_id AND a.work_date = p.work_date
      ORDER BY a.id
        FOR UPDATE OF a`,
    [pairs.map(pair => pair.employeeId), pairs.map(pair => pair.workDate)],
  );
  const rowsByDay = new Map<string, JsonRow[]>();
  for (const { row } of current.rows) {
    const key = zupPairKey(Number(row.employee_id), String(row.work_date).slice(0, 10));
    rowsByDay.set(key, [...(rowsByDay.get(key) ?? []), row]);
  }
  const zupIds = backup.days.map(day => String(day.zup_row.id));
  const links = await client.query<{ entity_id: string; id: string }>(
    `SELECT entity_id, id::text FROM document_links WHERE entity_type = 'attendance_adjustment' AND entity_id = ANY($1::text[])`,
    [zupIds],
  );
  const linksByZup = new Map<string, Set<string>>();
  for (const link of links.rows) {
    linksByZup.set(link.entity_id, (linksByZup.get(link.entity_id) ?? new Set()).add(link.id));
  }

  const conflicts: Array<{ employee_id: number; date: string; reason: string }> = [];
  for (const day of backup.days) {
    const rows = rowsByDay.get(zupPairKey(day.employee_id, day.date)) ?? [];
    const conflict = (reason: string): void => { conflicts.push({ employee_id: day.employee_id, date: day.date, reason }); };
    if (rows.length !== 1) conflict(`строк в дне ${rows.length}, ожидалась одна ЗУП-строка`);
    else if (!sameZupRow(rows[0], day.zup_row)) conflict('ЗУП-строку изменили после записи');
    const moved = new Set(day.moved_links.map(link => String(link.id)));
    const extra = [...(linksByZup.get(String(day.zup_row.id)) ?? [])].filter(id => !moved.has(id));
    if (extra.length > 0) conflict('к ЗУП-строке приложили файлы');
  }
  if (conflicts.length > 0) throw new ZupRevertConflictError(conflicts);

  const movedIds = backup.days.flatMap(day => day.moved_links.map(link => String(link.id)));
  const removedMoved = movedIds.length > 0
    ? (await client.query('DELETE FROM document_links WHERE id = ANY($1::bigint[])', [movedIds])).rowCount ?? 0
    : 0;
  await client.query('DELETE FROM attendance_adjustments WHERE id = ANY($1::bigint[])', [zupIds]);

  const restoredRows = backup.days.flatMap(day => day.removed_rows);
  const restoredLinks = backup.days.flatMap(day => day.removed_links);
  if (restoredRows.length > 0) {
    await client.query(
      `INSERT INTO attendance_adjustments SELECT * FROM json_populate_recordset(NULL::attendance_adjustments, $1::json)`,
      [JSON.stringify(restoredRows)],
    );
  }
  if (restoredLinks.length > 0) {
    await client.query(
      `INSERT INTO document_links SELECT * FROM json_populate_recordset(NULL::document_links, $1::json)`,
      [JSON.stringify(restoredLinks)],
    );
  }

  for (const day of backup.days) {
    await auditService.logWithClient(client, {
      user_id: actor.userId,
      action: AUDIT_ACTIONS.DELETE_TIMESHEET_ENTRY,
      entity_type: 'timesheet',
      entity_id: String(day.zup_row.id),
      details: {
        source: 'zup-align-revert',
        run_id: backup.run_id,
        employee_id: day.employee_id,
        work_date: day.date,
        restored_adjustment_ids: day.removed_rows.map(row => Number(row.id)),
      },
    });
  }

  const approvals = new Set<number>(backup.approval_ids);
  for (const id of await listClosedApprovalIdsForPairs(pairs, client)) approvals.add(id);
  const approvalIds = [...approvals].sort((a, b) => a - b);
  await markVersionDirtyForOperatorRebuild(client, approvalIds);

  return {
    days: backup.days.length,
    restoredRows: restoredRows.length,
    restoredLinks: restoredLinks.length,
    removedMovedLinks: removedMoved,
    approvalIds,
  };
};
