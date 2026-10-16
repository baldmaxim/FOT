import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  correctionLeaveService,
  type HrCorrectionItem,
  type IHrCorrectionLeave,
  type IHrCorrectionRemoved,
} from '../services/correctionLeaveService';
import { useToast } from '../contexts/ToastContext';
import { getHrCorrectionLeavesQueryKey } from './usePortalData';
import { TIMESHEET_FAMILY_KEYS } from '../api/queryKeys';

/**
 * Действия кадров по отпуску, поставленному корректировкой табеля (вкладка «Отпуска»):
 * «Ознакомлен» (карточка и снятые дни) и «Отказать». markBusy — общий для страницы
 * признак «идёт запрос» по ключу карточки.
 */
export const useHrCorrectionLeaveActions = (markBusy: (key: string, busy: boolean) => void) => {
  const queryClient = useQueryClient();
  const { showToast } = useToast();
  const [rejecting, setRejecting] = useState<IHrCorrectionLeave | null>(null);
  const queryKey = getHrCorrectionLeavesQueryKey();

  const acknowledge = async (item: IHrCorrectionLeave | IHrCorrectionRemoved) => {
    markBusy(item.key, true);
    // Оптимистично проставляем отметку в кэше вкладки до refetch'а.
    const nowIso = new Date().toISOString();
    queryClient.setQueryData<HrCorrectionItem[] | undefined>(
      queryKey,
      (prev) => prev?.map(i => (i.key === item.key ? { ...i, hr_acknowledged_at: nowIso } : i)),
    );
    try {
      if (item.kind === 'correction') await correctionLeaveService.acknowledge(item);
      else await correctionLeaveService.acknowledgeRemoved(item);
    } catch (err) {
      console.error('correction-leave acknowledge error:', err);
      // В т.ч. 409 «Карточка изменилась» — ресинк покажет актуальный состав.
      showToast('error', err instanceof Error ? err.message : 'Не удалось отметить ознакомление');
    } finally {
      await queryClient.invalidateQueries({ queryKey });
      markBusy(item.key, false);
    }
  };

  /** Ошибку пробрасываем в окно отказа: текст причины не теряется. */
  const reject = async (reason: string) => {
    if (!rejecting) return;
    try {
      await correctionLeaveService.reject(rejecting, reason);
    } catch (err) {
      void queryClient.invalidateQueries({ queryKey });
      throw err;
    }
    setRejecting(null);
    showToast('success', 'Отказано: дни сняты из табеля');
    await Promise.all([
      queryClient.invalidateQueries({ queryKey }),
      // Дни ушли из табеля — у открытого табеля обновляется сетка.
      ...TIMESHEET_FAMILY_KEYS.map(key => queryClient.invalidateQueries({ queryKey: key })),
    ]);
  };

  return {
    rejecting,
    startReject: setRejecting,
    cancelReject: () => setRejecting(null),
    acknowledge,
    reject,
  };
};
