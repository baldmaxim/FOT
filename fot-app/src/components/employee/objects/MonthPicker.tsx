import type { ChangeEvent, FC } from 'react';

import { formatMonthLabel } from '../../../utils/formatMoney';
import styles from './premium.module.css';

interface IMonthPickerProps {
  /** Выбранный месяц в формате YYYY-MM-01 или YYYY-MM. */
  value: string;
  /** Верхняя граница — обычно текущий месяц по МСК: будущих расчётов не бывает. */
  max: string;
  onChange: (month: string) => void;
}

/**
 * Кликабельный месяц в шапке плашки. Нативный `input[type=month]` растянут по подписи
 * с opacity: 0 — свой дропдаун пришлось бы отдельно чинить под iOS и Android.
 */
export const MonthPicker: FC<IMonthPickerProps> = ({ value, max, onChange }) => {
  const month = value.slice(0, 7);

  const handleChange = (event: ChangeEvent<HTMLInputElement>): void => {
    // «Очистить» в нативном пикере отдаёт пустую строку: из неё получился бы период NaN-NaN.
    if (!event.target.value) return;
    onChange(`${event.target.value}-01`);
  };

  return (
    <label className={styles.monthPicker}>
      <span className={styles.monthPickerText}>{formatMonthLabel(value)}</span>
      <svg className={styles.monthPickerIcon} width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
      </svg>
      <input
        className={styles.monthPickerInput}
        type="month"
        value={month}
        max={max.slice(0, 7)}
        onChange={handleChange}
        aria-label="Расчётный месяц"
      />
    </label>
  );
};
