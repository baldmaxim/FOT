import { type FC } from 'react';
import type { IInductedPerson } from '../../../services/contractorService';
import styles from './Otitb.module.css';

const ROW_CLASS: Record<IInductedPerson['row_status'], string> = {
  ok: styles.statusOk,
  warning: styles.statusWarning,
  alert: styles.statusAlert,
};

/**
 * Статус строки реестра. У подрядчиков вид один — вводный инструктаж, поэтому
 * счётчики «Нет обучения: N» лишние: показываем «Пройден» / «Не пройден».
 * Ветка со счётчиками остаётся на случай, если подрядчикам вернут другие виды.
 */
export const OtitbRowBadge: FC<{ person: IInductedPerson }> = ({ person }) => {
  const expired = person.trainings.filter(t => t.status === 'expired').length;
  const missing = person.missing.length;
  const single = person.trainings.length + missing === 1;

  const label = single
    ? (missing > 0 ? 'Не пройден' : expired > 0 ? 'Просрочен' : 'Пройден')
    : missing > 0 && expired > 0
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
