import { useEffect, useRef, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown } from 'lucide-react';

import { useAnchoredPopover } from '../../hooks/useAnchoredPopover';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { formatMonthLabel } from '../../utils/formatMoney';
import gridStyles from './MonthsPicker.module.css';
import styles from './MonthSelect.module.css';

interface IMonthSelectProps {
  /** Выбранный месяц (YYYY-MM); '' — не выбран (тогда на кнопке emptyLabel). */
  value: string;
  /** Месяцы, которые можно выбрать (YYYY-MM, по возрастанию); остальные в сетке неактивны. */
  options: readonly string[];
  onChange: (month: string) => void;
  /** Кнопка пустого выбора в панели и подпись кнопки при '' («Бессрочно»); не передан — пустого выбора нет. */
  emptyLabel?: string;
  disabled?: boolean;
  invalid?: boolean;
  /** id подписи поля — кнопка называется по ней. */
  labelledBy?: string;
  describedBy?: string;
  /** Класс кнопки — вид поля там, где стоит выбор (в окнах — как у select). */
  className?: string;
}

/** Синхронизировано с `.panel { min-width }` в MonthsPicker.module.css. */
const PANEL_MIN_WIDTH = 260;

const MONTH_NAMES = [
  'янв', 'фев', 'мар', 'апр', 'май', 'июн',
  'июл', 'авг', 'сен', 'окт', 'ноя', 'дек',
];

/**
 * Выбор одного месяца: кнопка-поле и панель «← год →» с сеткой 12 месяцев (как выбор месяцев в шапке таблиц,
 * MonthsPicker). Клик по месяцу выбирает его и закрывает панель; emptyLabel — кнопка пустого выбора. Вместо
 * нативного select: список на 5 лет вперёд листать неудобно.
 */
export const MonthSelect: FC<IMonthSelectProps> = ({
  value, options, onChange, emptyLabel, disabled = false, invalid = false, labelledBy, describedBy, className,
}) => {
  const [open, setOpen] = useState(false);
  const firstYear = options.length > 0 ? Number(options[0].slice(0, 4)) : null;
  const lastYear = options.length > 0 ? Number(options[options.length - 1].slice(0, 4)) : null;
  // Год листается только внутри открытой панели: null — год выбранного месяца, без выбора — первого доступного.
  const [yearOverride, setYearOverride] = useState<number | null>(null);
  const anchorMonth = value || options[0];
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
    // Escape закрывает только панель, не окно под ней.
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        close();
      }
    };
    document.addEventListener('keydown', onKeyDown, true);
    return () => document.removeEventListener('keydown', onKeyDown, true);
  }, [open]);

  const choose = (month: string): void => {
    onChange(month);
    close();
  };

  const label = value ? formatMonthLabel(value) : (emptyLabel ?? '');

  return (
    <>
      <button
        type="button"
        ref={triggerRef}
        className={[styles.trigger, className, invalid ? styles.invalid : null].filter(Boolean).join(' ')}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        disabled={disabled}
        onClick={() => setOpen(prev => !prev)}
      >
        <span className={styles.text}>{label}</span>
        <ChevronDown size={16} aria-hidden="true" className={styles.icon} />
      </button>

      {open && createPortal(
        <>
          <div className={gridStyles.backdrop} {...backdrop} />
          <div
            className={gridStyles.panel}
            style={{ ...panelStyle, width: 'auto' }}
            role="dialog"
            aria-label="Выбор месяца"
          >
            <div className={gridStyles.head}>
              <button
                type="button"
                className={gridStyles.nav}
                onClick={() => setYearOverride(year - 1)}
                disabled={firstYear === null || year <= firstYear}
                aria-label="Предыдущий год"
              >
                ←
              </button>
              <span className={gridStyles.year}>{year}</span>
              <button
                type="button"
                className={gridStyles.nav}
                onClick={() => setYearOverride(year + 1)}
                disabled={lastYear === null || year >= lastYear}
                aria-label="Следующий год"
              >
                →
              </button>
            </div>

            <div className={gridStyles.grid}>
              {MONTH_NAMES.map((name, index) => {
                const month = `${year}-${String(index + 1).padStart(2, '0')}`;
                const active = month === value;
                return (
                  <button
                    key={month}
                    type="button"
                    className={`${gridStyles.month}${active ? ` ${gridStyles.monthActive}` : ''}`}
                    disabled={!options.includes(month)}
                    aria-pressed={active}
                    aria-label={formatMonthLabel(month)}
                    onClick={() => choose(month)}
                  >
                    {name}
                  </button>
                );
              })}
            </div>

            {emptyLabel && (
              <button
                type="button"
                className={`${gridStyles.allPeriod}${value === '' ? ` ${styles.emptyActive}` : ''}`}
                aria-pressed={value === ''}
                onClick={() => choose('')}
              >
                {emptyLabel}
              </button>
            )}
          </div>
        </>,
        document.body,
      )}
    </>
  );
};
