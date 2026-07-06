import { type FC, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useMtsBusinessImportedNumbers } from '../../hooks/useMtsBusinessData';
import type { IMtsBusinessImportedNumberRow } from '../../services/mtsBusinessService';
import styles from './NumberFioPicker.module.css';

interface IDropdownPos {
  top: number;
  left: number;
  width: number;
}

interface IProps {
  accountId: string;
  value: string[];
  onChange: (msisdns: string[]) => void;
  disabled?: boolean;
}

const norm = (s: string): string => s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
const rowFio = (r: IMtsBusinessImportedNumberRow): string | null => r.employeeFullName ?? r.mtsFio ?? null;
const chipLabel = (r: IMtsBusinessImportedNumberRow | undefined, msisdn: string): string =>
  (r && rowFio(r)) ?? msisdn;

/**
 * Мультивыбор номеров по ФИО для синхронной детализации. Источник — уже
 * импортированные номера (getImportedNumbers) с привязкой к ЛС; фильтруется по
 * выбранному accountId. Dropdown рендерится через portal в document.body, чтобы
 * не обрезался overflow родительской секции.
 */
export const NumberFioPicker: FC<IProps> = ({ accountId, value, onChange, disabled = false }) => {
  const imported = useMtsBusinessImportedNumbers(true);
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<IDropdownPos | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimerRef = useRef<number | null>(null);

  // Номера выбранного ЛС (или все, если ЛС не выбран). Только строки с номером.
  const accountRows = useMemo(() => {
    const rows = imported.data ?? [];
    return rows.filter(r => r.msisdn != null && (!accountId || r.accountId === accountId));
  }, [imported.data, accountId]);

  const byMsisdn = useMemo(() => {
    const map = new Map<string, IMtsBusinessImportedNumberRow>();
    for (const r of accountRows) if (r.msisdn) map.set(r.msisdn, r);
    return map;
  }, [accountRows]);

  const filtered = useMemo(() => {
    const q = norm(query);
    if (!q) return accountRows;
    return accountRows.filter(r => {
      const hay = norm(`${rowFio(r) ?? ''} ${r.msisdn ?? ''}`);
      return hay.includes(q);
    });
  }, [accountRows, query]);

  const recompute = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 260) });
  }, []);

  useEffect(() => {
    if (!open) return;
    const on = (): void => recompute();
    window.addEventListener('scroll', on, true);
    window.addEventListener('resize', on);
    return () => {
      window.removeEventListener('scroll', on, true);
      window.removeEventListener('resize', on);
    };
  }, [open, recompute]);

  useEffect(() => () => {
    if (blurTimerRef.current != null) window.clearTimeout(blurTimerRef.current);
  }, []);

  const toggle = (msisdn: string): void => {
    onChange(value.includes(msisdn) ? value.filter(m => m !== msisdn) : [...value, msisdn]);
  };

  const showDropdown = open && pos != null;

  return (
    <span className={styles.picker}>
      {value.length > 0 && (
        <div className={styles.chips}>
          {value.map(m => (
            <span key={m} className={styles.chip}>
              {chipLabel(byMsisdn.get(m), m)}
              <button
                type="button"
                className={styles.chipRemove}
                disabled={disabled}
                onClick={() => toggle(m)}
                aria-label="Убрать"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}
      <input
        ref={inputRef}
        className={styles.input}
        type="text"
        placeholder={accountRows.length ? 'Поиск по ФИО или номеру…' : 'Нет номеров для этого ЛС'}
        value={query}
        disabled={disabled || accountRows.length === 0}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => { setOpen(true); recompute(); }}
        onBlur={() => { blurTimerRef.current = window.setTimeout(() => setOpen(false), 200); }}
      />
      {showDropdown && createPortal(
        <div
          className={styles.dropdown}
          style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
          onMouseDown={e => e.preventDefault()}
        >
          {imported.isLoading && <div className={styles.hint}>Загрузка…</div>}
          {!imported.isLoading && filtered.length === 0 && (
            <div className={styles.hint}>Не найдено</div>
          )}
          {!imported.isLoading && filtered.map(r => {
            const m = r.msisdn as string;
            const checked = value.includes(m);
            return (
              <div
                key={m}
                className={`${styles.item} ${checked ? styles.itemChecked : ''}`}
                onMouseDown={() => toggle(m)}
              >
                <span className={styles.check}>{checked ? '✓' : ''}</span>
                <span className={styles.itemFio}>{rowFio(r) ?? 'без ФИО'}</span>
                <span className={styles.itemNum}>{m}</span>
              </div>
            );
          })}
        </div>,
        document.body,
      )}
    </span>
  );
};
