import type { ILeaveRequestBulkResult } from '../services/leaveRequestService';

/**
 * Сводка массового решения человеческим текстом. Считаем ВСЕ категории пропуска:
 * «закрытый табель» — самая частая причина, её нельзя терять в общем числе.
 */
export const formatBulkSummary = (
  verb: 'Согласовано' | 'Отклонено',
  data: ILeaveRequestBulkResult,
): string => {
  // Старый бэк поле не присылает: без «?? 0» сумма стала бы NaN.
  const dayAllocation = data.skipped_day_allocation ?? 0;
  const skipped = data.skipped_not_pending + data.skipped_no_access
    + data.skipped_locked + dayAllocation + data.skipped_failed;
  if (skipped === 0) return `${verb}: ${data.processed_count}`;
  const reasons: string[] = [];
  if (data.skipped_locked > 0) reasons.push(`закрыт табель: ${data.skipped_locked}`);
  if (dayAllocation > 0) reasons.push(`день уже скорректирован в табеле: ${dayAllocation}`);
  if (data.skipped_no_access > 0) reasons.push(`нет доступа: ${data.skipped_no_access}`);
  if (data.skipped_not_pending > 0) reasons.push(`уже обработаны: ${data.skipped_not_pending}`);
  if (data.skipped_failed > 0) reasons.push(`с ошибкой: ${data.skipped_failed}`);
  return `${verb}: ${data.processed_count}, пропущено: ${skipped} (${reasons.join(', ')})`;
};
