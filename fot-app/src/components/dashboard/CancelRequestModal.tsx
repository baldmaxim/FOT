import { type FC, useState } from 'react';
import {
  leaveRequestService,
  isVacationRequestType,
  CANCEL_REASON_MAX_LENGTH,
  REQUEST_TYPE_LABELS,
  type ILeaveRequest,
} from '../../services/leaveRequestService';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import styles from '../../pages/employee/EmployeeDashboard.module.css';

interface ICancelRequestModalProps {
  request: ILeaveRequest;
  onClose: () => void;
  /** Обновлённая заявка после успешной отмены (со следом отмены и ФИО инициатора). */
  onCancelled: (updated: ILeaveRequest) => void;
}

/**
 * Самоотмена заявления сотрудником. Для отпусков причина обязательна — отдел кадров
 * должен видеть, почему отпуск отменён (то же правило продублировано на бэкенде).
 * Ошибку API показываем внутри модалки и не закрываем её, чтобы текст причины не пропал.
 */
export const CancelRequestModal: FC<ICancelRequestModalProps> = ({ request, onClose, onCancelled }) => {
  const isVacation = isVacationRequestType(request.request_type);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const overlayDismiss = useOverlayDismiss(onClose);

  const handleSubmit = async () => {
    const trimmed = reason.trim();
    if (isVacation && !trimmed) {
      setError('Укажите причину отмены отпуска');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      const updated = await leaveRequestService.cancel(request.id, trimmed || undefined);
      onCancelled(updated);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отменить заявление');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className={styles.modalOverlay} {...overlayDismiss}>
      <div className={styles.modal} onClick={e => e.stopPropagation()}>
        <div className={styles.modalHeader}>
          <h2 className={styles.modalTitle}>{isVacation ? 'Отменить отпуск' : 'Отменить заявление'}</h2>
          <button className={styles.modalClose} onClick={onClose} disabled={submitting}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>

        <div className={styles.modalBody}>
          <div className={styles.formGroup}>
            <div className={styles.formLabel}>{REQUEST_TYPE_LABELS[request.request_type]}</div>
            {request.status === 'approved' && (
              <div className={styles.formHint}>
                Заявление уже согласовано — связанные корректировки табеля будут удалены.
              </div>
            )}
          </div>

          <div className={styles.formGroup}>
            <label className={styles.formLabel} htmlFor="cancel-reason">
              Причина отмены {isVacation && <span className={styles.required}>*</span>}
            </label>
            <textarea
              id="cancel-reason"
              className={styles.formTextarea}
              value={reason}
              maxLength={CANCEL_REASON_MAX_LENGTH}
              placeholder={isVacation ? 'Например: перенос отпуска на сентябрь' : 'Необязательно'}
              onChange={e => { setReason(e.target.value); setError(null); }}
            />
          </div>

          {error && <div className={styles.formHint} style={{ color: 'var(--error)' }}>{error}</div>}
        </div>

        <div className={styles.modalFooter}>
          <button className="btn-secondary" onClick={onClose} disabled={submitting}>Назад</button>
          <button className="btn-primary" onClick={handleSubmit} disabled={submitting}>
            {submitting ? 'Отменяем...' : (isVacation ? 'Отменить отпуск' : 'Отменить заявление')}
          </button>
        </div>
      </div>
    </div>
  );
};
