import { type FC, useEffect, useRef, useState } from 'react';
import type { IMtsGeofence } from '../../services/mtsService';
import styles from './MtsPage.module.css';

interface IProps {
  /** Текущий набор выбранных id геозон. */
  value: string[];
  /** Полный список геозон. */
  options: IMtsGeofence[];
  /** Изменения применяются сразу — массив итоговых id геозон. */
  onChange: (next: string[]) => void;
  disabled?: boolean;
  placeholder?: string;
}

export const GeofenceMultiSelect: FC<IProps> = ({ value, options, onChange, disabled, placeholder }) => {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const byId = new Map(options.map(o => [o.id, o]));
  const valid = value.filter(id => byId.has(id));

  const toggle = (id: string): void => {
    if (valid.includes(id)) onChange(valid.filter(v => v !== id));
    else onChange([...valid, id]);
  };

  const removeChip = (id: string): void => {
    onChange(valid.filter(v => v !== id));
  };

  return (
    <div ref={wrapRef} style={{ position: 'relative', display: 'inline-block' }}>
      <div className={styles.chipList}>
        {valid.map(id => {
          const geo = byId.get(id);
          if (!geo) return null;
          return (
            <span key={id} className={styles.chip} title={geo.name}>
              <span className={styles.chipText}>{geo.name}</span>
              {!disabled && (
                <button type="button" className={styles.chipRemove} onClick={() => removeChip(id)} aria-label="Убрать">
                  ×
                </button>
              )}
            </span>
          );
        })}
        <button
          type="button"
          className={styles.chipAdd}
          disabled={disabled}
          onClick={() => setOpen(o => !o)}
        >
          {valid.length === 0 ? (placeholder ?? '+ Выбрать') : '+ Добавить'}
        </button>
      </div>
      {open && (
        <div className={styles.popover} style={{ top: '100%', left: 0, marginTop: 4 }}>
          {options.length === 0 && <div className={styles.fioPickerHint}>Геозон ещё нет</div>}
          {options.map(o => (
            <label key={o.id} className={styles.popoverItem}>
              <input
                type="checkbox"
                checked={valid.includes(o.id)}
                onChange={() => toggle(o.id)}
              />
              <span>{o.name}</span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
};
