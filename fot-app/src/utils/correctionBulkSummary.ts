import type { IBulkResult } from '../services/correctionApprovalService';

/**
 * Сводка массового решения по корректировкам. «Закрыт табель» называем отдельно:
 * без причины согласующий видел успешное «Утверждено: 0» и не понимал, что решение не записано.
 */
export const formatCorrectionBulkSummary = (
  verb: 'Утверждено' | 'Отклонено' | 'Возвращено',
  data: IBulkResult,
): string => {
  // Старый бэк поле не присылает: без «?? 0» сумма стала бы NaN.
  const locked = data.skipped_locked ?? 0;
  const skipped = data.skipped_not_pending + data.skipped_no_access + locked;
  if (skipped === 0) return `${verb}: ${data.processed_count}`;
  const reasons: string[] = [];
  if (locked > 0) reasons.push(`закрыт табель: ${locked}`);
  if (data.skipped_no_access > 0) reasons.push(`нет доступа: ${data.skipped_no_access}`);
  if (data.skipped_not_pending > 0) reasons.push(`уже обработаны: ${data.skipped_not_pending}`);
  return `${verb}: ${data.processed_count}, пропущено: ${skipped} (${reasons.join(', ')})`;
};
