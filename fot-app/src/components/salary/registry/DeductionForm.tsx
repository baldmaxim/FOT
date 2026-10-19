import { useId, useState, type FC } from 'react';
import { ChevronDown } from 'lucide-react';

import { ApiError } from '../../../api/client';
import { usePayrollDeductionKinds } from '../../../hooks/usePayrollDeductionKinds';
import {
  payrollRegistryService,
  type IDeductionRegistryRow,
  type IPayrollRegistryCandidate,
} from '../../../services/payrollRegistryService';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { formatDeductionKinds } from '../../../utils/payrollDeductions';
import { rateAmountInputValue } from '../../../utils/payrollDictionary';
import { parseDeductionForm, type RegistryFormField } from '../../../utils/payrollRegistryForms';
import { ClearableInput } from '../../ui/ClearableInput';
import { DateInput } from '../../ui/DateInput';
import { EmployeeSearchField } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import { DeductionKindsMenu } from '../DeductionKindsMenu';
import styles from '../../ui/registry/RegistryFormModal.module.css';
import own from './DeductionForm.module.css';

interface IDeductionFormProps {
  /** Передано — ✎ этой строки (сотрудник не меняется); нет — «Добавить сотрудника». */
  row?: IDeductionRegistryRow;
  onClose: () => void;
  onSaved: () => void;
}

const NO_TERMS = 'Сначала внесите оклад в окне сотрудника';

const isNotEditable = (candidate: IPayrollRegistryCandidate): boolean => !candidate.can_edit;

/**
 * «Добавить сотрудника» / ✎ в «Удержаниях»: виды (галочки), «Сумма, ₽/мес» и «Действует с» — те же поля, что
 * «Удержание» окна сотрудника. Сумма меняется с даты «Действует с»; виды датой не хранятся — набор заменяется.
 * Сумму без оклада не внести.
 */
export const DeductionForm: FC<IDeductionFormProps> = ({ row, onClose, onSaved }) => {
  const errorId = useId();
  const kindsButtonId = useId();
  const isEdit = row !== undefined;
  const kinds = usePayrollDeductionKinds();
  const [employee, setEmployee] = useState<IPayrollRegistryCandidate | null>(null);
  const [kindIds, setKindIds] = useState<number[]>(row?.kind_ids ?? []);
  const [kindsAnchor, setKindsAnchor] = useState<HTMLElement | null>(null);
  const [amount, setAmount] = useState(rateAmountInputValue(row?.amount ?? null));
  const [effectiveFrom, setEffectiveFrom] = useState(moscowTodayIso());
  const [error, setError] = useState<{ field: RegistryFormField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Сумма у сотрудника без оклада — подсказка сразу (на сегодня; окончательно решит сервер).
  const noTerms = !isEdit && employee !== null && !employee.has_terms && amount.trim() !== '';
  const shownError = noTerms ? { field: 'amount' as const, message: NO_TERMS } : error;
  const clearError = () => setError(null);
  const dateClass = (field: RegistryFormField): string =>
    (shownError?.field === field ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput);

  const kindsLabel = formatDeductionKinds(kindIds, kinds.data ?? []);
  const closeKinds = () => {
    kindsAnchor?.focus();
    setKindsAnchor(null);
  };

  const handleSubmit = async (requestClose: () => void) => {
    const parsed = parseDeductionForm({
      selected: isEdit || employee !== null,
      isEdit,
      hasTerms: isEdit || (employee?.has_terms ?? false),
      kindIds,
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
      await payrollRegistryService.saveDeduction(isEdit ? row.employee_id : employee!.id, parsed.payload);
      onSaved();
      requestClose();
    } catch (err) {
      setError({ field: null, message: err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить' });
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={isEdit ? 'Удержание' : 'Добавить сотрудника'}
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

      <div className={styles.field}>
        <label htmlFor={kindsButtonId} className={styles.label}>Вид удержания</label>
        <button
          id={kindsButtonId}
          type="button"
          className={own.kindsTrigger}
          aria-haspopup="dialog"
          aria-expanded={kindsAnchor !== null}
          aria-invalid={shownError?.field === 'kinds' || undefined}
          disabled={saving || kinds.isLoading}
          onClick={event => setKindsAnchor(kindsAnchor ? null : event.currentTarget)}
        >
          <span className={kindIds.length > 0 ? own.kindsValue : own.kindsPlaceholder}>
            {kinds.isError ? 'ошибка загрузки' : kindIds.length > 0 ? kindsLabel : 'Не выбран'}
          </span>
          <ChevronDown size={16} aria-hidden="true" />
        </button>
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

      {kindsAnchor && (
        <DeductionKindsMenu
          anchor={kindsAnchor}
          subtitle={isEdit ? row.full_name : employee?.full_name ?? undefined}
          kinds={kinds.data ?? []}
          selected={kindIds}
          onToggle={(kindId, checked) => {
            setKindIds(prev => (checked ? [...prev.filter(id => id !== kindId), kindId] : prev.filter(id => id !== kindId)));
            clearError();
          }}
          onClose={closeKinds}
          // Escape меню перехватывает само: форма под ним не закрывается.
          aboveForm
        />
      )}
    </RegistryFormModal>
  );
};
