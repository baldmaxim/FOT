import { describe, it, expect } from 'vitest';
import { formatCorrectionBulkSummary } from './correctionBulkSummary';
import type { IBulkResult } from '../services/correctionApprovalService';

const EMPTY: IBulkResult = {
  processed_count: 0,
  skipped_not_pending: 0,
  skipped_no_access: 0,
  skipped_locked: 0,
};

describe('formatCorrectionBulkSummary', () => {
  it('всё обработано — без пропусков', () => {
    expect(formatCorrectionBulkSummary('Утверждено', { ...EMPTY, processed_count: 3 })).toBe('Утверждено: 3');
  });

  it('пакет целиком пропущен из-за закрытого табеля — причина названа', () => {
    expect(formatCorrectionBulkSummary('Утверждено', { ...EMPTY, skipped_locked: 2 }))
      .toBe('Утверждено: 0, пропущено: 2 (закрыт табель: 2)');
  });

  it('частично обработанный пакет — все причины пропуска', () => {
    expect(formatCorrectionBulkSummary('Отклонено', {
      processed_count: 4,
      skipped_locked: 1,
      skipped_no_access: 2,
      skipped_not_pending: 3,
    })).toBe('Отклонено: 4, пропущено: 6 (закрыт табель: 1, нет доступа: 2, уже обработаны: 3)');
  });

  it('ответ старого бэка без skipped_locked — без NaN', () => {
    const legacy = { processed_count: 1, skipped_not_pending: 1, skipped_no_access: 0 } as IBulkResult;
    expect(formatCorrectionBulkSummary('Возвращено', legacy)).toBe('Возвращено: 1, пропущено: 1 (уже обработаны: 1)');
  });
});
