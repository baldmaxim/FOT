import { useCallback, useEffect, useId, useState, type FC, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import '../../../styles/EmployeesPage.css';

/** Совпадает с пределом бэкенда (MAX_BLOCK_REASON_LENGTH). */
const MAX_REASON_LENGTH = 500;

interface ISigurBlockDialogProps {
  mode: 'block' | 'unblock';
  fullName: string;
  saving: boolean;
  error: string;
  /** Для разблокировки: кто, когда и почему заблокировал. */
  blockReason?: ReactNode;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}

export const SigurBlockDialog: FC<ISigurBlockDialogProps> = ({
  mode,
  fullName,
  saving,
  error,
  blockReason,
  onConfirm,
  onClose,
}) => {
  const [reason, setReason] = useState('');
  const titleId = useId();
  const reasonId = useId();

  const requestClose = useCallback(() => {
    if (!saving) onClose();
  }, [saving, onClose]);
  const overlayDismiss = useOverlayDismiss(requestClose);

  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') requestClose();
    };
    document.addEventListener('keydown', handleKey);
    return () => document.removeEventListener('keydown', handleKey);
  }, [requestClose]);

  const trimmedReason = reason.trim();
  const isBlock = mode === 'block';
  const canConfirm = !saving && (!isBlock || trimmedReason.length > 0);

  // Портал: на мобильном сайдбар лежит в листе с transform, и fixed-оверлей
  // внутри него считался бы от листа, а не от экрана.
  return createPortal(
    <div className="ep-modal-overlay ep-sigur-block-overlay" {...overlayDismiss}>
      <div className="ep-modal ep-sigur-block-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="ep-modal-header">
          <div id={titleId} className="ep-modal-title">
            {isBlock ? 'Блокировка сотрудника' : 'Разблокировка сотрудника'}
          </div>
        </div>
        <div className="ep-modal-body ep-sigur-block-body">
          <div className="ep-sigur-block-name">{fullName}</div>
          {isBlock ? (
            <>
              <label htmlFor={reasonId} className="ep-sigur-block-label">Причина блокировки</label>
              <textarea
                id={reasonId}
                className="ep-modal-input ep-sigur-block-textarea"
                value={reason}
                onChange={event => setReason(event.target.value)}
                maxLength={MAX_REASON_LENGTH}
                rows={4}
                autoFocus
                disabled={saving}
              />
            </>
          ) : blockReason}
          {error && <div className="ep-sigur-inline-error">{error}</div>}
        </div>
        <div className="ep-modal-footer">
          <button type="button" className="ep-modal-btn secondary" onClick={requestClose} disabled={saving}>
            Отмена
          </button>
          <button
            type="button"
            className={`ep-modal-btn ${isBlock ? 'danger' : 'primary'}`}
            onClick={() => onConfirm(trimmedReason)}
            disabled={!canConfirm}
          >
            {saving ? 'Сохранение...' : isBlock ? 'Заблокировать' : 'Разблокировать'}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
