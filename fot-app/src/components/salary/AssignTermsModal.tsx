import { useId, type FC, type FormEvent } from 'react';
import { X } from 'lucide-react';

import type {
  IAssignTermsPayload,
  PayrollCalcType,
  StaffCategory,
} from '../../services/payrollService';
import { usePayrollTermsForm } from '../../hooks/usePayrollTermsForm';
import { payrollFieldId } from '../../utils/payrollTermsForm';
import { ModalShell } from '../ui/ModalShell';
import { PayrollTermsFields } from './PayrollTermsFields';
import styles from './PayrollModal.module.css';

interface IAssignTermsModalProps {
  /** Сколько сотрудников получат условия с общей датой. */
  count: number;
  defaultDate: string;
  isSaving: boolean;
  /** Ошибка сохранения с сервера: окно остаётся открытым, ввод не теряется. */
  saveError: string | null;
  onClose: () => void;
  onSubmit: (payload: IAssignTermsPayload) => void;
  resolveDefaultCalcType: (category: StaffCategory) => PayrollCalcType;
}

/**
 * Массовое назначение условий выделенным сотрудникам: та же форма, что в карточке,
 * без справки (история и отпуска у каждого свои).
 */
export const AssignTermsModal: FC<IAssignTermsModalProps> = ({
  count,
  defaultDate,
  isSaving,
  saveError,
  onClose,
  onSubmit,
  resolveDefaultCalcType,
}) => {
  const titleId = useId();
  const idPrefix = useId();
  const form = usePayrollTermsForm({ row: null, defaultDate, resolveDefaultCalcType });

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (isSaving) return;
    const { payload, firstInvalid } = form.buildPayload();
    if (payload) {
      onSubmit(payload);
      return;
    }
    if (firstInvalid) document.getElementById(payrollFieldId(idPrefix, firstInvalid))?.focus();
  };

  return (
    <ModalShell
      onClose={onClose}
      overlayClassName={styles.overlay}
      containerClassName={styles.container}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <header className={styles.header}>
            <div className={styles.headerText}>
              <h2 id={titleId} className={styles.title}>Условия оплаты</h2>
              <p className={styles.meta}>Назначение выделенным сотрудникам: {count}</p>
            </div>
            <button type="button" className={styles.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={styles.body}>
            <PayrollTermsFields form={form} idPrefix={idPrefix} autoFocus />
          </div>

          <footer className={styles.footer}>
            {saveError && <p className={styles.saveError} role="alert">{saveError}</p>}
            <div className={styles.actions}>
              <button type="button" className={styles.secondaryButton} onClick={requestClose}>
                Отмена
              </button>
              <button type="submit" className={styles.primaryButton} disabled={isSaving}>
                {isSaving ? 'Сохранение…' : 'Сохранить'}
              </button>
            </div>
          </footer>
        </form>
      )}
    </ModalShell>
  );
};
