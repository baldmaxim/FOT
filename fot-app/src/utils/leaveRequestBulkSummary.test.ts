import { describe, it, expect } from 'vitest';
import { formatBulkSummary } from './leaveRequestBulkSummary';
import type { ILeaveRequestBulkResult } from '../services/leaveRequestService';

/** Ответ старого бэка: полей skipped_day_allocation / day_allocation_ids ещё нет. */
const OLD_EMPTY: ILeaveRequestBulkResult = {
  processed_count: 0,
  processed_ids: [],
  skipped_not_pending: 0,
  skipped_no_access: 0,
  skipped_locked: 0,
  locked_ids: [],
  skipped_failed: 0,
  failed_ids: [],
};

describe('formatBulkSummary', () => {
  it('день уже распределён по объектам в табеле — причина названа, а не «с ошибкой»', () => {
    expect(formatBulkSummary('Согласовано', {
      ...OLD_EMPTY,
      skipped_day_allocation: 1,
      day_allocation_ids: [8836],
    })).toBe('Согласовано: 0, пропущено: 1 (день уже скорректирован в табеле: 1)');
  });

  it('ответ старого бэка без новых полей — прежний текст, без NaN', () => {
    expect(formatBulkSummary('Согласовано', {
      ...OLD_EMPTY,
      processed_count: 3,
      processed_ids: [1, 2, 3],
    })).toBe('Согласовано: 3');
    expect(formatBulkSummary('Согласовано', {
      ...OLD_EMPTY,
      skipped_failed: 1,
      failed_ids: [8836],
    })).toBe('Согласовано: 0, пропущено: 1 (с ошибкой: 1)');
  });
});
