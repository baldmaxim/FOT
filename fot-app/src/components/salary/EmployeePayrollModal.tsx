import { useId, type FC, type FormEvent } from 'react';
import { X } from 'lucide-react';

import type {
  IAssignTermsPayload,
  IPayrollTermsRow,
  PayrollCalcType,
  StaffCategory,
} from '../../services/payrollService';
import { usePayrollTermsForm } from '../../hooks/usePayrollTermsForm';
import { ModalShell } from '../ui/ModalShell';
import { PayrollTermsFields } from './PayrollTermsFields';
import { EmployeeVacationSection } from './EmployeeVacationSection';
import { SalaryHistorySection } from './SalaryHistorySection';
import styles from './EmployeePayrollModal.module.css';

interface IEmployeePayrollModalProps {
  row: IPayrollTermsRow;
  /** Право на страницу и скоуп правки этого сотрудника; false — только просмотр. */
  canEdit: boolean;
  defaultDate: string;
  isSaving: boolean;
  onClose: () => void;
  onSubmit: (payload: IAssignTermsPayload) => void;
  resolveDefaultCalcType: (category: StaffCategory) => PayrollCalcType;
}

/**
 * Карточка сотрудника в «Условиях оплаты»: в основной колонке форма (Оклад, Премиальная часть,
 * Компенсация — на широком экране в одну строку) и История изменения зарплаты, в узкой боковой —
 * Отпуск. Справка грузится отдельно — её ошибки форму не блокируют.
 */
export const EmployeePayrollModal: FC<IEmployeePayrollModalProps> = ({
  row,
  canEdit,
  defaultDate,
  isSaving,
  onClose,
  onSubmit,
  resolveDefaultCalcType,
}) => {
  const titleId = useId();
  const form = usePayrollTermsForm({ row, defaultDate, resolveDefaultCalcType });
  const meta = [row.department_name, row.position_name].filter(Boolean).join(' · ');

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    if (!canEdit) return;
    const payload = form.buildPayload();
    if (payload) onSubmit(payload);
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
              <p className={styles.subtitle}>{row.full_name ?? 'Сотрудник'}</p>
              {meta && <p className={styles.meta}>{meta}</p>}
            </div>
            <button type="button" className={styles.closeButton} onClick={requestClose} aria-label="Закрыть">
              <X size={20} />
            </button>
          </header>

          <div className={styles.body}>
            <div className={styles.mainColumn}>
              {!canEdit && (
                <p className={styles.readOnlyNote}>Только просмотр: нет права менять условия этого сотрудника.</p>
              )}
              <PayrollTermsFields form={form} readOnly={!canEdit} layout="row" />
              <SalaryHistorySection employeeId={row.employee_id} />
            </div>
            <div className={styles.sideColumn}>
              <EmployeeVacationSection employeeId={row.employee_id} />
            </div>
          </div>

          <footer className={styles.footer}>
            {canEdit && (
              <label className={styles.dateField}>
                <span className={styles.dateLabel}>Действует с</span>
                <input
                  type="date"
                  className={styles.dateInput}
                  value={form.effectiveFrom}
                  onChange={event => form.setEffectiveFrom(event.target.value)}
                  required
                />
              </label>
            )}
            {form.error && <p className={styles.error}>{form.error}</p>}
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
