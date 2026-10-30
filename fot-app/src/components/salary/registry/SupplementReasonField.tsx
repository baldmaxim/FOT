import { useId, useMemo, type FC } from 'react';
import { Pencil } from 'lucide-react';

import { useSupplementReasons } from '../../../hooks/useSupplementReasons';
import { sortSupplementReasons, supplementReasonOptions } from '../../../utils/payrollRegistryForms';
import formStyles from '../../ui/registry/RegistryFormModal.module.css';
import styles from './SupplementReasonField.module.css';

interface ISupplementReasonFieldProps {
  value: string;
  onChange: (value: string) => void;
  /** ✎ — окно «Основания доплаты»; его состояние у формы (окно — соседом формы, не внутри). */
  onOpenList: () => void;
  disabled: boolean;
  invalid: boolean;
  /** id абзаца ошибки формы. */
  describedBy?: string;
}

/**
 * «Основание» разовой доплаты: выбор из списка «Основания доплаты» (миграция 340) и ✎ — править список. Основание
 * доплаты не из списка (старое, из импорта 1С, удалённое) — отдельной первой строкой.
 */
export const SupplementReasonField: FC<ISupplementReasonFieldProps> = ({
  value, onChange, onOpenList, disabled, invalid, describedBy,
}) => {
  const selectId = useId();
  const reasons = useSupplementReasons();
  const names = useMemo(() => sortSupplementReasons(reasons.data ?? []).map(reason => reason.name), [reasons.data]);

  return (
    <div className={formStyles.field}>
      <label htmlFor={selectId} className={formStyles.label}>Основание</label>
      <div className={styles.row}>
        <select
          id={selectId}
          className={formStyles.select}
          value={value}
          onChange={event => onChange(event.target.value)}
          disabled={disabled || reasons.isLoading}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
        >
          <option value="">{reasons.isLoading ? 'Загрузка…' : 'Выберите основание'}</option>
          {supplementReasonOptions(names, value).map(name => (
            <option key={name} value={name}>{name}</option>
          ))}
        </select>
        <button
          type="button"
          className={styles.editButton}
          onClick={onOpenList}
          disabled={disabled}
          aria-label="Изменить список оснований"
          title="Изменить список оснований"
        >
          <Pencil size={16} aria-hidden="true" />
        </button>
      </div>
      {reasons.isError && (
        <p className={styles.loadError} role="alert">
          Список оснований не загрузился
          <button type="button" className={styles.retryButton} onClick={() => { void reasons.refetch(); }}>
            Повторить
          </button>
        </p>
      )}
    </div>
  );
};
