import { type FC } from 'react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';

interface IUnifiedExportConfirmModalProps {
  /** «Сентябрь 2026». */
  monthLabel: string;
  /** Месяц завершён — закрытие доступно. */
  canCloseMonth: boolean;
  /** true — скачать и закрыть табели, false — только скачать. */
  onAnswer: (closeAfterExport: boolean) => void;
  onCancel: () => void;
}

export const UnifiedExportConfirmModal: FC<IUnifiedExportConfirmModalProps> = ({
  monthLabel,
  canCloseMonth,
  onAnswer,
  onCancel,
}) => {
  const overlayHandlers = useOverlayDismiss(onCancel);

  return (
    <div className="mte-modal-overlay" {...overlayHandlers}>
      <div
        className="mte-modal mte-confirm"
        role="dialog"
        aria-modal="true"
        aria-labelledby="mte-unified-confirm-title"
      >
        <h3 id="mte-unified-confirm-title" className="mte-confirm-title">Единый файл для 1С</h3>
        <p className="mte-confirm-text">Будет скачан единый файл для 1С за {monthLabel}.</p>
        <p className="mte-confirm-text">
          Закрыть табели выбранных отделов за этот месяц после выгрузки?
        </p>
        {!canCloseMonth && (
          <p className="mte-confirm-hint">
            Месяц ещё не завершён — закрыть табели можно после его окончания.
          </p>
        )}
        <div className="mte-confirm-actions">
          <button
            type="button"
            className="mte-confirm-btn mte-confirm-btn--primary"
            onClick={() => onAnswer(true)}
            disabled={!canCloseMonth}
          >
            Да
          </button>
          <button type="button" className="mte-confirm-btn" onClick={() => onAnswer(false)}>
            Нет
          </button>
        </div>
      </div>
    </div>
  );
};
