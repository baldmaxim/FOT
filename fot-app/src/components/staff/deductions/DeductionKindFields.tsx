import type { FC } from 'react';

import type { IStaffDeductionKind } from '../../../services/staffDeductionService';
import styles from '../../ui/registry/RegistryFormModal.module.css';

interface IDeductionKindFieldsProps {
  /** Виды с подвидами (у правки — с прежними видом и подвидом, даже если их удалили из справочника). */
  kinds: readonly IStaffDeductionKind[];
  kindId: number | null;
  subkindId: number | null;
  /** Смена вида сбрасывает подвид. */
  onChange: (kindId: number | null, subkindId: number | null) => void;
  disabled: boolean;
  /** Ошибка у вида — красная рамка. */
  kindInvalid: boolean;
  /** id текста ошибки окна. */
  describedBy?: string;
}

/**
 * «Вид удержания» и «Подвид» — в окне удержания и окне планового удержания (кадры и «Зарплата»). Подвид — список,
 * только если у вида есть подвиды; можно «Без подвида».
 */
export const DeductionKindFields: FC<IDeductionKindFieldsProps> = ({
  kinds, kindId, subkindId, onChange, disabled, kindInvalid, describedBy,
}) => {
  const subkinds = kinds.find(kind => kind.id === kindId)?.subkinds ?? [];
  return (
    <>
      <label className={styles.field}>
        <span className={styles.label}>Вид удержания</span>
        <select
          className={styles.select}
          value={kindId ?? ''}
          onChange={event => onChange(event.target.value ? Number(event.target.value) : null, null)}
          disabled={disabled}
          aria-invalid={kindInvalid || undefined}
          aria-describedby={describedBy}
        >
          <option value="" disabled>Выберите вид</option>
          {kinds.map(kind => (
            <option key={kind.id} value={kind.id}>{kind.name}</option>
          ))}
        </select>
      </label>

      {subkinds.length > 0 && (
        <label className={styles.field}>
          <span className={styles.label}>Подвид</span>
          <select
            className={styles.select}
            value={subkindId ?? ''}
            onChange={event => onChange(kindId, event.target.value ? Number(event.target.value) : null)}
            disabled={disabled}
          >
            <option value="">Без подвида</option>
            {subkinds.map(subkind => (
              <option key={subkind.id} value={subkind.id}>{subkind.name}</option>
            ))}
          </select>
        </label>
      )}
    </>
  );
};
