import { type FC } from 'react';
import type { IOtTrainingState } from '../../services/contractorService';
import { fmtDate } from './otShared';
import styles from './Ot.module.css';

interface IProps {
  /** Состояние вида; undefined — сервер вообще не вернул строку. */
  state: IOtTrainingState | undefined;
  /** null — вид бессрочный, дата окончания не считается. */
  validMonths: number | null;
  /** Дата в форме изменена, но ещё не сохранена — срок пересчитает сервер. */
  dirty?: boolean;
}

/**
 * Состояние одного вида обучения: дата окончания и просрочка.
 *
 * Отсутствие данных проверяется первым: сервер отдаёт полноценное состояние со
 * status 'missing' и passed_on null, и без этой проверки непройденный бессрочный вид
 * показал бы «бессрочно», а срочный — «до —».
 */
export const OtTrainingBadge: FC<IProps> = ({ state, validMonths, dirty = false }) => {
  if (dirty) return <span className={styles.muted}>сохранить, чтобы пересчитать</span>;
  if (!state || state.status === 'missing') {
    return <span className={`${styles.badge} ${styles.badgeAlert}`}>нет данных</span>;
  }
  if (validMonths === null) return <span className={styles.muted}>бессрочно</span>;

  if (state.status === 'expired') {
    return (
      <span className={`${styles.badge} ${styles.badgeAlert}`}>
        просрочено {fmtDate(state.valid_until)}
      </span>
    );
  }
  if (state.status === 'expiring') {
    return (
      <span className={`${styles.badge} ${styles.badgeWarning}`}>
        истекает {fmtDate(state.valid_until)}
      </span>
    );
  }
  return <span className={styles.muted}>до {fmtDate(state.valid_until)}</span>;
};
