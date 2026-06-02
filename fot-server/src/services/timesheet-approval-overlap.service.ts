import type { TimesheetApproval } from '../types/index.js';
import type { ITimesheetDateRange } from './timesheet-range.service.js';

export interface OverlapResolution {
  /** Утверждённая подача, пересекающая диапазон. Блокирует переподачу. */
  approvedOverlap: TimesheetApproval | null;
  /** Подача ровно за тот же диапазон (любого статуса). */
  exactSame: TimesheetApproval | null;
  /**
   * Строка, которую переиспользуем под новую подачу (UPDATE диапазона + статус
   * 'submitted'), сохраняя историю событий: приоритет — активная
   * (submitted/returned), иначе точное совпадение (draft/rejected). null → INSERT.
   */
  reuseRow: TimesheetApproval | null;
  /**
   * Прочие пересекающиеся НЕутверждённые подачи того же скоупа — вытесняются
   * (удаляются). approved сюда не входит (блокируется отдельно).
   */
  toDeleteIds: number[];
}

/**
 * Разрешает переподачу при пересечении диапазонов (политика «вытеснять»).
 * Зеркалит EXCLUDE-констрейнты миграции 122: в одном скоупе одновременно может
 * пересекаться ≤1 строки со статусом из (submitted, approved, returned).
 *
 * @param overlaps все подачи того же скоупа, пересекающие новый диапазон
 * @param range    новый диапазон подачи
 */
export function resolveOverlapSubmission(
  overlaps: TimesheetApproval[],
  range: ITimesheetDateRange,
): OverlapResolution {
  const approvedOverlap = overlaps.find(a => a.status === 'approved') ?? null;
  const activeOverlap = overlaps.find(a => a.status === 'submitted' || a.status === 'returned') ?? null;
  const exactSame = overlaps.find(
    a => a.start_date === range.startDate && a.end_date === range.endDate,
  ) ?? null;
  const reuseRow = activeOverlap ?? exactSame;
  const toDeleteIds = overlaps
    .filter(a => a.status !== 'approved' && a.id !== reuseRow?.id)
    .map(a => a.id);
  return { approvedOverlap, exactSame, reuseRow, toDeleteIds };
}
