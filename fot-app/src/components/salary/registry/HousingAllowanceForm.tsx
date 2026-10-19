import { useId, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import {
  payrollRegistryService,
  type IHousingAllowanceRow,
  type IPayrollRegistryCandidate,
} from '../../../services/payrollRegistryService';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { rateAmountInputValue } from '../../../utils/payrollDictionary';
import { parseHousingForm, type RegistryFormField } from '../../../utils/payrollRegistryForms';
import { ClearableInput } from '../../ui/ClearableInput';
import { DateInput } from '../../ui/DateInput';
import { EmployeeSearchField } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';

interface IHousingAllowanceFormProps {
  /** Передано — ✎ этой строки (сотрудник не меняется); нет — «Добавить сотрудника». */
  row?: IHousingAllowanceRow;
  /** Значение ставки «Доплата за проживание» — сумма по умолчанию при добавлении. */
  defaultAmount: string | number | null;
  onClose: () => void;
  onSaved: () => void;
}

const isNotEditable = (candidate: IPayrollRegistryCandidate): boolean => !candidate.can_edit;

/**
 * «Добавить сотрудника» / ✎ в «Доплате за проживание»: сотрудник, сумма ₽/мес, «Действует с». Пишется
 * в «Компенсацию → Проживание» условий оплаты — то же поле, что в окне сотрудника; без оклада — нельзя.
 */
export const HousingAllowanceForm: FC<IHousingAllowanceFormProps> = ({ row, defaultAmount, onClose, onSaved }) => {
  const errorId = useId();
  const isEdit = row !== undefined;
  const [employee, setEmployee] = useState<IPayrollRegistryCandidate | null>(null);
  const [amount, setAmount] = useState(rateAmountInputValue(row ? row.amount : defaultAmount));
  const [effectiveFrom, setEffectiveFrom] = useState(moscowTodayIso());
  const [error, setError] = useState<{ field: RegistryFormField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Выбран сотрудник без оклада — сразу подсказка, а не ответ сервера после «Сохранить».
  const noTerms = !isEdit && employee !== null && !employee.has_terms;
  const shownError = noTerms ? { field: 'employee' as const, message: 'Сначала внесите оклад в окне сотрудника' } : error;
  const clearError = () => setError(null);
  const dateClass = (field: RegistryFormField): string =>
    (shownError?.field === field ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput);

  const handleSubmit = async (requestClose: () => void) => {
    const parsed = parseHousingForm({
      selected: isEdit || employee !== null,
      hasTerms: isEdit || (employee?.has_terms ?? false),
      amount,
      effectiveFrom,
    });
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await payrollRegistryService.setHousing(isEdit ? row.employee_id : employee!.id, parsed.payload);
      onSaved();
      requestClose();
    } catch (err) {
      setError({ field: null, message: err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить' });
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={isEdit ? 'Доплата за проживание' : 'Добавить сотрудника'}
      onClose={onClose}
      onSubmit={requestClose => { void handleSubmit(requestClose); }}
      saving={saving}
      error={shownError?.message ?? null}
      errorId={errorId}
      submitDisabled={noTerms}
      raised
    >
      <div className={styles.field}>
        <span className={styles.label}>Сотрудник</span>
        {isEdit ? (
          <div className={styles.fixed}>
            <span>
              {row.full_name}
              {row.department && <span className={styles.muted}> — {row.department}</span>}
            </span>
          </div>
        ) : (
          <EmployeeSearchField
            value={employee}
            onChange={value => { setEmployee(value); clearError(); }}
            search={payrollRegistryService.searchEmployees}
            isDisabled={isNotEditable}
            disabled={saving}
            invalid={shownError?.field === 'employee'}
          />
        )}
      </div>

      <div className={styles.dates}>
        <label className={styles.field}>
          <span className={styles.label}>Сумма, ₽/мес</span>
          <ClearableInput
            value={amount}
            onValueChange={value => { setAmount(value); clearError(); }}
            inputMode="decimal"
            autoComplete="off"
            disabled={saving}
            aria-invalid={shownError?.field === 'amount' || undefined}
            aria-describedby={shownError ? errorId : undefined}
            clearLabel="Очистить сумму"
          />
        </label>
        {/* Не <label>: внутри поля даты — кнопка календаря, клик по подписи открыл бы её. */}
        <div className={styles.field}>
          <span className={styles.label}>Действует с</span>
          <DateInput
            value={effectiveFrom}
            onChange={value => { setEffectiveFrom(value); clearError(); }}
            className={dateClass('date_from')}
            disabled={saving}
          />
        </div>
      </div>
    </RegistryFormModal>
  );
};
