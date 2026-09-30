import { type FC, type ChangeEvent } from 'react';
import { useToast } from '../../contexts/ToastContext';
import { ApiError } from '../../api/client';
import { useMyTimesheetObject } from '../../hooks/useMyTimesheetObject';
import styles from './MyTimesheetObjectField.module.css';

interface IMyTimesheetObjectFieldProps {
  employeeId: number;
  label: string;
  /** row — подпись слева, значение справа (карточка дня ЛК); stack — в столбик (ЛК рабочего). */
  layout: 'row' | 'stack';
  savedMessage: string;
  errorMessage: string;
}

/**
 * Объект табелирования в ЛК (миграция 288). В последние 3 дня месяца — выпадающий список,
 * если есть из чего выбрать: два объекта с наибольшими часами с 1-го числа, когда второй
 * отстаёт меньше чем на 15 %. Иначе — текст; «Офис» из окна «Режим табелирования» (291) —
 * всегда текст.
 */
export const MyTimesheetObjectField: FC<IMyTimesheetObjectFieldProps> = ({
  employeeId,
  label,
  layout,
  savedMessage,
  errorMessage,
}) => {
  const { showToast } = useToast();
  const { query, mutation } = useMyTimesheetObject(employeeId);
  const state = query.data;
  if (!state) return null;

  const editable = state.can_change && state.options.length > 0;

  const handleChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const value = event.target.value;
    if (!value || value === state.value) return;
    mutation.mutate(value, {
      onSuccess: () => showToast('success', savedMessage),
      onError: (error: unknown) => showToast('error', error instanceof ApiError ? error.message : errorMessage),
    });
  };

  return (
    <div className={layout === 'row' ? styles.row : styles.stack}>
      <span className={styles.label}>{label}</span>
      {editable ? (
        <select
          className={styles.select}
          value={state.value ?? ''}
          onChange={handleChange}
          disabled={mutation.isPending}
          aria-label={label}
        >
          {/* «—» виден в поле, но не в списке — там только объекты, как у выбора компании. */}
          {state.value === null && <option value="" disabled hidden>—</option>}
          {state.options.map(option => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      ) : (
        <span className={styles.value}>{state.label ?? '—'}</span>
      )}
    </div>
  );
};
