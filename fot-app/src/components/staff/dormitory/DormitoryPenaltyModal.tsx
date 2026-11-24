import { useId, useState, type FC } from 'react';

import { ApiError } from '../../../api/client';
import {
  dormitoryService,
  type IDormitoryCandidate,
  type IDormitoryPenaltyRow,
} from '../../../services/dormitoryService';
import { parsePenaltyForm, PENALTY_NOTE_MAX_LENGTH, type PenaltyFormField } from '../../../utils/dormitoryPenalties';
import { moscowTodayIso } from '../../../utils/moscowDate';
import { ClearableInput } from '../../ui/ClearableInput';
import { DateInput } from '../../ui/DateInput';
import { EmployeeSearchField } from '../../ui/EmployeeSearchField';
import { RegistryFormModal } from '../../ui/registry/RegistryFormModal';
import styles from '../../ui/registry/RegistryFormModal.module.css';

interface IDormitoryPenaltyModalProps {
  /** Передано — правка записи списка (сотрудник не меняется); нет — добавление. */
  penalty?: IDormitoryPenaltyRow;
  onClose: () => void;
  onSaved: () => void;
}

/**
 * «Добавить» и ✎ «Истории взысканий» (миграция 378): сотрудник (поиск по ФИО, и уволенные; при правке — текстом),
 * дата взыскания и информация — хотя бы одно из двух. Ошибка сервера — под полями, ввод не теряется.
 */
export const DormitoryPenaltyModal: FC<IDormitoryPenaltyModalProps> = ({ penalty, onClose, onSaved }) => {
  const errorId = useId();
  const noteId = useId();
  const isEdit = penalty !== undefined;
  const [employee, setEmployee] = useState<IDormitoryCandidate | null>(null);
  const [penaltyDate, setPenaltyDate] = useState(penalty?.penalty_date ?? '');
  const [note, setNote] = useState(penalty?.note ?? '');
  const [error, setError] = useState<{ field: PenaltyFormField | null; message: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const clearError = () => setError(null);

  const handleSubmit = async (requestClose: () => void) => {
    const parsed = parsePenaltyForm({ employeeSelected: isEdit || employee !== null, penaltyDate, note }, moscowTodayIso());
    if (!parsed.ok) {
      setError({ field: parsed.field, message: parsed.message });
      return;
    }
    setSaving(true);
    setError(null);
    try {
      if (isEdit && penalty.id !== null) await dormitoryService.updatePenalty(penalty.id, parsed.payload);
      else await dormitoryService.addPenalty(employee!.id, parsed.payload);
      onSaved();
      requestClose();
    } catch (err) {
      setError({ field: null, message: err instanceof ApiError && err.message ? err.message : 'Не удалось сохранить' });
      setSaving(false);
    }
  };

  return (
    <RegistryFormModal
      title={isEdit ? 'Взыскание' : 'Добавить взыскание'}
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
            <span>
              {penalty.full_name}
              {penalty.department && <span className={styles.muted}> — {penalty.department}</span>}
            </span>
          </div>
        ) : (
          <EmployeeSearchField
            value={employee}
            onChange={value => { setEmployee(value); clearError(); }}
            search={dormitoryService.searchEmployeesWithDismissed}
            disabled={saving}
            invalid={error?.field === 'employee'}
          />
        )}
      </div>

      {/* Не <label>: внутри поля даты — кнопка календаря, клик по подписи открыл бы её. */}
      <div className={styles.field}>
        <span className={styles.label}>Дата</span>
        <DateInput
          value={penaltyDate}
          onChange={value => { setPenaltyDate(value); clearError(); }}
          className={error?.field === 'penalty_date' ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput}
          disabled={saving}
        />
      </div>

      <div className={styles.field}>
        <label htmlFor={noteId} className={styles.label}>Информация</label>
        <ClearableInput
          id={noteId}
          value={note}
          onValueChange={value => { setNote(value); clearError(); }}
          maxLength={PENALTY_NOTE_MAX_LENGTH}
          autoComplete="off"
          disabled={saving}
          aria-invalid={error?.field === 'note' || undefined}
          aria-describedby={error ? errorId : undefined}
          clearLabel="Очистить информацию"
        />
      </div>
    </RegistryFormModal>
  );
};
