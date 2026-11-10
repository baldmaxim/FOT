/** Помощники записи окна «Режим табелирования» (timesheet-office.service.ts). */
import { TimesheetOfficeError } from './timesheet-office-error.js';
import { isRetryableDbError } from './timesheet-snapshot-tx.js';

const MAX_ATTEMPTS = 3;

export interface ITimesheetOfficeObjectAssignment {
  id: number;
  object_id: string;
}

/** Повтор транзакции при 40001/40P01; после последней неудачи — 409. */
export async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof TimesheetOfficeError || !isRetryableDbError(err)) throw err;
      if (attempt >= MAX_ATTEMPTS) {
        throw new TimesheetOfficeError(
          409, 'TIMESHEET_OFFICE_BUSY', 'Не удалось сохранить из-за параллельных изменений — повторите',
        );
      }
      console.warn(`[timesheet-office] повтор ${attempt}/${MAX_ATTEMPTS - 1}`);
    }
  }
}

/**
 * objects из запроса → id → объект. Одинаковые пары схлопываются; один сотрудник с разными
 * объектами — 400. Регистр uuid не важен.
 */
export function normalizeObjectAssignments(items: readonly ITimesheetOfficeObjectAssignment[]): Map<number, string> {
  const targets = new Map<number, string>();
  const conflicting = new Set<number>();
  for (const item of items) {
    const objectId = item.object_id.toLowerCase();
    const current = targets.get(item.id);
    if (current !== undefined && current !== objectId) conflicting.add(item.id);
    else targets.set(item.id, objectId);
  }
  if (conflicting.size > 0) {
    throw new TimesheetOfficeError(
      400, 'TIMESHEET_OFFICE_INVALID', 'Одному сотруднику — разные объекты', [...conflicting].sort((a, b) => a - b),
    );
  }
  return targets;
}
