import { useEffect, useId, useRef, type FC, type FormEvent } from 'react';
import { X } from 'lucide-react';

import type {
  IAssignTermsPayload,
  IPayrollTermsRow,
  PayrollCalcType,
  StaffCategory,
} from '../../services/payrollService';
import { usePayrollTermsForm } from '../../hooks/usePayrollTermsForm';
import { payrollFieldId } from '../../utils/payrollTermsForm';
import { ModalShell } from '../ui/ModalShell';
import { PayrollTermsFields } from './PayrollTermsFields';
import { EmployeeVacationSection } from './EmployeeVacationSection';
import { SalaryHistorySection } from './SalaryHistorySection';
import styles from './PayrollModal.module.css';

interface IEmployeePayrollModalProps {
  row: IPayrollTermsRow;
  /** Право на страницу и скоуп правки этого сотрудника; false — только просмотр. */
  canEdit: boolean;
  defaultDate: string;
  isSaving: boolean;
  /** Ошибка сохранения с сервера: окно остаётся открытым, ввод не теряется. */
  saveError: string | null;
  onClose: () => void;
  onSubmit: (payload: IAssignTermsPayload) => void;
  resolveDefaultCalcType: (category: StaffCategory) => PayrollCalcType;
}

const DISCARD_QUESTION = 'Есть несохранённые изменения. Закрыть без сохранения?';

/**
 * Карточка сотрудника в «Условиях оплаты»: компактная форма (основная оплата, дополнительные
 * суммы, удержание) и под ней свёрнутая справка — история изменений и отпуска. Справка грузится
 * отдельно, её ошибки форму не блокируют.
 */
export const EmployeePayrollModal: FC<IEmployeePayrollModalProps> = ({
  row,
  canEdit,
  defaultDate,
  isSaving,
  saveError,
  onClose,
  onSubmit,
  resolveDefaultCalcType,
}) => {
  const titleId = useId();
  const idPrefix = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const form = usePayrollTermsForm({ row, defaultDate, resolveDefaultCalcType });
  const meta = [row.department_name, row.position_name].filter(Boolean).join(' · ');

  // В режиме просмотра полей для ввода нет — фокус на крестик, чтобы Tab/Escape работали сразу.
  useEffect(() => {
    if (!canEdit) closeRef.current?.focus();
  }, [canEdit]);

  /** Крестик, «Отмена», Escape и клик по фону: несохранённые правки молча не теряем. */
  const confirmDiscard = () => !canEdit || !form.isDirty || window.confirm(DISCARD_QUESTION);

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canEdit || isSaving) return;
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
      onBeforeClose={confirmDiscard}
      overlayClassName={styles.overlay}
      containerClassName={styles.container}
      aria-labelledby={titleId}
    >
      {({ requestClose }) => (
        <form className={styles.form} onSubmit={handleSubmit} noValidate>
          <header className={styles.header}>
            <div className={styles.headerText}>
              <h2 id={titleId} className={styles.title}>Условия оплаты</h2>
              <p className={styles.name}>{row.full_name ?? 'Сотрудник'}</p>
              {meta && <p className={styles.meta}>{meta}</p>}
            </div>
            <button
              ref={closeRef}
              type="button"
              className={styles.closeButton}
              onClick={requestClose}
              aria-label="Закрыть"
            >
              <X size={20} aria-hidden="true" />
            </button>
          </header>

          <div className={styles.body}>
            {!canEdit && (
              <p className={styles.readOnlyNote}>Только просмотр: нет права менять условия этого сотрудника.</p>
            )}
            <PayrollTermsFields form={form} idPrefix={idPrefix} readOnly={!canEdit} autoFocus={canEdit} />

            <div className={styles.reference}>
              <SalaryHistorySection employeeId={row.employee_id} />
              <EmployeeVacationSection employeeId={row.employee_id} />
            </div>
          </div>

          <footer className={styles.footer}>
            {saveError && <p className={styles.saveError} role="alert">{saveError}</p>}
            <div className={styles.actions}>
              <button type="button" className={styles.secondaryButton} onClick={requestClose}>
                {canEdit ? 'Отмена' : 'Закрыть'}
              </button>
              {canEdit && (
                <button type="submit" className={styles.primaryButton} disabled={isSaving}>
                  {isSaving ? 'Сохранение…' : 'Сохранить'}
                </button>
              )}
            </div>
          </footer>
        </form>
      )}
    </ModalShell>
  );
};
