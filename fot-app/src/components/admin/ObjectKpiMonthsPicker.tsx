import { useEffect, useRef, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

import { useAnchoredPopover } from '../../hooks/useAnchoredPopover';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { formatMonthsLabel } from '../../utils/objectKpiTable';
import styles from './ObjectKpiMonthsPicker.module.css';

interface IObjectKpiMonthsPickerProps {
  /** Выбранные месяцы (YYYY-MM); пусто — весь период. */
  value: string[];
  /** Месяцы окна расчёта по порядку — выбрать можно только их. */
  options: string[];
  onChange: (months: string[]) => void;
}

/** Синхронизировано с `.panel { min-width }` в ObjectKpiMonthsPicker.module.css. */
const PANEL_MIN_WIDTH = 260;

const MONTH_NAMES = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

/**
 * Выбор одного или нескольких месяцев для плиток и таблиц вкладки: клик по месяцу отмечает
 * или снимает его, панель при этом остаётся открытой. «Весь период» снимает выбор.
 */
export const ObjectKpiMonthsPicker: FC<IObjectKpiMonthsPickerProps> = ({ value, options, onChange }) => {
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
    onChange(value.includes(month) ? value.filter(item => item !== month) : [...value, month].sort());
  };

  const label = value.length === 0 ? 'весь период' : formatMonthsLabel(value);

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={styles.trigger}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Месяцы для виджетов и таблицы: ${label}`}
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
          </div>
        </>,
        document.body,
      )}
    </>
  );
};
