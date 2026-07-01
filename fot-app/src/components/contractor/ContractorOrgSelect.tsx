import { useState, useEffect, useMemo, useRef, useCallback, type FC } from 'react';
import { ChevronDown } from 'lucide-react';
import type { IContractorOrg } from '../../services/contractorService';
import styles from './ContractorOrgSelect.module.css';

interface IContractorOrgSelectProps {
  orgs: IContractorOrg[];
  value: string;
  onChange: (id: string) => void;
  /** Подпись пустого варианта (он же — текст триггера, когда ничего не выбрано). */
  emptyOptionLabel?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  loading?: boolean;
  /** Кол-во по org (id → N): показывается как «Название (N)» в триггере и опциях. */
  counts?: Map<string, number>;
}

/**
 * Поисковый combobox для выбора подрядной организации. Замена нативного
 * <select> там, где список организаций большой (сотни записей).
 */
export const ContractorOrgSelect: FC<IContractorOrgSelectProps> = ({
  orgs,
  value,
  onChange,
  emptyOptionLabel = '— не выбрано —',
  searchPlaceholder = 'Поиск организации…',
  disabled = false,
  loading = false,
  counts,
}) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => orgs.find(o => o.id === value), [orgs, value]);

  const orgLabel = useCallback(
    (o: IContractorOrg): string => (counts?.has(o.id) ? `${o.name} (${counts.get(o.id)})` : o.name),
    [counts],
  );

  const filtered = useMemo(() => {
    if (!q.trim()) return orgs;
    const qLower = q.trim().toLowerCase();
    return orgs.filter(o => o.name.toLowerCase().includes(qLower));
  }, [orgs, q]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const pick = useCallback((id: string) => {
    onChange(id);
    setOpen(false);
    setQ('');
  }, [onChange]);

  const toggle = useCallback(() => {
    if (disabled) return;
    setOpen(prev => !prev);
    setQ('');
  }, [disabled]);

  return (
    <div className={styles.select} ref={ref}>
      <button
        type="button"
        className={styles.trigger}
        onClick={toggle}
        disabled={disabled}
      >
        <span className={styles.triggerText}>
          {selected ? orgLabel(selected) : emptyOptionLabel}
        </span>
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className={styles.dropdown}>
          <input
            className={styles.search}
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder={searchPlaceholder}
            autoFocus
          />
          <div className={styles.list}>
            <div
              className={`${styles.option} ${!value ? styles.optionActive : ''}`}
              onClick={() => pick('')}
            >
              {emptyOptionLabel}
            </div>
            {filtered.map(o => (
              <div
                key={o.id}
                className={`${styles.option} ${o.id === value ? styles.optionActive : ''}`}
                onClick={() => pick(o.id)}
              >
                {orgLabel(o)}
              </div>
            ))}
            {loading && orgs.length === 0 && (
              <div className={styles.empty}>Загрузка…</div>
            )}
            {!loading && filtered.length === 0 && (
              <div className={styles.empty}>Не найдено</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
