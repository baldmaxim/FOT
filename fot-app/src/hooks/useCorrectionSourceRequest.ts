import { useQuery } from '@tanstack/react-query';
import { correctionAttachmentsService } from '../services/correctionAttachmentsService';

// Согласование само пишет корректировку: её updated_at расходится с моментом
// согласования на миллисекунды. Допуск — как в SQL сервиса (1 мин).
const APPROVAL_WRITE_TOLERANCE_MS = 60_000;

/**
 * Последняя запись корректировки — это само согласование заявления. Тогда «автор»
 * корректировки (заявитель) и её время (момент согласования) относятся к разным
 * действиям, и вместо них показываем подачу заявления.
 */
export const isWrittenByApproval = (correctedAt: string | null | undefined, reviewedAt: string): boolean => {
  if (!correctedAt) return false;
  const diff = Math.abs(new Date(correctedAt).getTime() - new Date(reviewedAt).getTime());
  return Number.isFinite(diff) && diff <= APPROVAL_WRITE_TOLERANCE_MS;
};

/**
 * Согласованное заявление, из которого получена корректировка. updatedAt в ключе:
 * после правки корректировки ответ другой. Один ключ на карточку — строки «Подано»
 * и «Согласовано» делят один запрос.
 */
export const useCorrectionSourceRequest = (adjustmentId: number | null | undefined, updatedAt?: string | null) => useQuery({
  queryKey: ['correction-source-request', adjustmentId ?? null, updatedAt ?? null],
  queryFn: () => correctionAttachmentsService.getSourceRequest(adjustmentId!),
  enabled: adjustmentId != null,
  staleTime: 60_000,
});
