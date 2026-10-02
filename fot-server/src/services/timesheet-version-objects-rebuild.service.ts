/**
 * Пересборка объектной разбивки редакций зафиксированного месяца (миграция 288).
 *
 * Подача за 1–15 число закрывается до конца месяца и уходит в 1С с объектом на дату
 * закрытия. После фиксации месяца итоговый объект известен: такая подача получает
 * новую revision (source = 'objects') — часы и content_hash прежние, разбивка по
 * зафиксированному объекту. 1С видит подачу устаревшей и перезабирает её.
 *
 * Каждая подача — своя транзакция под теми же локами (сотрудник, месяц) и
 * FOR UPDATE, что утверждение. Сбой одной не мешает остальным; повтор — no-op.
 */
import * as Sentry from '@sentry/node';
import { query } from '../config/postgres.js';
import { invalidateCaches } from '../middleware/cacheResponse.js';
import { AUDIT_ACTIONS, auditService } from './audit.service.js';
import { monthEnd } from './employee-timesheet-object.service.js';
import { withTimesheetSnapshotTransaction } from './timesheet-snapshot-tx.js';
import {
  monthAnchorsInRange,
  rebuildVersionObjects,
  type IVersionApproval,
} from './timesheet-version.service.js';

interface IApprovalRow {
  id: number | string;
  department_id: string | null;
  manager_employee_id: number | string | null;
  start_date: string;
  end_date: string;
  status: string;
  unlocked_at: string | null;
  version_dirty_at: string | null;
}

const toVersionApproval = (row: IApprovalRow): IVersionApproval => ({
  id: Number(row.id),
  department_id: row.department_id,
  manager_employee_id: row.manager_employee_id != null ? Number(row.manager_employee_id) : null,
  start_date: row.start_date,
  end_date: row.end_date,
  status: row.status,
});

/** Подачу можно пересобирать: утверждена, не открыта, без аварийной пересборки. */
export const isRebuildableApproval = (row: Pick<IApprovalRow, 'status' | 'unlocked_at' | 'version_dirty_at'>): boolean =>
  row.status === 'approved' && !row.unlocked_at && !row.version_dirty_at;

export interface IRebuildMonthResult {
  approvals: number;
  created: number;
  failures: number;
}

/**
 * Пересборка всех подач месяца. failures > 0 — месяц повторить на следующем тике.
 * employeeIds — только подачи с этими сотрудниками (пересчёт фиксации одного отдела).
 */
export async function rebuildVersionObjectsForMonth(
  month: string,
  options: { employeeIds?: readonly number[] } = {},
): Promise<IRebuildMonthResult> {
  if (options.employeeIds && options.employeeIds.length === 0) return { approvals: 0, created: 0, failures: 0 };
  const approvals = await query<IApprovalRow>(
    `SELECT id, department_id::text AS department_id, manager_employee_id,
            start_date::text AS start_date, end_date::text AS end_date, status,
            unlocked_at::text AS unlocked_at, version_dirty_at::text AS version_dirty_at
       FROM timesheet_approvals ta
      WHERE status = 'approved'
        AND start_date >= $1::date
        AND end_date <= $2::date
        AND unlocked_at IS NULL
        AND version_dirty_at IS NULL
        AND ($3::int[] IS NULL OR EXISTS (
              SELECT 1 FROM timesheet_approval_employees tae
               WHERE tae.approval_id = ta.id AND tae.employee_id = ANY($3::int[])
            ))
      ORDER BY id`,
    [month, monthEnd(month), options.employeeIds ? [...options.employeeIds] : null],
  );

  let created = 0;
  let failures = 0;
  for (const approvalRow of approvals) {
    const approvalId = Number(approvalRow.id);
    try {
      // Состав для локов — до транзакции: локи берутся раньше снимка REPEATABLE READ.
      const roster = await query<{ employee_id: number | string }>(
        'SELECT employee_id FROM timesheet_approval_employees WHERE approval_id = $1',
        [approvalId],
      );
      const anchors = monthAnchorsInRange(approvalRow.start_date, approvalRow.end_date);
      const lockPairs = roster.flatMap(row => anchors.map(workDate => ({
        employeeId: Number(row.employee_id),
        workDate,
      })));

      const result = await withTimesheetSnapshotTransaction(lockPairs, async client => {
        const locked = (await client.query<IApprovalRow>(
          `SELECT id, department_id::text AS department_id, manager_employee_id,
                  start_date::text AS start_date, end_date::text AS end_date, status,
                  unlocked_at::text AS unlocked_at, version_dirty_at::text AS version_dirty_at
             FROM timesheet_approvals WHERE id = $1 FOR UPDATE`,
          [approvalId],
        )).rows[0];
        if (!locked || !isRebuildableApproval(locked)) {
          return { created: false, revision: null, changedEmployeeIds: [] as number[] };
        }
        return rebuildVersionObjects(client, toVersionApproval(locked), null);
      });

      if (result.created) {
        created += 1;
        // Побочные эффекты — после транзакции: повтор снимка не должен их дублировать.
        await auditService.log({
          user_id: null,
          action: AUDIT_ACTIONS.TIMESHEET_VERSION_OBJECTS_REBUILT,
          entity_type: 'timesheet_approval',
          entity_id: String(approvalId),
          details: { month, revision: result.revision, changed_employees: result.changedEmployeeIds },
        });
      }
    } catch (error) {
      failures += 1;
      console.error(`[timesheet-object] пересборка объектов подачи ${approvalId} не удалась:`, error);
      Sentry.captureException(error, {
        tags: { source: 'timesheet-version-objects-rebuild' },
        extra: { approvalId, month },
      });
    }
  }

  // Статус выгрузки в 1С («устарел») в интерфейсе HR — не через TTL кэша.
  if (created > 0) invalidateCaches('timesheet-1c-status');
  return { approvals: approvals.length, created, failures };
}
