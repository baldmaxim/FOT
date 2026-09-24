import { useEffect, useMemo, useState, type CSSProperties, type FC } from 'react';
import { createPortal } from 'react-dom';

import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import { PAYROLL_TABLE_COLUMNS, type PayrollTableColumn } from '../../utils/payrollColumns';
import styles from './PayrollColumnsMenu.module.css';

interface IPayrollColumnsMenuProps {
  /** Кнопка-шестерёнка: меню открывается под ней, выровненным по её правому краю. */
  anchor: HTMLElement;
  hidden: ReadonlySet<PayrollTableColumn>;
  onToggle: (column: PayrollTableColumn, visible: boolean) => void;
  onShowAll: () => void;
  onClose: () => void;
}

const MENU_WIDTH = 280;
/** Смартфон — лист снизу, как у фильтра столбца. */
const SHEET_MEDIA = '(max-width: 768px)';

/**
 * Выбор видимых столбцов таблицы условий оплаты. Галочка применяется сразу;
 * закрытие — Escape, клик мимо или «Готово».
 */
export const PayrollColumnsMenu: FC<IPayrollColumnsMenuProps> = ({ anchor, hidden, onToggle, onShowAll, onClose }) => {
  const dismiss = useOverlayDismiss(onClose);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Позиция считается один раз при открытии: меню модальное, страница под ним не прокручивается.
  const [isSheet] = useState(() => window.matchMedia(SHEET_MEDIA).matches);
  const style = useMemo<CSSProperties | undefined>(() => {
    if (isSheet) return undefined;
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.right - MENU_WIDTH, window.innerWidth - MENU_WIDTH - 8));
    return { top: rect.bottom + 6, left, width: MENU_WIDTH };
  }, [anchor, isSheet]);

  return createPortal(
    <>
      <div className={styles.backdrop} {...dismiss} />
      <div
        className={isSheet ? `${styles.menu} ${styles.sheet}` : styles.menu}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label="Столбцы таблицы"
      >
        <div className={styles.title}>Столбцы таблицы</div>
        <p className={styles.fixed}>«Сотрудник» показывается всегда</p>

        <ul className={styles.list}>
          {PAYROLL_TABLE_COLUMNS.map((column, index) => (
            <li key={column.key}>
              <label className={styles.option}>
                <input
                  type="checkbox"
                  className={styles.checkbox}
                  checked={!hidden.has(column.key)}
                  autoFocus={index === 0}
                  onChange={event => onToggle(column.key, event.target.checked)}
                />
                <span>{column.label}</span>
              </label>
            </li>
          ))}
        </ul>

        <div className={styles.footer}>
          <button type="button" className={styles.link} onClick={onShowAll} disabled={hidden.size === 0}>
            Показать все
          </button>
          <button type="button" className={styles.doneButton} onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
};
