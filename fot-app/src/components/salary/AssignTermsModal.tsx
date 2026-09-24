import { useId, type FC, type FormEvent } from 'react';

import type {
  IAssignTermsPayload,
  PayrollCalcType,
  StaffCategory,
} from '../../services/payrollService';
import { usePayrollTermsForm } from '../../hooks/usePayrollTermsForm';
import { ModalShell } from '../ui/ModalShell';
import { PayrollTermsFields } from './PayrollTermsFields';
import styles from './AssignTermsModal.module.css';

interface IAssignTermsModalProps {
  /** Сколько сотрудников получат условия с общей датой. */
  count: number;
  defaultDate: string;
  isSaving: boolean;
  onClose: () => void;
  onSubmit: (payload: IAssignTermsPayload) => void;
  resolveDefaultCalcType: (category: StaffCategory) => PayrollCalcType;
}

/**
 * Массовое назначение условий выделенным сотрудникам: та же форма, что в карточке,
 * без отпуска и истории (они у каждого свои). Дата и кнопки закреплены внизу.
 */
export const AssignTermsModal: FC<IAssignTermsModalProps> = ({
  count,
  defaultDate,
  isSaving,
  onClose,
  onSubmit,
  resolveDefaultCalcType,
}) => {
  const titleId = useId();
  const form = usePayrollTermsForm({ row: null, defaultDate, resolveDefaultCalcType });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    const payload = form.buildPayload();
    if (payload) onSubmit(payload);
  };

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={styles.overlay}
      containerClassName={styles.modal}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <h2 id={titleId} className={styles.title}>Условия оплаты: {count} сотрудников</h2>

          <div className={styles.body}>
            <PayrollTermsFields form={form} />
          </div>

          <div className={styles.footer}>
            <label className={styles.dateField}>
              <span className={styles.label}>Действует с</span>
              <input
                type="date"
                className={styles.input}
                value={form.effectiveFrom}
                onChange={event => form.setEffectiveFrom(event.target.value)}
                required
              />
            </label>
            {form.error && <p className={styles.error}>{form.error}</p>}
            <div className={styles.actions}>
              <button type="button" className={styles.secondaryButton} onClick={requestClose}>
                Отмена
              </button>
              <button type="submit" className={styles.primaryButton} disabled={isSaving}>
                {isSaving ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </div>
        </form>
      )}
    </ModalShell>
  );
};
