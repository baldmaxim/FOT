/**
 * Применение плана «табель ФОТ = табель 1С (ЗУП)» на открытой транзакции скрипта — всё или ничего.
 *
 * 1. Advisory-локи (сотрудник, месяц) — те же, что у правок табеля: параллельная правка дней ждёт.
 * 2. День уже равен цели (одна ЗУП-строка с теми же статусом, часами и объектом) — пропуск без записи.
 * 3. Остальные дни: отпечаток дня ФОТ под локами = отпечаток из плана, иначе отказ всего прогона.
 * 4. День нормализуется явно, а не через supersede (для `manual_object` его нет): снимаются ВСЕ строки дня —
 *    дневные, объектные, из заявлений; их вложения переносятся на новую строку (как supersede); создаётся ровно
 *    одна ЗУП-строка; состав строк дня проверяется SQL.
 * 5. Аудит каждой правки — тем же клиентом; закрытые подачи дней — на пересборку редакции и основы зарплаты.
 *
 * Резервную копию (полные строки до правки) функция возвращает — пишет её скрипт до COMMIT.
 * Автор ЗУП-строки пустой и согласующего нет (решение пользователя: в окне дня — только «ЗУП»); кто запускал —
 * в аудите и metadata.zup_align.
 */
import type { PoolClient } from 'pg';
import { upsertAttendanceAdjustment } from './attendance.service.js';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { lockTimesheetMonthsOnClient } from './timesheet-lock.service.js';
import { markVersionDirtyForOperatorRebuild } from './timesheet-version-maintenance.js';
import type { IZupDaySnapshot, IZupPair } from './timesheet-zup-align.snapshot.js';
import { zupPairKey } from './timesheet-zup-align.snapshot.js';
import {
  ZUP_REASON,
  zupRowSpec,
  type IZupAlignMetadata,
  type IZupBackup,
  type IZupBackupDay,
  type IZupPlan,
  type IZupPlanItem,
  type IZupRowSpec,
  type JsonRow,
} from './timesheet-zup-align.types.js';

export interface IZupActor {
  userId: string;
  email: string;
}

export interface IZupApplyDeps {
  /** Снимки дней под локами (боевой — loadZupDaySnapshots). */
  loadSnapshots: (client: PoolClient, month: string, pairs: readonly IZupPair[]) => Promise<Map<string, IZupDaySnapshot>>;
}

export interface IZupChangedDay {
  employee_id: number;
  date: string;
  reason: string;
}

export interface IZupApplyReport {
  written: number;
  alreadyApplied: number;
  byKind: Record<string, number>;
  removedRows: number;
  movedLinks: number;
  approvalIds: number[];
}

/** День ФОТ изменился после сверки — план устарел, ничего не пишем. */
export class ZupPlanStaleError extends Error {
  constructor(readonly days: IZupChangedDay[]) {
    super(`План устарел: изменились ${days.length} дн. после сверки — пересоберите план`);
    this.name = 'ZupPlanStaleError';
  }
}

const ADJUSTMENT_ENTITY = 'attendance_adjustment';
const CORRECTION_PURPOSE = 'timesheet_correction';

const toNumberOrNull = (value: unknown): number | null => (value == null ? null : Number(value));

/** Строка дня — ровно ЗУП-строка по спецификации. */
export const rowMatchesSpec = (row: JsonRow, spec: IZupRowSpec): boolean => {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  if (row.reason !== ZUP_REASON || !metadata.zup_align) return false;
  if (row.source_type !== spec.source_type || row.source_id !== spec.source_id || row.status !== spec.status) return false;
  const hours = toNumberOrNull(row.hours_override);
  if (hours !== spec.hours_override) return false;
  if (spec.metadata_object && metadata.object_id !== spec.metadata_object.object_id) return false;
  return row.approval_status === 'auto_approved' && row.created_by == null;
};

const loadDayRows = async (client: PoolClient, pairs: readonly IZupPair[]): Promise<Map<string, JsonRow[]>> => {
  const result = await client.query<{ row: JsonRow }>(
    `SELECT row_to_json(a) AS row
       FROM unnest($1::int[], $2::date[]) AS p(employee_id, work_date)
       JOIN attendance_adjustments a ON a.employee_id = p.employee_id AND a.work_date = p.work_date
      ORDER BY a.employee_id, a.work_date, a.id
        FOR UPDATE OF a`,
    [pairs.map(pair => pair.employeeId), pairs.map(pair => pair.date)],
  );
  const map = new Map<string, JsonRow[]>();
  for (const { row } of result.rows) {
    const key = zupPairKey(Number(row.employee_id), String(row.work_date).slice(0, 10));
    map.set(key, [...(map.get(key) ?? []), row]);
  }
  return map;
};

/** Нормализация одного дня: снять всё, записать одну ЗУП-строку, перенести вложения, проверить состав. */
const writeDay = async (
  client: PoolClient,
  item: IZupPlanItem,
  rows: JsonRow[],
  metadata: IZupAlignMetadata,
): Promise<IZupBackupDay> => {
  const spec = zupRowSpec(item.target);
  const removedIds = rows.map(row => String(row.id));
  const leaveRequestIds = rows
    .filter(row => row.source_type === 'leave_request' && typeof row.source_id === 'string')
    .map(row => String(row.source_id).split(':')[0])
    .filter(id => /^\d+$/.test(id));

  const removedLinks = (await client.query<{ row: JsonRow }>(
    `SELECT row_to_json(dl) AS row FROM document_links dl
      WHERE dl.entity_type = $1 AND dl.entity_id = ANY($2::text[]) ORDER BY dl.id`,
    [ADJUSTMENT_ENTITY, removedIds],
  )).rows.map(r => r.row);

  if (removedIds.length > 0) {
    await client.query('DELETE FROM document_links WHERE entity_type = $1 AND entity_id = ANY($2::text[])', [ADJUSTMENT_ENTITY, removedIds]);
    await client.query('DELETE FROM attendance_adjustments WHERE id = ANY($1::bigint[])', [removedIds]);
  }

  const saved = await upsertAttendanceAdjustment({
    employee_id: item.employee_id,
    work_date: item.date,
    status: spec.status as Parameters<typeof upsertAttendanceAdjustment>[0]['status'],
    hours_override: spec.hours_override,
    source_type: spec.source_type,
    source_id: spec.source_id,
    reason: ZUP_REASON,
    created_by: null,
    updated_by: null,
    approval_status: 'auto_approved',
    metadata: { ...(spec.metadata_object ?? {}), zup_align: metadata },
  }, client);
  const zupId = String(saved.id);

  // Вложения снятых строк и файлы заявлений дня — на ЗУП-строку, как это делает supersede у окна дня.
  const moved = (await client.query<{ row: JsonRow }>(
    `WITH src AS (
       SELECT document_id, purpose FROM jsonb_to_recordset($1::jsonb) AS l(document_id bigint, purpose text)
       UNION
       SELECT document_id, $4::text FROM document_links WHERE entity_type = 'leave_request' AND entity_id = ANY($3::text[])
     )
     INSERT INTO document_links (document_id, entity_type, entity_id, purpose)
     SELECT DISTINCT document_id, $2, $5, purpose FROM src
     ON CONFLICT (document_id, entity_type, entity_id, purpose) DO NOTHING
     RETURNING row_to_json(document_links) AS row`,
    [JSON.stringify(removedLinks), ADJUSTMENT_ENTITY, leaveRequestIds, CORRECTION_PURPOSE, zupId],
  )).rows.map(r => r.row);

  const after = (await client.query<{ row: JsonRow }>(
    `SELECT row_to_json(a) AS row FROM attendance_adjustments a
      WHERE a.employee_id = $1 AND a.work_date = $2::date`,
    [item.employee_id, item.date],
  )).rows.map(r => r.row);
  if (after.length !== 1 || String(after[0].id) !== zupId || !rowMatchesSpec(after[0], spec)) {
    throw new Error(`День ${item.employee_id}|${item.date}: после записи строк ${after.length}, ожидалась одна ЗУП-строка`);
  }

  return {
    employee_id: item.employee_id,
    date: item.date,
    removed_rows: rows,
    removed_links: removedLinks,
    zup_row: after[0],
    moved_links: moved,
  };
};

export const applyZupPlan = async (
  client: PoolClient,
  plan: IZupPlan,
  actor: IZupActor,
  deps: IZupApplyDeps,
): Promise<{ report: IZupApplyReport; backup: IZupBackup }> => {
  const pairs: IZupPair[] = plan.items.map(item => ({ employeeId: item.employee_id, date: item.date }));
  await lockTimesheetMonthsOnClient(client, pairs.map(pair => ({ employeeId: pair.employeeId, workDate: pair.date })));

  const rowsByDay = await loadDayRows(client, pairs);
  const toWrite: IZupPlanItem[] = [];
  let alreadyApplied = 0;
  for (const item of plan.items) {
    const rows = rowsByDay.get(zupPairKey(item.employee_id, item.date)) ?? [];
    if (rows.length === 1 && rowMatchesSpec(rows[0], zupRowSpec(item.target))) alreadyApplied += 1;
    else toWrite.push(item);
  }

  const snapshots = await deps.loadSnapshots(
    client, plan.month, toWrite.map(item => ({ employeeId: item.employee_id, date: item.date })),
  );
  const changed: IZupChangedDay[] = [];
  for (const item of toWrite) {
    const snapshot = snapshots.get(zupPairKey(item.employee_id, item.date));
    if (!snapshot) changed.push({ employee_id: item.employee_id, date: item.date, reason: 'нет снимка дня' });
    else if (snapshot.fingerprint !== item.expected_fingerprint) {
      changed.push({ employee_id: item.employee_id, date: item.date, reason: 'день в ФОТ изменился после сверки' });
    }
  }
  if (changed.length > 0) throw new ZupPlanStaleError(changed);

  const metadataBase = { run_id: plan.run_id, actor: actor.email, file_sha256: plan.source.sha256, plan_sha256: plan.plan_sha256 };
  const days: IZupBackupDay[] = [];
  const approvalIds = new Set<number>();
  const byKind: Record<string, number> = {};
  for (const item of toWrite) {
    const key = zupPairKey(item.employee_id, item.date);
    const day = await writeDay(client, item, rowsByDay.get(key) ?? [], { ...metadataBase, rows: item.rows });
    days.push(day);
    byKind[item.target.kind] = (byKind[item.target.kind] ?? 0) + 1;
    for (const id of snapshots.get(key)?.closedApprovalIds ?? []) approvalIds.add(id);
    await auditService.logWithClient(client, {
      user_id: actor.userId,
      action: AUDIT_ACTIONS.CREATE_TIMESHEET_ENTRY,
      entity_type: 'timesheet',
      entity_id: String(day.zup_row.id),
      details: {
        source: 'zup-align',
        run_id: plan.run_id,
        plan_sha256: plan.plan_sha256,
        file_sha256: plan.source.sha256,
        employee_id: item.employee_id,
        work_date: item.date,
        target: item.target,
        removed_adjustment_ids: day.removed_rows.map(row => Number(row.id)),
      },
    });
  }

  const approvals = [...approvalIds].sort((a, b) => a - b);
  await markVersionDirtyForOperatorRebuild(client, approvals);

  return {
    report: {
      written: days.length,
      alreadyApplied,
      byKind,
      removedRows: days.reduce((sum, day) => sum + day.removed_rows.length, 0),
      movedLinks: days.reduce((sum, day) => sum + day.moved_links.length, 0),
      approvalIds: approvals,
    },
    backup: {
      kind: 'zup-timesheet-align-backup',
      run_id: plan.run_id,
      plan_sha256: plan.plan_sha256,
      file_sha256: plan.source.sha256,
      month: plan.month,
      actor: { user_id: actor.userId, email: actor.email },
      created_at: new Date().toISOString(),
      days,
      approval_ids: approvals,
    },
  };
};
