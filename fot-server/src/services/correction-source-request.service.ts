import { queryOne } from '../config/postgres.js';

export interface ICorrectionSourceRequest {
  id: number;
  reviewed_at: string;
  reviewer_name: string | null;
}

/**
 * Согласованное заявление «Корректировка» (time_correction), из которого получена
 * корректировка табеля, — для строки «Согласовано · кто · когда» в окне дня.
 *
 * Прямой ссылки нет: при согласовании объектная корректировка пишется с
 * source_id = id объекта (leave-requests.controller → upsertAttendanceAdjustment),
 * поэтому заявление ищем по сотруднику + дате + объекту. Легаси day-level
 * корректировки ссылаются точно: source_id = '<id заявления>:time_correction'.
 *
 * Строку показываем, только если корректировка сейчас совпадает с согласованным:
 *  • часы те же — иначе их поправили в табеле уже после согласования, и
 *    «Согласовано» рядом с другими часами вводило бы в заблуждение;
 *  • заявление согласовано не позже последней записи корректировки — согласование
 *    само пишет корректировку (допуск на разницу часов процесса и БД).
 * Из нескольких подходящих — последнее согласованное.
 */
export async function loadCorrectionSourceRequest(
  adjustmentId: number,
): Promise<ICorrectionSourceRequest | null> {
  const row = await queryOne<{
    id: number | string;
    reviewed_at: Date | string;
    reviewer_name: string | null;
  }>(
    `SELECT lr.id, lr.reviewed_at, up.full_name AS reviewer_name
       FROM attendance_adjustments a
       JOIN leave_requests lr
         ON lr.employee_id = a.employee_id
        AND lr.request_type = 'time_correction'
        AND lr.status = 'approved'
        AND lr.reviewed_at IS NOT NULL
        AND COALESCE(lr.correction_date, lr.start_date) = a.work_date
        AND lr.correction_hours IS NOT DISTINCT FROM a.hours_override
        AND lr.reviewed_at <= a.updated_at + interval '1 minute'
        AND (
              (a.source_type = 'manual_object' AND lr.correction_object_id::text = a.source_id)
           OR (a.source_type = 'leave_request' AND a.source_id = lr.id::text || ':time_correction')
            )
       LEFT JOIN user_profiles up ON up.id = lr.reviewer_id
      WHERE a.id = $1
      ORDER BY lr.reviewed_at DESC
      LIMIT 1`,
    [adjustmentId],
  );
  if (!row) return null;
  return {
    id: Number(row.id),
    reviewed_at: row.reviewed_at instanceof Date ? row.reviewed_at.toISOString() : String(row.reviewed_at),
    reviewer_name: row.reviewer_name ?? null,
  };
}
