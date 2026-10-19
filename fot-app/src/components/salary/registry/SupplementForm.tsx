import { useId, useMemo, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import {
  payrollRegistryService,
  type IPayrollRegistryCandidate,
  type IPayrollSupplementRow,
  type PayrollSupplementKind,
} from '../../../services/payrollRegistryService';
import { formatMonthLabel } from '../../../utils/formatMoney';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { rateAmountInputValue } from '../../../utils/payrollDictionary';
import { SUPPLEMENT_KIND_LABELS } from '../../../utils/payrollRegistries';
import {
  oneTimeMonthOptions,
  parseOneTimeForm,
  parsePlannedForm,
  SUPPLEMENT_REASON_MAX_LENGTH,
  type RegistryFormField,
} from '../../../utils/payrollRegistryForms';
import { ClearableInput } from '../../ui/ClearableInput';
import { DateInput } from '../../ui/DateInput';
import { EmployeeSearchField } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';

interface ISupplementFormProps {
  /** Передано — ✎ этой доплаты (сотрудник и вид не меняются); нет — «Добавить сотрудника». */
  row?: IPayrollSupplementRow;
  onClose: () => void;
  onSaved: () => void;
}

const KINDS: PayrollSupplementKind[] = ['planned', 'one_time'];
const PLANNED_EXISTS = 'У сотрудника уже есть плановая доплата — измените её в таблице';

const isNotEditable = (candidate: IPayrollRegistryCandidate): boolean => !candidate.can_edit;

/**
 * «Добавить сотрудника» / ✎ в «Доплате»: плановая — сумма ₽/мес и период «с — по» (та же, что «Плановые
 * доплаты» окна сотрудника, одна на сотрудника); разовая — месяц, сумма и основание (за месяц — сколько угодно).
 */
export const SupplementForm: FC<ISupplementFormProps> = ({ row, onClose, onSaved }) => {
  const errorId = useId();
  const isEdit = row !== undefined;
  const [kind, setKind] = useState<PayrollSupplementKind>(row?.kind ?? 'planned');
  const [employee, setEmployee] = useState<IPayrollRegistryCandidate | null>(null);
  const [amount, setAmount] = useState(rateAmountInputValue(row?.amount));
  const [dateFrom, setDateFrom] = useState(row?.date_from ?? '');
  const [dateTo, setDateTo] = useState(row?.date_to ?? '');
  const currentMonth = moscowTodayIso().slice(0, 7);
  const [month, setMonth] = useState(row?.month ?? currentMonth);
  const [reason, setReason] = useState(row?.reason ?? '');
  const [error, setError] = useState<{ field: RegistryFormField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Месяц правки мог уйти за пределы списка — оставляем его выбранным.
  const editMonth = row?.month ?? null;
  const monthOptions = useMemo(() => {
    const options = oneTimeMonthOptions(currentMonth);
    return editMonth && !options.includes(editMonth) ? [...options, editMonth] : options;
  }, [currentMonth, editMonth]);

  // Плановая уже есть — добавлять нечего: подсказка сразу, а не ответ сервера после «Сохранить».
  const plannedExists = !isEdit && kind === 'planned' && employee !== null && employee.has_planned_supplement;
  const shownError = plannedExists ? { field: 'employee' as const, message: PLANNED_EXISTS } : error;
  const clearError = () => setError(null);
  const dateClass = (field: RegistryFormField): string =>
    (shownError?.field === field ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput);

  const save = async (): Promise<boolean> => {
    const selected = isEdit || employee !== null;
    const employeeId = isEdit ? row.employee_id : employee?.id ?? 0;
    if (kind === 'planned') {
      const parsed = parsePlannedForm({ selected, amount, dateFrom, dateTo });
      if (!parsed.ok) {
        setError({ field: parsed.field, message: parsed.message });
        return false;
      }
      setSaving(true);
      if (isEdit) await payrollRegistryService.setPlanned(employeeId, parsed.payload);
      else await payrollRegistryService.addPlanned(employeeId, parsed.payload);
      return true;
    }
    const parsed = parseOneTimeForm({ selected, month, amount, reason });
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return false;
    }
    setSaving(true);
    if (isEdit && row.id !== null) await payrollRegistryService.updateOneTime(row.id, parsed.payload);
    else await payrollRegistryService.addOneTime(employeeId, parsed.payload);
    return true;
  };

  const handleSubmit = async (requestClose: () => void) => {
    setError(null);
    try {
      if (!(await save())) return;
      onSaved();
      requestClose();
    } catch (err) {
      setError({ field: null, message: err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить' });
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={isEdit ? `${SUPPLEMENT_KIND_LABELS[row.kind]} доплата` : 'Добавить сотрудника'}
      onClose={onClose}
      onSubmit={requestClose => { void handleSubmit(requestClose); }}
      saving={saving}
      error={shownError?.message ?? null}
      errorId={errorId}
      submitDisabled={plannedExists}
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

      {!isEdit && (
        <div className={styles.field}>
          <span className={styles.label}>Вид</span>
          <div className={styles.segmented} role="group" aria-label="Вид доплаты">
            {KINDS.map(value => (
              <button
                key={value}
                type="button"
                className={styles.segment}
                aria-pressed={kind === value}
                onClick={() => { setKind(value); clearError(); }}
                disabled={saving}
              >
                {SUPPLEMENT_KIND_LABELS[value]}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className={styles.dates}>
        <label className={styles.field}>
          <span className={styles.label}>{kind === 'planned' ? 'Сумма, ₽/мес' : 'Сумма, ₽'}</span>
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
        {kind === 'one_time' && (
          <label className={styles.field}>
            <span className={styles.label}>Месяц</span>
            <select
              className={styles.select}
              value={month}
              onChange={event => { setMonth(event.target.value); clearError(); }}
              disabled={saving}
              aria-invalid={shownError?.field === 'month' || undefined}
            >
              {monthOptions.map(option => (
                <option key={option} value={option}>{formatMonthLabel(option)}</option>
              ))}
            </select>
          </label>
        )}
      </div>

      {kind === 'planned' ? (
        // Не <label>: внутри поля даты — кнопка календаря, клик по подписи открыл бы её.
        <div className={styles.dates}>
          <div className={styles.field}>
            <span className={styles.label}>Дата начала</span>
            <DateInput
              value={dateFrom}
              onChange={value => { setDateFrom(value); clearError(); }}
              className={dateClass('date_from')}
              disabled={saving}
            />
          </div>
          <div className={styles.field}>
            <span className={styles.label}>Дата окончания</span>
            <DateInput
              value={dateTo}
              onChange={value => { setDateTo(value); clearError(); }}
              className={dateClass('date_to')}
              disabled={saving}
            />
          </div>
        </div>
      ) : (
        <label className={styles.field}>
          <span className={styles.label}>Основание</span>
          <ClearableInput
            value={reason}
            onValueChange={value => { setReason(value); clearError(); }}
            maxLength={SUPPLEMENT_REASON_MAX_LENGTH}
            autoComplete="off"
            disabled={saving}
            aria-invalid={shownError?.field === 'reason' || undefined}
            aria-describedby={shownError ? errorId : undefined}
            clearLabel="Очистить основание"
          />
        </label>
      )}
    </RegistryFormModal>
  );
};
