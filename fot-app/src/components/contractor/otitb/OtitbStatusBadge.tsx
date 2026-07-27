import { type FC } from 'react';
import type { IInductedPerson, IOtTrainingState } from '../../../services/contractorService';
import { fmtDate } from './otitbShared';
import styles from './Otitb.module.css';

const ROW_CLASS: Record<IInductedPerson['row_status'], string> = {
  ok: styles.statusOk,
  warning: styles.statusWarning,
  alert: styles.statusAlert,
};

/**
 * Статус строки реестра: закрывает требование «отсутствие любого обучения ОТ
 * подсветить». Полный набор дат — в модалке, в таблице только агрегат.
 */
export const OtitbRowBadge: FC<{ person: IInductedPerson }> = ({ person }) => {
  const expired = person.trainings.filter(t => t.status === 'expired').length;
  const missing = person.missing.length;

  const label = missing > 0 && expired > 0
    ? `Нет обучения: ${missing}, просрочено: ${expired}`
    : missing > 0
      ? `Нет обучения: ${missing}`
      : expired > 0
        ? `Просрочено: ${expired}`
        : person.row_status === 'warning'
          ? 'Истекает'
          : 'В порядке';

  return <span className={`${styles.statusBadge} ${ROW_CLASS[person.row_status]}`}>{label}</span>;
};

interface ITrainingBadgeProps {
  state: IOtTrainingState | undefined;
  /** null — вид бессрочный, дата окончания не считается. */
  validMonths: number | null;
  /** Дата в форме изменена, но ещё не сохранена — срок пересчитает сервер. */
  dirty: boolean;
}

/** Состояние одного вида обучения в модалке: дата окончания + просрочка. */
export const OtitbTrainingBadge: FC<ITrainingBadgeProps> = ({ state, validMonths, dirty }) => {
  if (dirty) return <span className={styles.dirtyNote}>сохранить, чтобы пересчитать</span>;
  if (!state) return <span className={`${styles.statusBadge} ${styles.statusAlert}`}>нет данных</span>;
  if (validMonths === null) return <span className={styles.dirtyNote}>бессрочно</span>;

  if (state.status === 'expired') {
    return (
      <span className={`${styles.statusBadge} ${styles.statusAlert}`}>
        просрочено {fmtDate(state.valid_until)}
      </span>
    );
  }
  if (state.status === 'expiring') {
    return (
      <span className={`${styles.statusBadge} ${styles.statusWarning}`}>
        истекает {fmtDate(state.valid_until)}
      </span>
    );
  }
  return <span className={styles.dirtyNote}>до {fmtDate(state.valid_until)}</span>;
};
