import type { FC } from 'react';

import type { IDeductionViolationObject } from '../../../services/staffDeductionService';
import { VIOLATION_PLACE_MAX, type StaffDeductionField } from '../../../utils/staffDeductionForm';
import { ClearableInput } from '../../ui/ClearableInput';
import { DateInput } from '../../ui/DateInput';
import styles from '../../ui/registry/RegistryFormModal.module.css';

interface IDeductionViolationFieldsProps {
  /** Объекты списка «Место» (у правки — и объект строки, если его уже убрали в архив); undefined — грузятся. */
  objects: readonly IDeductionViolationObject[] | undefined;
  /** Список не загрузился. */
  objectsError: boolean;
  objectId: string | null;
  place: string;
  /** YYYY-MM-DD или ''. */
  date: string;
  onObjectChange: (objectId: string | null) => void;
  onPlaceChange: (place: string) => void;
  onDateChange: (date: string) => void;
  disabled: boolean;
  /** Поле с ошибкой — красная рамка. */
  invalidField: StaffDeductionField | null;
  /** id текста ошибки окна. */
  describedBy?: string;
}

/**
 * «Место», «Дата» и «Уточнение» нарушения в окне удержания (миграция 383) — у вида с признаком «место и дата»
 * («Нарушение техники безопасности»): объект из списка объектов, дата и необязательный текст «где именно».
 */
export const DeductionViolationFields: FC<IDeductionViolationFieldsProps> = ({
  objects, objectsError, objectId, place, date, onObjectChange, onPlaceChange, onDateChange, disabled, invalidField,
  describedBy,
}) => {
  const invalid = (field: StaffDeductionField): true | undefined => (invalidField === field ? true : undefined);
  const dateClass = invalidField === 'date' ? `${styles.dateInput} ${styles.dateInvalid}` : styles.dateInput;
  const placeholder = objectsError ? 'Не удалось загрузить объекты' : objects ? 'Выберите объект' : 'Загрузка…';

  return (
    <>
      <div className={styles.dates}>
        <label className={styles.field}>
          <span className={styles.label}>Место</span>
          <select
            className={styles.select}
            value={objectId ?? ''}
            onChange={event => onObjectChange(event.target.value || null)}
            disabled={disabled || !objects}
            aria-invalid={invalid('object')}
            aria-describedby={describedBy}
          >
            <option value="" disabled>{placeholder}</option>
            {objects?.map(object => (
              <option key={object.id} value={object.id}>{object.name}</option>
            ))}
          </select>
        </label>
        {/* Не <label>: внутри поля даты — кнопка календаря. */}
        <div className={styles.field}>
          <span className={styles.label}>Дата</span>
          <DateInput value={date} onChange={onDateChange} className={dateClass} disabled={disabled} />
        </div>
      </div>

      <label className={styles.field}>
        <span className={styles.label}>Уточнение</span>
        <ClearableInput
          value={place}
          onValueChange={onPlaceChange}
          placeholder="Корпус, этаж"
          maxLength={VIOLATION_PLACE_MAX}
          autoComplete="off"
          disabled={disabled}
          aria-invalid={invalid('place')}
          aria-describedby={describedBy}
          clearLabel="Очистить уточнение места"
        />
      </label>
    </>
  );
};
