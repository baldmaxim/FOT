import { type FC, useState } from 'react';
import { X } from 'lucide-react';
import { ModalShell } from '../ui/ModalShell';
import { ClearableInput } from '../ui/ClearableInput';
import {
  CORRECTION_REJECT_REASON_MAX_LENGTH,
  type IHrCorrectionLeave,
} from '../../services/correctionLeaveService';
import { REQUEST_TYPE_LABELS } from '../../services/leaveRequestService';
import { formatDaysCompact } from '../../utils/hrAckItems';
import styles from './HrCorrectionRejectModal.module.css';

interface IHrCorrectionRejectModalProps {
  item: IHrCorrectionLeave;
  onClose: () => void;
  /** Бросает ошибку API — текст показываем в окне, причина не теряется. */
  onSubmit: (reason: string) => Promise<void>;
}

/** «Отказать» по отпуску корректировкой: причина обязательна, дни снимаются из табеля. */
export const HrCorrectionRejectModal: FC<IHrCorrectionRejectModalProps> = ({ item, onClose, onSubmit }) => {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async () => {
    const trimmed = reason.trim();
    if (!trimmed) {
      setError('Укажите причину отказа');
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await onSubmit(trimmed);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось отказать');
      setSubmitting(false);
    }
  };

  return (
    <ModalShell
      onClose={onClose}
      closeOnEscape={!submitting}
      overlayClassName={styles.overlay}
      containerClassName={styles.modal}
      aria-labelledby="hr-correction-reject-title"
    >
      {({ requestClose }) => (
        <>
          <div className={styles.header}>
            <h3 id="hr-correction-reject-title" className={styles.title}>Отказать</h3>
            <button
              type="button"
              className={styles.closeBtn}
              onClick={requestClose}
              disabled={submitting}
              aria-label="Закрыть"
            >
              <X size={18} />
            </button>
          </div>
          <div className={styles.body}>
            <div className={styles.summary}>
              <strong>{item.employee_name ?? `#${item.employee_id}`}</strong>
              {' · '}
              {REQUEST_TYPE_LABELS[item.leave_status]}
              {' · '}
              {formatDaysCompact(item.days)}
            </div>
            <div className={styles.hint}>
              Дни будут сняты из табеля. Сотрудник и автор корректировки получат уведомление с причиной.
            </div>
            <label className={styles.label} htmlFor="hr-correction-reject-reason">Причина отказа</label>
            <ClearableInput
              id="hr-correction-reject-reason"
              value={reason}
              onValueChange={(next) => { setReason(next); setError(null); }}
              clearLabel="Очистить причину"
              maxLength={CORRECTION_REJECT_REASON_MAX_LENGTH}
              placeholder="Например: нужно заявление сотрудника"
              disabled={submitting}
              aria-invalid={error ? true : undefined}
              autoFocus
            />
            {error && <div className={styles.error} role="alert">{error}</div>}
          </div>
          <div className={styles.footer}>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnSecondary}`}
              onClick={requestClose}
              disabled={submitting}
            >
              Назад
            </button>
            <button
              type="button"
              className={`${styles.btn} ${styles.btnDanger}`}
              onClick={() => { void handleSubmit(); }}
              disabled={submitting}
            >
              {submitting ? 'Отказываем…' : 'Отказать'}
            </button>
          </div>
        </>
      )}
    </ModalShell>
  );
};
