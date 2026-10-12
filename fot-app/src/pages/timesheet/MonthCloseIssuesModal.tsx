import { type FC } from 'react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { IMonthCloseIssue } from '../../utils/timesheetMonthClose';

interface IMonthCloseIssuesModalProps {
  issues: IMonthCloseIssue[];
  /** Закрытие остановлено целиком (нет прав, сервер не отвечает). */
  fatalError: string | null;
  onClose: () => void;
}

export const MonthCloseIssuesModal: FC<IMonthCloseIssuesModalProps> = ({ issues, fatalError, onClose }) => {
  const overlayHandlers = useOverlayDismiss(onClose);

  return (
    <div className="mte-modal-overlay" {...overlayHandlers}>
      <div
        className="mte-modal mte-confirm mte-confirm--wide"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mte-close-issues-title"
      >
        <h3 id="mte-close-issues-title" className="mte-confirm-title">
          {issues.length > 0 ? `Не закрыты табели: ${issues.length}` : 'Табели не закрыты'}
        </h3>
        {fatalError && <p className="mte-confirm-error">{fatalError}</p>}
        {issues.length > 0 && (
          <ul className="mte-confirm-list">
            {issues.map((issue, index) => (
              <li key={`${issue.departmentId}-${index}`} className="mte-confirm-item">
                <span className="mte-confirm-item-name">{issue.departmentName}</span>
                {issue.periodLabel ? ` — ${issue.periodLabel}` : ''}
                {` — ${issue.reason}`}
              </li>
            ))}
          </ul>
        )}
        <div className="mte-confirm-actions">
          <button type="button" className="mte-confirm-btn mte-confirm-btn--primary" onClick={onClose}>
            Закрыть
          </button>
        </div>
      </div>
    </div>
  );
};
