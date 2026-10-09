import { useEffect, useRef, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

import { useAnchoredPopover } from '../../hooks/useAnchoredPopover';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { formatMonthsLabel, toggleMonthSelection } from '../../utils/monthsSelection';
import styles from './MonthsPicker.module.css';

interface IMonthsPickerProps {
  /** Выбранные месяцы (YYYY-MM); пусто — весь период. */
  value: string[];
  /** Месяцы окна по порядку (по возрастанию) — выбрать можно только их. */
  options: string[];
  onChange: (months: string[]) => void;
  /** Кнопка «Весь период» (пустой выбор). false — кнопки нет, последний месяц не снять. */
  allowAll?: boolean;
  /**
   * Без allowAll: выбор после «Очистить» (месяц по умолчанию) — применяется сразу, панель остаётся открытой.
   * Не передан — кнопки нет.
   */
  resetValue?: string[];
  /** Подпись кнопки для экранного диктора; к ней добавляется выбранный период. */
  ariaLabel?: string;
  /** Класс кнопки-триггера: размер под место, где стоит выбор. */
  className?: string;
}

/** Один и тот же набор месяцев, без учёта порядка. */
const sameMonths = (a: readonly string[], b: readonly string[]): boolean => (
  a.length === b.length && a.every(month => b.includes(month))
);

/** Синхронизировано с `.panel { min-width }` в MonthsPicker.module.css. */
const PANEL_MIN_WIDTH = 260;

const MONTH_NAMES = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

/**
 * Выбор одного или нескольких месяцев: клик по месяцу отмечает или снимает его, панель при этом
 * остаётся открытой. «Весь период» (если allowAll) снимает выбор; без него — «Очистить» (см. resetValue).
 */
export const MonthsPicker: FC<IMonthsPickerProps> = ({
  value,
  options,
  onChange,
  allowAll = true,
  resetValue,
  ariaLabel = 'Месяцы для виджетов и таблицы',
  className,
}) => {
  const [open, setOpen] = useState(false);
  const firstYear = options.length > 0 ? Number(options[0].slice(0, 4)) : null;
  const lastYear = options.length > 0 ? Number(options[options.length - 1].slice(0, 4)) : null;
  // Год листается только внутри открытой панели: null — год последнего выбранного месяца
  // (или последнего месяца окна).
  const [yearOverride, setYearOverride] = useState<number | null>(null);
  const anchorMonth = value.length > 0 ? [...value].sort().at(-1) : options.at(-1);
  const year = yearOverride ?? (anchorMonth ? Number(anchorMonth.slice(0, 4)) : new Date().getFullYear());

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelStyle = useAnchoredPopover(open, triggerRef, PANEL_MIN_WIDTH);

  const close = (): void => {
    setOpen(false);
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

  const toggle = (month: string): void => {
    onChange(toggleMonthSelection(value, month, allowAll));
  };

  const label = value.length === 0 ? 'весь период' : formatMonthsLabel(value);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={className ? `${styles.trigger} ${className}` : styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${ariaLabel}: ${label}`}
        title={label}
        disabled={options.length === 0}
        onClick={() => setOpen(prev => !prev)}
      >
        <span className={styles.triggerText}>{label}</span>
        <ChevronDown size={14} aria-hidden="true" className={styles.triggerIcon} />
      </button>

      {open && createPortal(
        <>
          <div className={styles.backdrop} {...backdrop} />
          <div
            className={styles.panel}
            style={{ ...panelStyle, width: 'auto' }}
            role="dialog"
            aria-label="Выбор месяцев"
          >
            <div className={styles.head}>
              <button
                type="button"
                className={styles.nav}
                onClick={() => setYearOverride(year - 1)}
                disabled={firstYear === null || year <= firstYear}
                aria-label="Предыдущий год"
              >
                ←
              </button>
              <span className={styles.year}>{year}</span>
              <button
                type="button"
                className={styles.nav}
                onClick={() => setYearOverride(year + 1)}
                disabled={lastYear === null || year >= lastYear}
                aria-label="Следующий год"
              >
                →
              </button>
            </div>

            <div className={styles.grid}>
              {MONTH_NAMES.map((name, index) => {
                const month = `${year}-${String(index + 1).padStart(2, '0')}`;
                const active = value.includes(month);
                return (
                  <button
                    key={month}
                    type="button"
                    className={`${styles.month}${active ? ` ${styles.monthActive}` : ''}`}
                    disabled={!options.includes(month)}
                    aria-pressed={active}
                    onClick={() => toggle(month)}
                  >
                    {name}
                  </button>
                );
              })}
            </div>

            {allowAll ? (
              <button
                type="button"
                className={styles.allPeriod}
                disabled={value.length === 0}
                onClick={() => {
                  onChange([]);
                  close();
                }}
              >
                Весь период
              </button>
            ) : resetValue && (
              <button
                type="button"
                className={styles.allPeriod}
                disabled={sameMonths(value, resetValue)}
                onClick={() => onChange(resetValue)}
              >
                Очистить
              </button>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
};
