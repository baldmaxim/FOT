import type { PoolClient } from 'pg';
import { withTransaction } from '../config/postgres.js';
import {
  getEmployeeAssignmentSnapshotDepartment,
  findApprovalLockForDate,
} from './timesheet-department-assignments.service.js';

/**
 * Синхронизирует заявление после удаления из табеля ОДНОГО материализованного дня
 * (строки attendance_adjustments с source_type='leave_request').
 *
 * Должна вызываться ВНУТРИ транзакции и ПОСЛЕ удаления целевой строки —
 * остаток дней читается из оставшихся строк attendance_adjustments этого заявления.
 *
 * Логика:
 *  - если дней не осталось → заявление переводится в 'cancelled';
 *  - иначе → selected_dates = оставшиеся дни, start_date/end_date = их min/max
 *    (инвариант selected_dates ⊆ [start_date, end_date] сохраняется; материализация
 *    трактует selected_dates как авторитетный список — leave-requests.controller approve()).
 *
 * Применяется только к числовому source_id (отсутствия/выход 'work'). Легаси-форму
 * "<id>:time_correction" не синхронизируем.
 *
 * @returns employee_id заявления (для realtime-уведомления) либо null, если заявление не найдено.
 */
export async function syncLeaveRequestOnDayRemoval(
  client: PoolClient,
  requestId: number,
): Promise<{ employeeId: number; cancelled: boolean } | null> {
  const reqRow = (await client.query<{ employee_id: number }>(
    `SELECT employee_id FROM leave_requests WHERE id = $1`,
    [requestId],
  )).rows[0];
  if (!reqRow) return null;

  const remaining = (await client.query<{ work_date: string }>(
    `SELECT work_date::text AS work_date
       FROM attendance_adjustments
      WHERE source_type = 'leave_request' AND source_id = $1
      ORDER BY work_date`,
    [String(requestId)],
  )).rows.map(row => row.work_date.slice(0, 10));

  if (remaining.length === 0) {
    await client.query(
      `UPDATE leave_requests
          SET status = 'cancelled', updated_at = now()
        WHERE id = $1 AND status <> 'cancelled'`,
      [requestId],
    );
    return { employeeId: reqRow.employee_id, cancelled: true };
  }

  await client.query(
    `UPDATE leave_requests
        SET selected_dates = $2::date[],
            start_date = $3,
            end_date = $4,
            updated_at = now()
      WHERE id = $1`,
    [requestId, remaining, remaining[0], remaining[remaining.length - 1]],
  );
  return { employeeId: reqRow.employee_id, cancelled: false };
}

/**
 * Синхронизирует текст заявления (обоснование) между исходной заявкой и её
 * материализованными в табель копиями.
 *
 * Правило: leave_requests.reason — «текущая» запись, обновляется всегда.
 * attendance_adjustments.reason конкретного дня обновляется, только если этот
 * день НЕ заперт согласованием периода отдела (submitted/approved timesheet_approvals) —
 * запертый день остаётся замороженным снимком текста на момент закрытия периода,
 * симметрично тому, как уже заморожены его часы/статус.
 */
export async function syncLeaveRequestReason(requestId: number, reason: string | null): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `UPDATE leave_requests SET reason = $2, updated_at = now() WHERE id = $1`,
      [requestId, reason],
    );

    const rows = (await client.query<{ id: number; employee_id: number; work_date: string }>(
      `SELECT id, employee_id, work_date::text AS work_date
         FROM attendance_adjustments
        WHERE source_type = 'leave_request' AND source_id = $1`,
      [String(requestId)],
    )).rows;

    for (const row of rows) {
      const workDate = row.work_date.slice(0, 10);
      const departmentId = await getEmployeeAssignmentSnapshotDepartment(row.employee_id, workDate);
      const lock = departmentId ? await findApprovalLockForDate(departmentId, workDate) : null;
      if (lock) continue; // день заперт по периоду — текст остаётся замороженным

      await client.query(
        `UPDATE attendance_adjustments SET reason = $2, updated_at = now() WHERE id = $1`,
        [row.id, reason],
      );
    }
  });
}
