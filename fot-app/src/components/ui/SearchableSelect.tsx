import { useState, useMemo, useRef, useCallback, useEffect, useLayoutEffect, memo, type FC, type ChangeEvent, type KeyboardEvent, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, X } from 'lucide-react';
import { useOverlayDismiss } from '../../hooks/useOverlayDismiss';
import styles from './SearchableSelect.module.css';

export interface ISearchableSelectOption {
  value: string;
  label: string;
}

interface ISearchableSelectProps {
  options: ISearchableSelectOption[];
  /** Выбранное значение; '' — вариант «все». */
  value: string;
  onChange: (value: string) => void;
  /** Подпись варианта «все» — она же текст поля, пока ничего не выбрано. */
  allLabel: string;
  placeholder?: string;
  ariaLabel?: string;
}

/** Панель не ниже этого, даже если под полем почти не осталось места. */
const PANEL_MIN_HEIGHT = 160;
/** Зазор от панели до низа видимой области. */
const PANEL_BOTTOM_GAP = 12;

/**
 * Плоский список с поиском — вид и поведение как у DepartmentTreeSelect:
 * печатаем прямо в поле, список под ним фильтруется по подписи.
 */
export const SearchableSelect: FC<ISearchableSelectProps> = memo(({
  options,
  value,
  onChange,
  allLabel,
  placeholder = 'Поиск...',
  ariaLabel,
}) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const triggerRef = useRef<HTMLDivElement>(null);
  const [panelStyle, setPanelStyle] = useState<CSSProperties>({});

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter(o => o.label.toLowerCase().includes(q));
  }, [options, query]);

  // Выбранного значения может уже не быть в списке, а фильтр по нему действует —
  // показываем само значение, а не «все».
  const selectedLabel = useMemo(
    () => (value ? (options.find(o => o.value === value)?.label ?? value) : allLabel),
    [options, value, allLabel],
  );

  const closePanel = useCallback(() => {
    setOpen(false);
    setQuery('');
    inputRef.current?.blur();
  }, []);

  const openPanel = useCallback(() => {
    if (open) return;
    setOpen(true);
    setQuery('');
  }, [open]);

  const overlay = useOverlayDismiss(closePanel);

  // Панель в портале — под полем, по его координатам (пересчёт при resize/scroll).
  // Высота — до низа видимой области: на телефоне её уменьшает клавиатура (visualViewport).
  // На мобиле (<=430px) CSS растягивает панель на ширину экрана.
  const updatePanelPosition = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const vv = window.visualViewport;
    const viewportBottom = vv ? vv.offsetTop + vv.height : window.innerHeight;
    setPanelStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left: rect.left,
      minWidth: rect.width,
      maxHeight: Math.max(PANEL_MIN_HEIGHT, viewportBottom - rect.bottom - PANEL_BOTTOM_GAP),
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return;
    updatePanelPosition();
  }, [open, updatePanelPosition]);

  useEffect(() => {
    if (!open) return;
    const handler = () => updatePanelPosition();
    const vv = window.visualViewport;
    window.addEventListener('resize', handler);
    window.addEventListener('scroll', handler, true);
    vv?.addEventListener('resize', handler);
    vv?.addEventListener('scroll', handler);
    return () => {
      window.removeEventListener('resize', handler);
      window.removeEventListener('scroll', handler, true);
      vv?.removeEventListener('resize', handler);
      vv?.removeEventListener('scroll', handler);
    };
  }, [open, updatePanelPosition]);

  const pick = useCallback((next: string) => {
    onChange(next);
    closePanel();
  }, [onChange, closePanel]);

  const handleInputChange = useCallback((e: ChangeEvent<HTMLInputElement>) => {
    if (!open) openPanel();
    setQuery(e.target.value);
  }, [open, openPanel]);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closePanel();
    }
  }, [closePanel]);

  // Крестик: при поиске — стирает текст (список остаётся открытым); без поиска — сбрасывает на «все».
  const canClear = open ? query.length > 0 : value !== '';
  const handleClear = useCallback(() => {
    if (open) {
      setQuery('');
      inputRef.current?.focus();
      return;
    }
    onChange('');
  }, [open, onChange]);

  return (
    <div className={styles.wrapper}>
      <div
        ref={triggerRef}
        className={`${styles.trigger}${open ? ` ${styles.triggerOpen}` : ''}${canClear ? ` ${styles.hasClear}` : ''}`}
      >
        <input
          ref={inputRef}
          className={styles.input}
          value={open ? query : selectedLabel}
          placeholder={placeholder}
          onChange={handleInputChange}
          onFocus={openPanel}
          onKeyDown={handleKeyDown}
          aria-label={ariaLabel}
          aria-expanded={open}
        />
        <span className={styles.adornment}>
          {canClear && (
            <button
              type="button"
              className={styles.clear}
              // Клик не уводит фокус из поля: список при поиске не закрывается.
              onMouseDown={e => e.preventDefault()}
              onClick={handleClear}
              aria-label={open ? 'Очистить поиск' : 'Сбросить выбор'}
              title={open ? 'Очистить' : allLabel}
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
          <ChevronDown size={14} aria-hidden="true" />
        </span>
      </div>

      {open && createPortal(
        <>
          <div
            className={styles.backdrop}
            onMouseDown={overlay.onMouseDown}
            onMouseUp={overlay.onMouseUp}
            onMouseLeave={overlay.onMouseLeave}
            onTouchStart={overlay.onTouchStart}
            onTouchEnd={overlay.onTouchEnd}
          />
          <div className={styles.panel} style={panelStyle}>
            <div className={styles.list}>
              <div
                className={`${styles.option} ${styles.allOption}${!value ? ` ${styles.optionActive}` : ''}`}
                onClick={() => pick('')}
              >
                {allLabel}
              </div>
              {filtered.map(o => (
                <div
                  key={o.value}
                  className={`${styles.option}${o.value === value ? ` ${styles.optionActive}` : ''}`}
                  onClick={() => pick(o.value)}
                >
                  {o.label}
                </div>
              ))}
              {filtered.length === 0 && <div className={styles.empty}>Не найдено</div>}
            </div>
          </div>
        </>,
        document.body,
      )}
    </div>
  );
});
