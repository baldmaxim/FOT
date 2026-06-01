import { useEffect, useMemo, useRef, useState, type FC } from 'react';
import { createPortal } from 'react-dom';
import { Check, X } from 'lucide-react';
import { useAnchoredPopover } from '../../hooks/useAnchoredPopover';
import styles from '../../pages/admin/Admin.module.css';

interface IObjectOption {
  id: string;
  name: string;
}

interface IProps {
  objects: IObjectOption[];
  value: string[];
  onSave: (objectIds: string[]) => Promise<void>;
  loading?: boolean;
  disabled?: boolean;
  /** Текст триггера, когда ничего не выбрано. */
  emptyLabel?: string;
}

const arraysEqual = (left: string[], right: string[]): boolean => {
  if (left.length !== right.length) return false;
  const a = [...left].sort();
  const b = [...right].sort();
  return a.every((v, i) => v === b[i]);
};

const normalize = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').trim();

/**
 * Переиспользуемый мультиселект «объекты входа» в popover'е.
 * Паттерн взят из UserCompanyAccessSection (та же вёрстка/классы).
 */
export const ObjectAccessPopover: FC<IProps> = ({ objects, value, onSave, loading, disabled, emptyLabel = 'Объекты не назначены' }) => {
  const [draft, setDraft] = useState<string[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const popoverStyle = useAnchoredPopover(open, triggerRef);

  // Сброс draft при смене внешнего значения (например, после refetch).
  useEffect(() => {
    setDraft(null);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: MouseEvent | TouchEvent) => {
      const wrapNode = wrapRef.current;
      const popoverNode = popoverRef.current;
      if (!wrapNode || !popoverNode) return;
      const target = event.target as Node | null;
      if (target && (wrapNode.contains(target) || popoverNode.contains(target))) return;
      setOpen(false);
    };
    const escHandler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    // Скролл НЕ закрывает попап (раньше autoFocus-инпут скроллил себя в видимость
    // и ложно закрывал список) — позицию обновляет useAnchoredPopover.
    document.addEventListener('mousedown', handler);
    document.addEventListener('touchstart', handler);
    document.addEventListener('keydown', escHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('touchstart', handler);
      document.removeEventListener('keydown', escHandler);
    };
  }, [open]);

  const current = draft ?? value;
  const hasChanges = !arraysEqual(current, value);

  const toggle = (id: string) => {
    setDraft(() => {
      const set = new Set(current);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      return [...set];
    });
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      await onSave(current);
      setDraft(null);
      setOpen(false);
    } finally {
      setSaving(false);
    }
  };

  const selectedNames = objects.filter(o => current.includes(o.id)).map(o => o.name);
  const triggerText = loading
    ? 'Загрузка…'
    : selectedNames.length > 0
      ? selectedNames.join(', ')
      : emptyLabel;

  const filtered = useMemo(() => {
    const q = normalize(search);
    const list = !q ? objects : objects.filter(o => normalize(o.name).includes(q));
    const selected = new Set(value);
    return [...list].sort((a, b) => {
      const aSelected = selected.has(a.id) ? 0 : 1;
      const bSelected = selected.has(b.id) ? 0 : 1;
      return aSelected - bSelected;
    });
  }, [objects, search, value]);

  return (
    <div className={styles.companyAccessWrap} ref={wrapRef}>
      <div className={styles.companyAccessRow}>
        <div className={styles.companyAccessTriggerSlot}>
          <button
            type="button"
            ref={triggerRef}
            className={`${styles.companyAccessTrigger} ${open ? styles.companyAccessTriggerOpen : ''}`}
            onClick={() => setOpen(prev => !prev)}
            disabled={disabled}
          >
            <span
              className={`${styles.companyAccessTriggerText} ${selectedNames.length === 0 ? styles.companyAccessTriggerSystem : ''}`}
              title={selectedNames.join(', ')}
            >
              {triggerText}
            </span>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
              className={`${styles.companyAccessChevron} ${open ? styles.companyAccessChevronOpen : ''}`}>
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {open && createPortal(
            <div ref={popoverRef} style={popoverStyle} className={styles.companyAccessPopover}>
              {objects.length > 8 && (
                <input
                  type="text"
                  value={search}
                  onChange={e => setSearch(e.target.value)}
                  placeholder="Поиск объекта…"
                  className={styles.companyAccessSearch}
                  autoFocus
                />
              )}
              {loading ? (
                <div className={styles.departmentAccessEmpty}>Загрузка…</div>
              ) : filtered.length === 0 ? (
                <div className={styles.departmentAccessEmpty}>Объекты не найдены</div>
              ) : (
                <div className={styles.companyAccessPopoverList}>
                  {filtered.map(obj => {
                    const checked = current.includes(obj.id);
                    return (
                      <label
                        key={obj.id}
                        className={`${styles.departmentAccessItem} ${checked ? styles.departmentAccessItemChecked : ''}`}
                      >
                        <input type="checkbox" checked={checked} onChange={() => toggle(obj.id)} />
                        <span className={styles.departmentAccessItemLabel}>{obj.name}</span>
                      </label>
                    );
                  })}
                </div>
              )}
            </div>,
            document.body,
          )}
        </div>

        {hasChanges && (
          <>
            <button
              type="button"
              className={styles.companyAccessConfirm}
              onClick={() => void handleSave()}
              disabled={saving}
              aria-label="Сохранить"
              title="Сохранить"
            >
              <Check size={18} strokeWidth={2.5} />
            </button>
            <button
              type="button"
              className={styles.companyAccessRevert}
              onClick={() => setDraft(null)}
              disabled={saving}
              aria-label="Отменить"
              title="Отменить"
            >
              <X size={18} strokeWidth={2.5} />
            </button>
          </>
        )}
      </div>
    </div>
  );
};
