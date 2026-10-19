import { useId, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import {
  payrollRegistryService,
  type ICompensationStop,
  type IPayrollRegistryCandidate,
} from '../../../services/payrollRegistryService';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { parseStopForm, type RegistryFormField } from '../../../utils/payrollRegistryForms';
import { DateInput } from '../../ui/DateInput';
import { EmployeeSearchField } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';

interface ICompensationStopFormProps {
  /** Передано — ✎ этого периода (сотрудник не меняется); нет — «Добавить сотрудника». */
  stop?: ICompensationStop;
  onClose: () => void;
  onSaved: () => void;
}

const isNotEditable = (candidate: IPayrollRegistryCandidate): boolean => !candidate.can_edit;

/**
 * «Добавить сотрудника» / ✎ в «Не выплачивать»: сотрудник и период «с — по». «По» пусто — бессрочно;
 * возобновили выплату — ставят «по» (строка остаётся историей).
 */
export const CompensationStopForm: FC<ICompensationStopFormProps> = ({ stop, onClose, onSaved }) => {
  const errorId = useId();
  const isEdit = stop !== undefined;
  const [employee, setEmployee] = useState<IPayrollRegistryCandidate | null>(null);
  const [dateFrom, setDateFrom] = useState(stop?.date_from ?? moscowTodayIso());
  const [dateTo, setDateTo] = useState(stop?.date_to ?? '');
  const [error, setError] = useState<{ field: RegistryFormField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);

  const clearError = () => setError(null);
  const dateClass = (field: RegistryFormField): string =>
    (error?.field === field ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput);

  const handleSubmit = async (requestClose: () => void) => {
    const parsed = parseStopForm({ selected: isEdit || employee !== null, dateFrom, dateTo });
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit) await payrollRegistryService.updateStop(stop.id, parsed.payload);
      else await payrollRegistryService.addStop(employee!.id, parsed.payload);
      onSaved();
      requestClose();
    } catch (err) {
      setError({ field: null, message: err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить' });
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={isEdit ? 'Не выплачивать' : 'Добавить сотрудника'}
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
              {stop.full_name}
              {stop.department && <span className={styles.muted}> — {stop.department}</span>}
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
          <span className={styles.label}>Не выплачивать с</span>
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
