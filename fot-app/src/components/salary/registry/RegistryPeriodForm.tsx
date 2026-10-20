import { useId, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import {
  payrollRegistryService,
  type IPayrollRegistryCandidate,
  type IRegistryPeriodFields,
} from '../../../services/payrollRegistryService';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { parsePeriodForm, type RegistryFormField } from '../../../utils/payrollRegistryForms';
import { DateInput } from '../../ui/DateInput';
import { EmployeeSearchField } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';

/** Строка таблицы с периодом «с — по»: «Без проезда», «Доплата за общежитие». */
interface IRegistryPeriodRow {
  id: number;
  full_name: string;
  department: string | null;
  date_from: string;
  date_to: string | null;
}

interface IRegistryPeriodFormProps {
  /** Заголовок окна правки: «Без проезда», «Доплата за общежитие». */
  title: string;
  /** Подпись даты начала: «Без проезда с», «Доплата с». */
  fromLabel: string;
  /** Передано — ✎ этого периода (сотрудник не меняется); нет — «Добавить сотрудника». */
  row?: IRegistryPeriodRow;
  onAdd: (employeeId: number, fields: IRegistryPeriodFields) => Promise<void>;
  onUpdate: (id: number, fields: IRegistryPeriodFields) => Promise<void>;
  onClose: () => void;
  onSaved: () => void;
}

const isNotEditable = (candidate: IPayrollRegistryCandidate): boolean => !candidate.can_edit;

/**
 * «Добавить сотрудника» / ✎ в таблице с периодами: сотрудник и период «с — по». «По» пусто — бессрочно;
 * прекратили — ставят «по» (строка остаётся историей). Отказ сервера (пересечение и др.) — его текстом.
 */
export const RegistryPeriodForm: FC<IRegistryPeriodFormProps> = ({
  title,
  fromLabel,
  row,
  onAdd,
  onUpdate,
  onClose,
  onSaved,
}) => {
  const errorId = useId();
  const isEdit = row !== undefined;
  const [employee, setEmployee] = useState<IPayrollRegistryCandidate | null>(null);
  const [dateFrom, setDateFrom] = useState(row?.date_from ?? moscowTodayIso());
  const [dateTo, setDateTo] = useState(row?.date_to ?? '');
  const [error, setError] = useState<{ field: RegistryFormField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const clearError = () => setError(null);
  const dateClass = (field: RegistryFormField): string =>
    (error?.field === field ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput);

  const handleSubmit = async (requestClose: () => void) => {
    const parsed = parsePeriodForm({ selected: isEdit || employee !== null, dateFrom, dateTo, fromLabel });
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit) await onUpdate(row.id, parsed.payload);
      else await onAdd(employee!.id, parsed.payload);
      onSaved();
      requestClose();
    } catch (err) {
      setError({ field: null, message: err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить' });
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={isEdit ? title : 'Добавить сотрудника'}
      onClose={onClose}
      onSubmit={requestClose => { void handleSubmit(requestClose); }}
      saving={saving}
      error={error?.message ?? null}
      errorId={errorId}
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
            invalid={error?.field === 'employee'}
          />
        )}
      </div>

      {/* Не <label>: внутри поля даты — кнопка календаря, клик по подписи открыл бы её. */}
      <div className={styles.dates}>
        <div className={styles.field}>
          <span className={styles.label}>{fromLabel}</span>
          <DateInput
            value={dateFrom}
            onChange={value => { setDateFrom(value); clearError(); }}
            className={dateClass('date_from')}
            disabled={saving}
          />
        </div>
        <div className={styles.field}>
          <span className={styles.label}>По</span>
          <DateInput
            value={dateTo}
            onChange={value => { setDateTo(value); clearError(); }}
            className={dateClass('date_to')}
            disabled={saving}
          />
        </div>
      </div>
    </RegistryFormModal>
  );
};
