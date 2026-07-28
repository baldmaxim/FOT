import { type FC, type ReactNode } from 'react';
import { DateInput } from '../ui/DateInput';
import { OtTrainingBadge } from './OtTrainingBadge';
import type { IOtTrainingDef, IOtTrainingState } from '../../services/otTraining.types';
import contractorStyles from '../../pages/contractor/Contractor.module.css';
import styles from './Ot.module.css';

interface IProps {
  def: IOtTrainingDef;
  /** Введённое значение YYYY-MM-DD или '' — пусто. */
  value: string;
  /** Состояние с сервера: срок действия и просрочка. */
  state: IOtTrainingState | undefined;
  /** Значение в форме изменено, но ещё не сохранено. */
  dirty?: boolean;
  disabled?: boolean;
  onChange: (next: string) => void;
  onClear: () => void;
  /** Дополнительный блок под строкой (поле профессии у сквозных профессий). */
  children?: ReactNode;
}

/** Строка вида обучения: название + периодичность | дата | срок действия | снять дату. */
export const OtTrainingRow: FC<IProps> = ({
  def, value, state, dirty = false, disabled = false, onChange, onClear, children,
}) => (
  <div className={styles.row}>
    <div className={styles.label}>
      <span className={styles.name}>{def.label}</span>
      <span className={styles.hint}>{def.hint}</span>
    </div>
    <DateInput value={value} onChange={onChange} disabled={disabled} />
    <div className={styles.state}>
      <OtTrainingBadge state={state} validMonths={def.validMonths} dirty={dirty} />
      {value !== '' && (
        <button
          type="button"
          className={`${contractorStyles.btn} ${contractorStyles.btnIcon}`}
          onClick={onClear}
          disabled={disabled}
          title="Снять дату"
          aria-label={`Снять дату: ${def.label}`}
        >
          ✗
        </button>
      )}
    </div>
    {children}
  </div>
);
