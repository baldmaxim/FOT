import type { PoolClient } from 'pg';
import { query } from '../config/postgres.js';

/**
 * История изменений по заявлению (таблица leave_request_history, миграция 240).
 *
 * Отличие от аудита: аудит админский и в карточке заявления не виден, а слоты
 * решения/отмены в самих leave_requests перезаписываются — цепочка
 * «согласовал → отменил согласование → поправил часы» в них не сохраняется.
 */

export type LeaveRequestHistoryAction =
  | 'approved'
  | 'rejected'
  | 'cancelled'
  | 'revoked'
  | 'hours_changed'
  | 'type_changed';

export interface ILeaveRequestHistoryRow {
  id: number;
  action: LeaveRequestHistoryAction;
  actor_id: string | null;
  actor_name: string | null;
  old_value: Record<string, unknown> | null;
  new_value: Record<string, unknown> | null;
  comment: string | null;
  created_at: string;
}

/**
 * Запись события ВНУТРИ транзакции вызывающего: ошибку не глотаем (в отличие от
 * best-effort auditService.log) — не записалась история, откатывается и операция.
 * Это единственный видимый пользователю след «было → стало».
 */
export async function recordLeaveRequestHistory(
  client: PoolClient,
  entry: {
    requestId: number;
    action: LeaveRequestHistoryAction;
    actorId: string | null;
    oldValue?: Record<string, unknown> | null;
    newValue?: Record<string, unknown> | null;
    comment?: string | null;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO leave_request_history (request_id, action, actor_id, old_value, new_value, comment)
     VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6)`,
    [
      entry.requestId,
      entry.action,
      entry.actorId,
      entry.oldValue ? JSON.stringify(entry.oldValue) : null,
      entry.newValue ? JSON.stringify(entry.newValue) : null,
      entry.comment ?? null,
    ],
  );
}

/** История заявления от старых записей к новым (как читается таймлайн). */
export async function listLeaveRequestHistory(requestId: number): Promise<ILeaveRequestHistoryRow[]> {
  return query<ILeaveRequestHistoryRow>(
    `SELECT h.id,
            h.action,
            h.actor_id,
            up.full_name AS actor_name,
            h.old_value,
            h.new_value,
            h.comment,
            h.created_at
       FROM leave_request_history h
       LEFT JOIN user_profiles up ON up.id = h.actor_id
      WHERE h.request_id = $1
      ORDER BY h.created_at ASC, h.id ASC`,
    [requestId],
  );
}
