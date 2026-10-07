import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sigurAdminService } from '../../../services/sigurAdminService';
import {
  describeSigurCardHistoryEntry,
  findSigurCardExpirationMismatch,
  formatSigurCardHistoryMoment,
  sigurCardHistoryQueryKey,
} from './sigurCardHistory.helpers';

interface ISigurCardHistoryProps {
  sigurEmployeeId: number;
  cardId: number;
  panelId: string;
  /** Текущий срок карты из профиля — для пометки, если он не из журнала FOT. */
  currentExpiration: string | null;
}

export const SigurCardHistory: FC<ISigurCardHistoryProps> = ({
  sigurEmployeeId,
  cardId,
  panelId,
  currentExpiration,
}) => {
  const historyQuery = useQuery({
    queryKey: sigurCardHistoryQueryKey(sigurEmployeeId, cardId),
    queryFn: () => sigurAdminService.getEmployeeCardHistory(sigurEmployeeId, cardId),
  });

  let content;
  if (historyQuery.isPending) {
    content = <div className="ep-sigur-card-history-note">Загрузка...</div>;
  } else if (historyQuery.isError) {
    content = <div className="ep-sigur-card-history-note error">Не удалось загрузить историю карты</div>;
  } else if (historyQuery.data.length === 0) {
    content = <div className="ep-sigur-card-history-note">Изменений не найдено</div>;
  } else {
    // Пока список перечитывается после сохранения, срок профиля уже новый, а
    // записи ещё старые — пометка мигнула бы.
    const mismatch = historyQuery.isFetching
      ? null
      : findSigurCardExpirationMismatch(historyQuery.data, currentExpiration);
    content = (
      <>
        <ul className="ep-sigur-card-history-list">
          {historyQuery.data.map(entry => (
            <li key={entry.id} className="ep-sigur-card-history-item">
              <div className="ep-sigur-card-history-meta">
                {formatSigurCardHistoryMoment(entry.createdAt)} · {entry.actorName || 'Система'}
              </div>
              <div className="ep-sigur-card-history-text">{describeSigurCardHistoryEntry(entry)}</div>
            </li>
          ))}
        </ul>
        {mismatch && (
          <div className="ep-sigur-card-history-note warning">
            Текущий срок {mismatch} в журнале FOT не записан — возможно, изменён в Sigur напрямую
          </div>
        )}
      </>
    );
  }

  return (
    <div id={panelId} className="ep-sigur-card-history">
      {content}
    </div>
  );
};
