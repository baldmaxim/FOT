import { useEffect, useMemo, useState, type CSSProperties, type FC } from 'react';
import { createPortal } from 'react-dom';

import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import type { IPayrollDeductionKind } from '../../services/payrollService';
import shared from './PayrollColumnsMenu.module.css';
import styles from './DeductionKindsMenu.module.css';

interface IDeductionKindsMenuProps {
  /** Ячейка или поле: меню открывается под ним, по его левому краю. */
  anchor: HTMLElement;
  /** Чьи удержания — подпись под заголовком. */
  subtitle?: string;
  kinds: readonly IPayrollDeductionKind[];
  selected: readonly number[];
  onToggle: (kindId: number, checked: boolean) => void;
  onClose: () => void;
  /** Меню из формы таблицы «Удержания» — слой над окном формы. */
  aboveForm?: boolean;
}

const MENU_WIDTH = 300;
/** Места под якорем меньше — и сверху больше: меню раскрывается вверх. */
const MIN_SPACE_BELOW = 320;
const VIEWPORT_GAP = 8;
/** Смартфон — лист снизу, как у меню «Столбцы таблицы». */
const SHEET_MEDIA = '(max-width: 768px)';

/**
 * Выпадающий список «Удержание»: виды справочника галочками (несколько сразу). Новые виды
 * добавляются в «Справочнике» на «Расчётах». Галочка применяется сразу; закрытие — Escape,
 * клик мимо или «Готово».
 */
export const DeductionKindsMenu: FC<IDeductionKindsMenuProps> = ({
  anchor, subtitle, kinds, selected, onToggle, onClose, aboveForm = false,
}) => {
  const dismiss = useOverlayDismiss(onClose);

  // Перехват на document: Escape закрывает только меню, а не окно сотрудника под ним (оно слушает window).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  // Позиция считается один раз при открытии: меню модальное, страница под ним не прокручивается.
  // Поле у низа экрана (карточка) — меню раскрывается вверх; высота — по свободному месту.
  const [isSheet] = useState(() => window.matchMedia(SHEET_MEDIA).matches);
  const style = useMemo<CSSProperties | undefined>(() => {
    if (isSheet) return undefined;
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(VIEWPORT_GAP, Math.min(rect.left, window.innerWidth - MENU_WIDTH - VIEWPORT_GAP));
    const spaceBelow = window.innerHeight - rect.bottom - 6 - VIEWPORT_GAP;
    const spaceAbove = rect.top - 6 - VIEWPORT_GAP;
    if (spaceBelow >= MIN_SPACE_BELOW || spaceBelow >= spaceAbove) {
      return { top: rect.bottom + 6, left, width: MENU_WIDTH, maxHeight: spaceBelow };
    }
    return { bottom: window.innerHeight - rect.top + 6, left, width: MENU_WIDTH, maxHeight: spaceAbove };
  }, [anchor, isSheet]);

  const selectedSet = new Set(selected);

  return createPortal(
    <>
      <div className={`${shared.backdrop} ${aboveForm ? styles.aboveForm : styles.raisedBackdrop}`} {...dismiss} />
      <div
        className={`${isSheet ? `${shared.menu} ${shared.sheet}` : shared.menu} ${aboveForm ? styles.aboveFormMenu : styles.raisedMenu}`}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label="Удержание"
      >
        <div className={shared.title}>Удержание</div>
        {subtitle && <p className={shared.fixed}>{subtitle}</p>}

        <ul className={shared.list}>
          {kinds.map((kind, index) => (
            <li key={kind.id}>
              <label className={shared.option}>
                <input
                  type="checkbox"
                  className={shared.checkbox}
                  checked={selectedSet.has(kind.id)}
                  autoFocus={index === 0}
                  onChange={event => onToggle(kind.id, event.target.checked)}
                />
                <span>{kind.name}</span>
              </label>
            </li>
          ))}
        </ul>

        <div className={shared.footer}>
          <span />
          <button type="button" className={shared.doneButton} onClick={onClose}>
            Готово
          </button>
        </div>
      </div>
    </>,
    document.body,
  );
};
