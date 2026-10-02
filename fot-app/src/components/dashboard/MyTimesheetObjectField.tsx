import { type FC } from 'react';
import styles from './MyTimesheetObjectField.module.css';

interface IMyTimesheetObjectFieldProps {
  label: string;
  /** Подпись объекта табелирования; null — объекта нет, поле не показывается. */
  value: string | null;
  /** row — подпись слева, значение справа (карточка дня ЛК); stack — в столбик (ЛК рабочего). */
  layout: 'row' | 'stack';
}

/**
 * Объект табелирования в ЛК (миграция 288) — только показ: объект ставит ночной расчёт
 * по часам, «Офис» — окно «Режим табелирования». Объекта нет (у рабочих — разбивка по
 * проходам) — поле не показывается.
 */
export const MyTimesheetObjectField: FC<IMyTimesheetObjectFieldProps> = ({ label, value, layout }) => {
  if (!value) return null;
  return (
    <div className={layout === 'row' ? styles.row : styles.stack}>
      <span className={styles.label}>{label}</span>
      <span className={styles.value}>{value}</span>
    </div>
  );
};
