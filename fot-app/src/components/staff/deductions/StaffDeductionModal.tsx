import { useId, useMemo, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import type { IDormitoryCandidate } from '../../../services/dormitoryService';
import {
  staffDeductionService,
  type IStaffDeduction,
  type IStaffDeductionKind,
} from '../../../services/staffDeductionService';
import { formatMonthLabel } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { rateAmountInputValue } from '../../../utils/payrollDictionary';
import { oneTimeMonthOptions } from '../../../utils/payrollRegistryForms';
import {
  amountAfterKindChange,
  parseStaffDeduction,
  type StaffDeductionField,
} from '../../../utils/staffDeductionForm';
import { ClearableInput } from '../../ui/ClearableInput';
import { EmployeeSearchField } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';

interface IStaffDeductionModalProps {
  /** Передано — правка этого удержания (сотрудник не меняется); нет — добавление. */
  deduction?: IStaffDeduction;
  /** Виды удержаний — список «Вид удержания» и суммы по умолчанию. */
  kinds: readonly IStaffDeductionKind[];
  onClose: () => void;
  onSaved: (deduction: IStaffDeduction) => void;
}

/**
 * «Добавить сотрудника» и ✎ во вкладке «Удержания»: сотрудник (поиск по ФИО), вид удержания, месяц
 * удержания и сумма — выбор вида подставляет его сумму по умолчанию. Ошибка сервера — под полями,
 * ввод не теряется.
 */
export const StaffDeductionModal: FC<IStaffDeductionModalProps> = ({ deduction, kinds, onClose, onSaved }) => {
  const errorId = useId();
  const isEdit = deduction !== undefined;
  const [employee, setEmployee] = useState<IDormitoryCandidate | null>(null);
  const [kindId, setKindId] = useState<number | null>(deduction?.kind_id ?? null);
  const currentMonth = moscowTodayIso().slice(0, 7);
  const [month, setMonth] = useState(deduction?.month ?? currentMonth);
  const [amount, setAmount] = useState(rateAmountInputValue(deduction?.amount));
  const [error, setError] = useState<{ field: StaffDeductionField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Месяц правки мог уйти за пределы списка — оставляем его выбранным.
  const editMonth = deduction?.month ?? null;
  const monthOptions = useMemo(() => {
    const options = oneTimeMonthOptions(currentMonth);
    return editMonth && !options.includes(editMonth) ? [...options, editMonth] : options;
  }, [currentMonth, editMonth]);

  // Вид правки могли удалить из справочника — оставляем его в списке, сервер ответит понятной ошибкой.
  const kindOptions = useMemo(() => (
    deduction && !kinds.some(kind => kind.id === deduction.kind_id)
      ? [...kinds, { id: deduction.kind_id, name: deduction.kind_name, default_amount: null }]
      : kinds
  ), [kinds, deduction]);

  const clearError = () => setError(null);
  const invalid = (field: StaffDeductionField): true | undefined => (error?.field === field ? true : undefined);

  const handleKindChange = (value: string) => {
    const nextId = value ? Number(value) : null;
    const defaultOf = (id: number | null) => kindOptions.find(kind => kind.id === id)?.default_amount;
    setAmount(current => amountAfterKindChange(current, defaultOf(kindId), defaultOf(nextId)));
    setKindId(nextId);
    clearError();
  };

  const handleSubmit = async (requestClose: () => void) => {
    const parsed = parseStaffDeduction({ selected: isEdit || employee !== null, kindId, month, amount });
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const saved = isEdit
        ? await staffDeductionService.update(deduction.id, parsed.payload)
        : await staffDeductionService.add(employee!.id, parsed.payload);
      onSaved(saved);
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
      error={error?.message ?? null}
      errorId={errorId}
    >
      <div className={styles.field}>
        <span className={styles.label}>Сотрудник</span>
        {isEdit ? (
          <div className={styles.fixed}>
            {/* Одним элементом: во flex-контейнере пробел перед «—» у отдельного span пропал бы. */}
            <span>
              {deduction.full_name}
              {deduction.department && <span className={styles.muted}> — {deduction.department}</span>}
            </span>
          </div>
        ) : (
          <EmployeeSearchField
            value={employee}
            onChange={value => { setEmployee(value); clearError(); }}
            search={staffDeductionService.searchEmployees}
            disabled={saving}
            invalid={error?.field === 'employee'}
          />
        )}
      </div>

      <label className={styles.field}>
        <span className={styles.label}>Вид удержания</span>
        <select
          className={styles.select}
          value={kindId ?? ''}
          onChange={event => handleKindChange(event.target.value)}
          disabled={saving}
          aria-invalid={invalid('kind')}
          aria-describedby={error ? errorId : undefined}
        >
          <option value="" disabled>Выберите вид</option>
          {kindOptions.map(kind => (
            <option key={kind.id} value={kind.id}>{kind.name}</option>
          ))}
        </select>
      </label>

      <div className={styles.dates}>
        <label className={styles.field}>
          <span className={styles.label}>Месяц</span>
          <select
            className={styles.select}
            value={month}
            onChange={event => { setMonth(event.target.value); clearError(); }}
            disabled={saving}
            aria-invalid={invalid('month')}
          >
            {monthOptions.map(option => (
              <option key={option} value={option}>{formatMonthLabel(option)}</option>
            ))}
          </select>
        </label>
        <label className={styles.field}>
          <span className={styles.label}>Сумма, ₽</span>
          <ClearableInput
            value={amount}
            onValueChange={value => { setAmount(value); clearError(); }}
            inputMode="decimal"
            autoComplete="off"
            disabled={saving}
            aria-invalid={invalid('amount')}
            aria-describedby={error ? errorId : undefined}
            clearLabel="Очистить сумму"
          />
        </label>
      </div>
    </RegistryFormModal>
  );
};
