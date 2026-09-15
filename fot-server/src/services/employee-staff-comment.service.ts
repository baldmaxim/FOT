/**
 * Комментарий HR к сотруднику («Управление кадрами», столбец «Комментарий»; миграция 281).
 *
 * Запись идемпотентна и защищена от потерянных обновлений: клиент присылает версию, которую
 * видел (expected_updated_at: null — комментария не было). Сравнение, запись и аудит — в одной
 * транзакции под FOR UPDATE строки employees, поэтому два одновременных «первых» комментария
 * не перезапишут друг друга молча: второй получит конфликт.
 */
import type { Request } from 'express';
import type { PoolClient } from 'pg';
import { withTransaction } from '../config/postgres.js';
import { auditService } from './audit.service.js';

export const STAFF_COMMENT_MAX_LENGTH = 2000;

/** Версия как текст с микросекундами: JSON-дата обрезала бы до миллисекунд и ломала сравнение. */
const VERSION_SQL = (column: string): string =>
  `to_char(${column} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/** Колонки комментария для списка сотрудников (таблица employees без алиаса). */
export const STAFF_COMMENT_LIST_COLUMNS_SQL = `
  (SELECT c.comment FROM employee_staff_comments c WHERE c.employee_id = employees.id) AS staff_comment,
  (SELECT ${VERSION_SQL('c.updated_at')} FROM employee_staff_comments c WHERE c.employee_id = employees.id) AS staff_comment_updated_at,
  (SELECT up.full_name FROM employee_staff_comments c LEFT JOIN user_profiles up ON up.id = c.updated_by
    WHERE c.employee_id = employees.id) AS staff_comment_updated_by_name`;

export interface IStaffComment {
  comment: string;
  updated_at: string;
  updated_by_name: string | null;
}

export type StaffCommentDecision =
  | { kind: 'conflict' }
  | { kind: 'noop' }
  | { kind: 'delete' }
  | { kind: 'upsert' };

/** Чистое решение по текущему состоянию, версии клиента и новому тексту (уже trim). */
export function decideStaffCommentChange(
  current: IStaffComment | null,
  expectedUpdatedAt: string | null,
  nextComment: string,
): StaffCommentDecision {
  const currentVersion = current?.updated_at ?? null;
  if (currentVersion !== expectedUpdatedAt) return { kind: 'conflict' };
  if (nextComment === '') return current ? { kind: 'delete' } : { kind: 'noop' };
  if (current && current.comment === nextComment) return { kind: 'noop' };
  return { kind: 'upsert' };
}

export type SaveStaffCommentResult =
  | { status: 'not_found' }
  | { status: 'conflict'; current: IStaffComment | null }
  | { status: 'ok'; changed: boolean; current: IStaffComment | null };

interface ISaveStaffCommentInput {
  req: Request;
  userId: string;
  employeeId: number;
  comment: string;
  expectedUpdatedAt: string | null;
}

async function readComment(client: PoolClient, employeeId: number): Promise<IStaffComment | null> {
  const { rows } = await client.query<IStaffComment>(
    `SELECT c.comment, ${VERSION_SQL('c.updated_at')} AS updated_at, up.full_name AS updated_by_name
       FROM employee_staff_comments c
       LEFT JOIN user_profiles up ON up.id = c.updated_by
      WHERE c.employee_id = $1`,
    [employeeId],
  );
  return rows[0] ?? null;
}

export async function saveStaffComment(input: ISaveStaffCommentInput): Promise<SaveStaffCommentResult> {
  const { req, userId, employeeId, expectedUpdatedAt } = input;
  const nextComment = input.comment.trim();

  return withTransaction(async client => {
    const locked = await client.query('SELECT id FROM employees WHERE id = $1 FOR UPDATE', [employeeId]);
    if (locked.rowCount === 0) return { status: 'not_found' };

    const current = await readComment(client, employeeId);
    const decision = decideStaffCommentChange(current, expectedUpdatedAt, nextComment);
    if (decision.kind === 'conflict') return { status: 'conflict', current };
    if (decision.kind === 'noop') return { status: 'ok', changed: false, current };

    if (decision.kind === 'delete') {
      await client.query('DELETE FROM employee_staff_comments WHERE employee_id = $1', [employeeId]);
    } else {
      await client.query(
        `INSERT INTO employee_staff_comments (employee_id, comment, updated_by, updated_at)
         VALUES ($1, $2, $3, clock_timestamp())
         ON CONFLICT (employee_id) DO UPDATE
           SET comment = EXCLUDED.comment, updated_by = EXCLUDED.updated_by, updated_at = EXCLUDED.updated_at`,
        [employeeId, nextComment, userId],
      );
    }
    const saved = decision.kind === 'delete' ? null : await readComment(client, employeeId);

    // Аудит в той же транзакции: ошибка записи аудита откатывает изменение.
    await auditService.logFromRequestWithClient(client, req, userId, 'UPDATE_STAFF_COMMENT', {
      entityType: 'employee',
      entityId: String(employeeId),
      details: { employee_id: employeeId, old: current?.comment ?? null, new: saved?.comment ?? null },
    });
    return { status: 'ok', changed: true, current: saved };
  });
}
