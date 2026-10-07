import type { FC } from 'react';
import type { SigurEmployeeBlockInfo } from '../../../types';
import { formatSigurCardHistoryMoment } from './sigurCardHistory.helpers';

interface ISigurBlockReasonProps {
  isLoading: boolean;
  isError: boolean;
  info: SigurEmployeeBlockInfo | null | undefined;
}

/**
 * Кто, когда и почему заблокировал. Записи нет — нейтральный текст: блокировку
 * могли поставить увольнение, чёрный список, подрядчики или Sigur напрямую.
 */
export const SigurBlockReason: FC<ISigurBlockReasonProps> = ({ isLoading, isError, info }) => {
  if (isLoading) {
    return <div className="ep-sigur-block-reason">Загрузка...</div>;
  }
  if (isError) {
    return <div className="ep-sigur-block-reason error">Не удалось загрузить причину блокировки</div>;
  }
  if (!info) {
    return <div className="ep-sigur-block-reason">Причина блокировки не указана</div>;
  }
  return (
    <div className="ep-sigur-block-reason">
      Заблокирован {formatSigurCardHistoryMoment(info.blockedAt)} · {info.blockedByName || 'Система'}
      {' — '}
      {info.reason || 'причина не указана'}
    </div>
  );
};
