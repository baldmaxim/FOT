import { type FC, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { adminService } from '../../services/adminService';
import styles from './MtsPage.module.css';

interface IEmployeeResult {
  id: number;
  full_name: string;
  org_department_id: string | null;
}

interface IDropdownPos {
  top: number;
  left: number;
  width: number;
}

interface IProps {
  onSelect: (id: number, fullName: string) => void;
  disabled?: boolean;
  placeholder?: string;
}

/**
 * Инпут с автокомплитом сотрудников по ФИО. Запрашивает /admin/employees/search
 * с дебаунсом 250мс, минимум 2 символа. Dropdown рендерится через portal в
 * document.body — иначе обрезается overflow-x:auto на .tableWrap.
 */
export const EmployeeFioPicker: FC<IProps> = ({ onSelect, disabled = false, placeholder = 'Поиск по ФИО…' }) => {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<IEmployeeResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<IDropdownPos | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const blurTimerRef = useRef<number | null>(null);

  const recompute = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setPos({ top: rect.bottom + 4, left: rect.left, width: Math.max(rect.width, 240) });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onScroll = (): void => recompute();
    const onResize = (): void => recompute();
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onResize);
    };
  }, [open, recompute]);

  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const t = window.setTimeout(async () => {
      try {
        const data = await adminService.searchAllEmployees(q);
        setResults(data);
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);
    return () => window.clearTimeout(t);
  }, [query]);

  useEffect(() => () => {
    if (blurTimerRef.current != null) window.clearTimeout(blurTimerRef.current);
  }, []);

  const handleSelect = (emp: IEmployeeResult): void => {
    onSelect(emp.id, emp.full_name);
    setQuery('');
    setResults([]);
    setOpen(false);
  };

  const showDropdown = open && pos != null && query.trim().length >= 2 && (results.length > 0 || loading);

  return (
    <span className={styles.fioPicker}>
      <input
        ref={inputRef}
        className={styles.fioPickerInput}
        type="text"
        placeholder={placeholder}
        value={query}
        disabled={disabled}
        onChange={e => setQuery(e.target.value)}
        onFocus={() => {
          setOpen(true);
          recompute();
        }}
        onBlur={() => {
          blurTimerRef.current = window.setTimeout(() => setOpen(false), 200);
        }}
      />
      {showDropdown && createPortal(
        <div
          className={styles.fioPickerDropdown}
          style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
          onMouseDown={e => e.preventDefault()}
        >
          {loading && <div className={styles.fioPickerHint}>Поиск…</div>}
          {!loading && results.length === 0 && (
            <div className={styles.fioPickerHint}>Не найдено</div>
          )}
          {!loading && results.map(emp => (
            <div
              key={emp.id}
              className={styles.fioPickerItem}
              onMouseDown={() => handleSelect(emp)}
            >
              {emp.full_name}
            </div>
          ))}
        </div>,
        document.body,
      )}
    </span>
  );
};
