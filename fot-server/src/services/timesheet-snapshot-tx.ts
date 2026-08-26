// Транзакция для материализации официальной версии табеля.
//
// Живёт отдельным модулем, а не в config/postgres.ts, чтобы не заводить цикл
// импортов: timesheet-lock.service.ts сам импортирует postgres.ts.
//
// Порядок шагов здесь ЖЁСТКИЙ и инкапсулирован намеренно — на месте вызова его
// нельзя нарушить.

import type { PoolClient } from 'pg';
import { pool } from '../config/postgres.js';
import {
  lockTimesheetMonthsSession,
  unlockTimesheetMonthsSession,
  type ITimesheetLockPair,
} from './timesheet-lock.service.js';

/** Коды PostgreSQL, при которых транзакцию имеет смысл повторить целиком. */
const RETRYABLE_SQL_STATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
  '23505', // unique_violation — страховочный UNIQUE (approval_id, revision)
]);

const MAX_ATTEMPTS = 3; // первая попытка + два повтора

function sqlState(err: unknown): string | null {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : null;
}

export function isRetryableDbError(err: unknown): boolean {
  const state = sqlState(err);
  return state !== null && RETRYABLE_SQL_STATES.has(state);
}

/**
 * Выполняет fn под advisory-локами (сотрудник, месяц) и в транзакции REPEATABLE READ.
 *
 * Последовательность:
 *   1. выделенный клиент из пула;
 *   2. SESSION-level advisory-локи — ДО BEGIN;
 *   3. BEGIN ISOLATION LEVEL REPEATABLE READ;
 *   4. fn(client) — все чтения и записи ТОЛЬКО через этого клиента;
 *   5. COMMIT / ROLLBACK;
 *   6. снятие локов в finally, до возврата клиента в пул.
 *
 * Почему локи берутся до BEGIN: PostgreSQL фиксирует snapshot REPEATABLE READ на
 * первом запросе транзакции. Если первым запросом сделать advisory-lock, ожидающий
 * чужую корректировку, то после её коммита транзакция продолжит видеть состояние
 * ДО неё — правка потерялась бы в официальной версии.
 *
 * Повтор: при 40001 / 40P01 / 23505 транзакция откатывается целиком и выполняется
 * заново с новым snapshot (после ошибки продолжать её нельзя — она aborted).
 * Побочные эффекты (аудит, уведомления, socket) вызывающий обязан делать ПОСЛЕ
 * возврата из этой функции, иначе повтор разошлёт их дважды.
 */
export async function withTimesheetSnapshotTransaction<T>(
  pairs: readonly ITimesheetLockPair[],
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const client = await pool().connect();
    let acquired: Array<{ employeeId: number; month: number }> = [];
    let locksReleased = true;

    try {
      // 2. Локи — до снимка.
      acquired = await lockTimesheetMonthsSession(client, pairs);

      // 3. Снимок фиксируется на первом чтении внутри fn, уже под локами.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      try {
        const result = await fn(client);
        await client.query('COMMIT');
        return result;
      } catch (err) {
        try {
          await client.query('ROLLBACK');
        } catch {
          // ROLLBACK на уже сломанном коннекте — игнорируем, клиент всё равно уйдёт.
        }
        throw err;
      }
    } catch (err) {
      lastError = err;
      if (!isRetryableDbError(err) || attempt === MAX_ATTEMPTS) throw err;
      console.warn(
        `[timesheet-snapshot] retry ${attempt}/${MAX_ATTEMPTS - 1} после ${sqlState(err)}`,
      );
    } finally {
      if (acquired.length > 0) {
        locksReleased = await unlockTimesheetMonthsSession(client, acquired);
      }
      // Session-лок переживает транзакцию: соединение с неснятым локом отравит
      // следующего потребителя пула — уничтожаем его.
      if (locksReleased) {
        client.release();
      } else {
        console.error('[timesheet-snapshot] не удалось снять advisory-локи — соединение уничтожено');
        client.release(true);
      }
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Timesheet snapshot transaction failed');
}
