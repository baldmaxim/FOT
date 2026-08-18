import { useEffect, useRef, useState, type FC } from 'react';
import { createPortal } from 'react-dom';

import { useAnchoredPopover } from '../../../hooks/useAnchoredPopover';
import { useOverlayDismiss } from '../../../hooks/useOverlayDismiss';
import { formatMonthLabel } from '../../../utils/formatMoney';
import styles from './premium.module.css';

interface IMonthPickerProps {
  /** Выбранный месяц в формате YYYY-MM-01 или YYYY-MM. */
  value: string;
  /** Верхняя граница — обычно текущий месяц по МСК: будущих расчётов не бывает. */
  max: string;
  onChange: (month: string) => void;
}

const MONTH_NAMES = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

/**
 * Выбор расчётного месяца.
 *
 * Свой поповер, а не нативный `input[type=month]`: тот открывает выпадашку только по
 * клику в собственную иконку календаря, и растянутый по подписи прозрачный инпут просто
 * не реагировал на клик — месяц было не сменить.
 */
export const MonthPicker: FC<IMonthPickerProps> = ({ value, max, onChange }) => {
  const [open, setOpen] = useState(false);
  const selectedMonth = value.slice(0, 7);
  const maxMonth = max.slice(0, 7);
  // Год листается только внутри открытой панели, поэтому это состояние — не копия
  // выбранного месяца, а её переопределение: null означает «показывай год выбора».
  const [yearOverride, setYearOverride] = useState<number | null>(null);
  const year = yearOverride ?? Number(selectedMonth.slice(0, 4));

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelStyle = useAnchoredPopover(open, triggerRef);

  const close = (): void => {
    setOpen(false);
    // Год сбрасывается при закрытии: следующее открытие показывает год выбранного месяца.
    setYearOverride(null);
    triggerRef.current?.focus();
  };
  const backdrop = useOverlayDismiss(close);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const maxYear = Number(maxMonth.slice(0, 4));

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={styles.monthPicker}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Расчётный месяц"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className={styles.monthPickerText}>{formatMonthLabel(value)}</span>
        <svg className={styles.monthPickerIcon} width="14" height="14" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
      </button>

      {open && createPortal(
        <>
          <div className={styles.pickerBackdrop} {...backdrop} />
          <div
            className={styles.pickerPanel}
            style={{ ...panelStyle, width: 'auto' }}
            role="dialog"
            aria-label="Выбор расчётного месяца"
          >
            <div className={styles.pickerHead}>
              <button
                type="button"
                className={styles.pickerNav}
                onClick={() => setYearOverride(year - 1)}
                aria-label="Предыдущий год"
              >
                ←
              </button>
              <span className={styles.pickerYear}>{year}</span>
              <button
                type="button"
                className={styles.pickerNav}
                onClick={() => setYearOverride(year + 1)}
                disabled={year >= maxYear}
                aria-label="Следующий год"
              >
                →
              </button>
            </div>

            <div className={styles.pickerGrid}>
              {MONTH_NAMES.map((name, index) => {
                const month = `${year}-${String(index + 1).padStart(2, '0')}`;
                const disabled = month > maxMonth;
                const active = month === selectedMonth;
                return (
                  <button
                    key={month}
                    type="button"
                    className={`${styles.pickerMonth} ${active ? styles.pickerMonthActive : ''}`}
                    disabled={disabled}
                    aria-pressed={active}
                    onClick={() => {
                      onChange(`${month}-01`);
                      close();
                    }}
                  >
                    {name}
                  </button>
                );
              })}
            </div>
          </div>
        </>,
        document.body,
      )}
    </>
  );
};
