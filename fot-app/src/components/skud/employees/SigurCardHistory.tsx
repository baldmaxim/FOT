import type { FC } from 'react';
import { useQuery } from '@tanstack/react-query';
import { sigurAdminService } from '../../../services/sigurAdminService';
import { describeSigurCardHistoryEntry, formatSigurCardHistoryMoment, sigurCardHistoryQueryKey } from './sigurCardHistory.helpers';

interface ISigurCardHistoryProps {
  sigurEmployeeId: number;
  cardId: number;
  panelId: string;
}

export const SigurCardHistory: FC<ISigurCardHistoryProps> = ({ sigurEmployeeId, cardId, panelId }) => {
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
    content = (
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
    );
  }

  return (
    <div id={panelId} className="ep-sigur-card-history">
      {content}
    </div>
  );
};
