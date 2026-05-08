import { useState, useEffect, useMemo, useRef, useCallback, memo, type FC } from 'react';
import { AlertTriangle, ChevronDown } from 'lucide-react';
import type { IFlatDepartmentOption } from '../../utils/departmentUtils';

interface IDeptSelectProps {
  departments: IFlatDepartmentOption[];
  value: string;
  onChange: (id: string) => void;
  isLoading?: boolean;
  isError?: boolean;
  onRetry?: () => void;
}

export const DeptSelect: FC<IDeptSelectProps> = memo(({ departments, value, onChange, isLoading = false, isError = false, onRetry }) => {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const selected = useMemo(() => departments.find(d => d.id === value), [departments, value]);

  const filtered = useMemo(() => {
    if (!q) return departments;
    const qLower = q.toLowerCase();
    return departments.filter(d => d.name.toLowerCase().includes(qLower));
  }, [departments, q]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
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
    setOpen(prev => !prev);
    setQ('');
  }, []);

  const showStaleBadge = isError && departments.length > 0;
  const showLoadingState = isLoading && departments.length === 0;
  const showErrorState = isError && departments.length === 0;

  return (
    <div className="sc-dept-select" ref={ref}>
      <button className="sc-dept-trigger" onClick={toggle}>
        <span className="sc-dept-trigger-text">{selected ? selected.name : 'Все отделы'}</span>
        {showStaleBadge && (
          <AlertTriangle size={12} aria-label="Данные могут быть устаревшими" />
        )}
        <ChevronDown size={14} />
      </button>
      {open && (
        <div className="sc-dept-dropdown">
          <input
            className="sc-dept-search"
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Поиск отдела..."
            autoFocus
          />
          <div className="sc-dept-list">
            {showStaleBadge && (
              <div className="sc-dept-stale-banner">
                Показаны последние данные.
                {onRetry && (
                  <button type="button" className="sc-dept-retry" onClick={onRetry}>
                    Обновить
                  </button>
                )}
              </div>
            )}
            <div className={`sc-dept-option ${!value ? 'active' : ''}`} onClick={() => pick('')}>
              Все отделы
            </div>
            {filtered.map(d => (
              d.hasChildren ? (
                <div key={d.id} className="sc-dept-option sc-dept-option--header">
                  {d.name}
                </div>
              ) : (
                <div
                  key={d.id}
                  className={`sc-dept-option ${d.id === value ? 'active' : ''}`}
                  style={{ paddingLeft: `${12 + d.level * 12}px` }}
                  onClick={() => pick(d.id)}
                >
                  {d.name}
                </div>
              )
            ))}
            {showLoadingState && <div className="sc-dept-empty">Загрузка отделов...</div>}
            {showErrorState && (
              <div className="sc-dept-empty">
                Не удалось загрузить.
                {onRetry && (
                  <button type="button" className="sc-dept-retry" onClick={onRetry}>
                    Повторить
                  </button>
                )}
              </div>
            )}
            {!showLoadingState && !showErrorState && filtered.length === 0 && (
              <div className="sc-dept-empty">Не найдено</div>
            )}
          </div>
        </div>
      )}
    </div>
  );
});
