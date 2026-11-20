import { useEffect, useMemo, useState, type CSSProperties, type FC } from 'react';
import { createPortal } from 'react-dom';

import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import styles from './ColumnValuesFilterPopover.module.css';

const POPOVER_WIDTH = 320;
/** Уже этой ширины окно открывается листом снизу во всю ширину. */
const SHEET_MEDIA = '(max-width: 768px)';

export interface IColumnValueOption {
  value: string;
  count: number;
}

interface IColumnValuesFilterPopoverProps {
  label: string;
  /** Варианты значений столбца со счётчиками — считает вызывающий по строкам экрана. */
  options: IColumnValueOption[];
  selected: string[];
  /** Кнопка-воронка, под которой открывается окно. */
  anchor: HTMLElement;
  /** Выбранные значения; null — снять фильтр столбца. */
  onApply: (values: string[] | null) => void;
  onClose: () => void;
  /** Таблица внутри модального окна: подложка и окно фильтра — над ним. */
  raised?: boolean;
  /**
   * Галочка над списком («Уволенные» у столбца «Сотрудник» «Проживания»): применяется вместе с «Применить»,
   * «Сбросить» её включает.
   */
  toggle?: { label: string; checked: boolean; onApply: (checked: boolean) => void };
}

/**
 * Фильтр столбца по значениям — как в «Текущих сотрудниках» и «Зарплате», но без запроса к
 * серверу: все строки таблицы уже на клиенте. Применяется только по «Применить».
 */
export const ColumnValuesFilterPopover: FC<IColumnValuesFilterPopoverProps> = ({
  label, options, selected: initialSelected, anchor, onApply, onClose, raised = false, toggle,
}) => {
  const [selected, setSelected] = useState<string[]>(initialSelected);
  const [toggleChecked, setToggleChecked] = useState(toggle?.checked ?? true);
  const [search, setSearch] = useState('');
  const dismiss = useOverlayDismiss(onClose);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Позиция считается один раз при открытии: окно модальное, таблица под ним не прокручивается.
  const [isSheet] = useState(() => window.matchMedia(SHEET_MEDIA).matches);
  const style = useMemo<CSSProperties | undefined>(() => {
    if (isSheet) return undefined;
    const rect = anchor.getBoundingClientRect();
    const left = Math.max(8, Math.min(rect.left - POPOVER_WIDTH / 2, window.innerWidth - POPOVER_WIDTH - 8));
    return { top: rect.bottom + 6, left, width: POPOVER_WIDTH };
  }, [anchor, isSheet]);

  const selectedSet = useMemo(() => new Set(selected), [selected]);
  const query = search.trim().toLocaleLowerCase('ru');
  const visible = useMemo(
    () => (query ? options.filter(item => item.value.toLocaleLowerCase('ru').includes(query)) : options),
    [options, query],
  );

  const toggleValue = (value: string) => {
    setSelected(prev => (prev.includes(value) ? prev.filter(item => item !== value) : [...prev, value]));
  };
  const selectVisible = () => {
    setSelected(prev => [...new Set([...prev, ...visible.map(item => item.value)])]);
  };

  const apply = () => {
    onApply(selected.length > 0 ? selected : null);
    toggle?.onApply(toggleChecked);
    onClose();
  };
  const reset = () => {
    onApply(null);
    toggle?.onApply(true);
    onClose();
  };

  return createPortal(
    <>
      <div className={`${styles.backdrop}${raised ? ` ${styles.raised}` : ''}`} {...dismiss} />
      <div
        className={`${styles.popover}${isSheet ? ` ${styles.sheet}` : ''}${raised ? ` ${styles.raisedPopover}` : ''}`}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-label={`Фильтр: ${label}`}
      >
        <div className={styles.title}>{label}</div>
        {toggle && (
          <label className={`${styles.option} ${styles.toggle}`}>
            <input type="checkbox" checked={toggleChecked} onChange={event => setToggleChecked(event.target.checked)} />
            <span className={styles.optionLabel}>{toggle.label}</span>
          </label>
        )}
        <input
          className={styles.input}
          type="search"
          value={search}
          onChange={event => setSearch(event.target.value)}
          placeholder="Найти значение…"
          aria-label="Найти значение"
          autoFocus
        />
        <div className={styles.bulk}>
          <button type="button" className={styles.link} onClick={selectVisible} disabled={visible.length === 0}>
            Выбрать показанные
          </button>
          <button type="button" className={styles.link} onClick={() => setSelected([])} disabled={selected.length === 0}>
            Снять всё
          </button>
        </div>
        <div className={styles.list} role="group" aria-label="Значения">
          {visible.length === 0 && <div className={styles.hint}>Ничего не найдено</div>}
          {visible.map(item => (
            <label key={item.value} className={styles.option}>
              <input type="checkbox" checked={selectedSet.has(item.value)} onChange={() => toggleValue(item.value)} />
              <span className={styles.optionLabel}>{item.value}</span>
              <span className={styles.count}>{item.count}</span>
            </label>
          ))}
        </div>
        {selected.length > 0 && <div className={styles.hint}>Выбрано: {selected.length}</div>}

        <div className={styles.footer}>
          <button type="button" className={styles.secondaryButton} onClick={reset}>Сбросить</button>
          <button type="button" className={styles.primaryButton} onClick={apply}>Применить</button>
        </div>
      </div>
    </>,
    document.body,
  );
};
