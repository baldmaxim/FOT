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
  reasonAfterDelete,
  reasonAfterRename,
  type RegistryFormField,
} from '../../../utils/payrollRegistryForms';
import { ClearableInput } from '../../ui/ClearableInput';
import { DateInput } from '../../ui/DateInput';
import { EmployeeSearchField } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';
import { SupplementReasonField } from './SupplementReasonField';
import { SupplementReasonsModal } from './SupplementReasonsModal';

interface ISupplementFormProps {
  /** Передано — ✎ этой доплаты (сотрудник и вид не меняются); нет — «Добавить сотрудника». */
  row?: IPayrollSupplementRow;
  /**
   * Вид новой доплаты: «Плановые доплаты» — плановая, общая таблица «Доплата» — разовая. При правке —
   * вид строки.
   */
  kind: PayrollSupplementKind;
  onClose: () => void;
  onSaved: () => void;
}

const isNotEditable = (candidate: IPayrollRegistryCandidate): boolean => !candidate.can_edit;

/**
 * «Добавить сотрудника» / ✎ доплаты: плановая — сумма ₽/мес и период «с — по» (та же, что «Плановые доплаты» окна
 * сотрудника; новый период после закончившегося — можно, пересечение с текущей отклоняет сервер); разовая —
 * месяц, сумма и основание из списка (за месяц — сколько угодно); ✎ у основания — окно «Основания доплаты».
 */
export const SupplementForm: FC<ISupplementFormProps> = ({ row, kind: newKind, onClose, onSaved }) => {
  const errorId = useId();
  const isEdit = row !== undefined;
  const kind = row?.kind ?? newKind;
  const [employee, setEmployee] = useState<IPayrollRegistryCandidate | null>(null);
  const [amount, setAmount] = useState(rateAmountInputValue(row?.amount));
  const [dateFrom, setDateFrom] = useState(row?.date_from ?? '');
  const [dateTo, setDateTo] = useState(row?.date_to ?? '');
  const currentMonth = moscowTodayIso().slice(0, 7);
  const [month, setMonth] = useState(row?.month ?? currentMonth);
  const [reason, setReason] = useState(row?.reason ?? '');
  // Основание самой доплаты при ✎: удаление из списка его не сбрасывает; переименование меняет и его (как сервер).
  const [ownReason, setOwnReason] = useState<string | null>(row?.reason ?? null);
  const [reasonsOpen, setReasonsOpen] = useState(false);
  const [error, setError] = useState<{ field: RegistryFormField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  // Месяц правки мог уйти за пределы списка — оставляем его выбранным.
  const editMonth = row?.month ?? null;
  const monthOptions = useMemo(() => {
    const options = oneTimeMonthOptions(currentMonth);
    return editMonth && !options.includes(editMonth) ? [...options, editMonth] : options;
  }, [currentMonth, editMonth]);

  const clearError = () => setError(null);
  const dateClass = (field: RegistryFormField): string =>
    (error?.field === field ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput);

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
      // Правка — этот период по id строки журнала (любой, не только последний); без id — старый бэкенд.
      if (isEdit && row.id !== null) await payrollRegistryService.updatePlannedPeriod(row.id, parsed.payload);
      else if (isEdit) await payrollRegistryService.setPlanned(employeeId, parsed.payload);
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
    <>
      <RegistryFormModal
        title={isEdit ? `${SUPPLEMENT_KIND_LABELS[row.kind]} доплата` : 'Добавить сотрудника'}
        onClose={onClose}
        onSubmit={requestClose => { void handleSubmit(requestClose); }}
        saving={saving}
        error={error?.message ?? null}
        errorId={errorId}
        raised
        closeOnEscape={!reasonsOpen}
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
              invalid={error?.field === 'employee'}
            />
          )}
        </div>

        <div className={styles.dates}>
          <label className={styles.field}>
            <span className={styles.label}>{kind === 'planned' ? 'Сумма, ₽/мес' : 'Сумма, ₽'}</span>
            <ClearableInput
              value={amount}
              onValueChange={value => { setAmount(value); clearError(); }}
              inputMode="decimal"
              autoComplete="off"
              disabled={saving}
              aria-invalid={error?.field === 'amount' || undefined}
              aria-describedby={error ? errorId : undefined}
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
                aria-invalid={error?.field === 'month' || undefined}
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
          <SupplementReasonField
            value={reason}
            onChange={value => { setReason(value); clearError(); }}
            onOpenList={() => setReasonsOpen(true)}
            disabled={saving}
            invalid={error?.field === 'reason'}
            describedBy={error ? errorId : undefined}
          />
        )}
      </RegistryFormModal>

      {/* Соседом формы, не внутри: submit полей списка не должен всплыть в «Сохранить» доплаты. */}
      {reasonsOpen && (
        <SupplementReasonsModal
          onClose={() => setReasonsOpen(false)}
          onRenamed={(from, to) => {
            setReason(current => reasonAfterRename(current, from, to));
            setOwnReason(current => (current === null ? null : reasonAfterRename(current, from, to)));
          }}
          onDeleted={name => setReason(current => reasonAfterDelete(current, name, ownReason))}
        />
      )}
    </>
  );
};
