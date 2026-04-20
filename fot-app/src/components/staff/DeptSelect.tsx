import { useState, useEffect, useMemo, useRef, useCallback, memo, type FC } from 'react';
import { ChevronDown } from 'lucide-react';
import type { IFlatDepartmentOption } from '../../utils/departmentUtils';

interface IDeptSelectProps {
  departments: IFlatDepartmentOption[];
  value: string;
  onChange: (id: string) => void;
}

export const DeptSelect: FC<IDeptSelectProps> = memo(({ departments, value, onChange }) => {
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

  return (
    <div className="sc-dept-select" ref={ref}>
      <button className="sc-dept-trigger" onClick={toggle}>
        <span className="sc-dept-trigger-text">{selected ? selected.name : 'Все отделы'}</span>
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
            {filtered.length === 0 && <div className="sc-dept-empty">Не найдено</div>}
          </div>
        </div>
      )}
    </div>
  );
});
