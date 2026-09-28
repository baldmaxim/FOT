import type { DbExecutor } from '../config/postgres.js';
import { emitDomainChange } from './realtime-broadcast.service.js';
import { getLeaveRequestRecipients } from './recipients.service.js';

export interface ISyncedWorkLeaveRequest {
  id: number;
  employee_id: number;
  status: string;
}

/**
 * Статус заявки «Работа в выходной» — производная от решений по её дням в «Согласованиях»:
 * есть отклонённый день → rejected, есть ожидающий → pending, иначе approved.
 *
 * Вызывается ВНУТРИ транзакции решения тем же exec. Для заявки, которую в «Заявлениях»
 * согласовать некому, это единственный путь финализации: упади синхронизация после коммита,
 * день остался бы согласован, заявка — pending, и она вернулась бы в «Заявления». Внутри
 * транзакции её сбой откатывает и само решение.
 */
export async function syncWorkLeaveRequestsForAdjustmentIds(
  exec: DbExecutor,
  adjustmentIds: number[],
  reviewerUserId: string,
  reviewComment: string | null = null,
): Promise<ISyncedWorkLeaveRequest[]> {
  const ids = [...new Set(adjustmentIds.filter(id => Number.isInteger(id) && id > 0))];
  if (ids.length === 0) return [];

  const result = await exec.query<ISyncedWorkLeaveRequest>(
    `WITH target_requests AS (
       SELECT DISTINCT lr.id
         FROM attendance_adjustments aa
         JOIN leave_requests lr
           ON lr.id::text = aa.source_id
          AND lr.request_type = 'work'
        WHERE aa.id = ANY($1::bigint[])
          AND aa.source_type = 'leave_request'
          AND aa.source_id ~ '^[0-9]+$'
     ),
     request_state AS (
       SELECT tr.id,
              BOOL_OR(aa.approval_status = 'rejected') AS has_rejected,
              BOOL_OR(aa.approval_status = 'pending') AS has_pending,
              BOOL_OR(aa.approval_status IN ('approved', 'auto_approved')) AS has_accepted
         FROM target_requests tr
         JOIN attendance_adjustments aa
           ON aa.source_type = 'leave_request'
          AND aa.source_id = tr.id::text
        GROUP BY tr.id
     ),
     next_state AS (
       SELECT id,
              CASE
                WHEN has_rejected THEN 'rejected'
                WHEN has_pending THEN 'pending'
                WHEN has_accepted THEN 'approved'
                ELSE 'pending'
              END AS status
         FROM request_state
     )
     UPDATE leave_requests lr
        SET status = ns.status,
            reviewer_id = CASE WHEN ns.status IN ('approved', 'rejected') THEN $2::uuid ELSE NULL END,
            reviewed_at = CASE WHEN ns.status IN ('approved', 'rejected') THEN now() ELSE NULL END,
            -- На approved комментарий не трогаем: заявка могла быть одобрена
            -- на 1-м этапе в «Заявлениях» — его комментарий сохраняем.
            review_comment = CASE
              WHEN ns.status = 'rejected' THEN $3::text
              WHEN ns.status = 'pending' THEN NULL
              ELSE lr.review_comment
            END,
            updated_at = now()
       FROM next_state ns
      WHERE lr.id = ns.id
        AND (
          lr.status IS DISTINCT FROM ns.status
          OR (ns.status = 'rejected' AND lr.review_comment IS DISTINCT FROM $3::text)
        )
      RETURNING lr.id, lr.employee_id, lr.status`,
    [ids, reviewerUserId, reviewComment],
  );
  return result.rows;
}

/** Realtime по изменённым заявкам — только после коммита решения. */
export function emitWorkLeaveRequestSync(changed: ISyncedWorkLeaveRequest[], reviewerUserId: string): void {
  for (const row of changed) {
    getLeaveRequestRecipients(Number(row.employee_id), reviewerUserId)
      .then((recipients) => {
        emitDomainChange({
          event: 'leave_request:changed',
          targetUserIds: recipients,
          payload: {
            entityId: Number(row.id),
            employeeId: Number(row.employee_id),
            action: row.status === 'approved' ? 'approve' : row.status === 'rejected' ? 'reject' : 'revert',
          },
        });
      })
      .catch((e) => console.error('[correction-approval] emit leave_request sync error:', e));
  }
}
